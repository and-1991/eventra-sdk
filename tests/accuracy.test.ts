import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra, type TrackerOptions } from "../src";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

// Tests written against surviving mutants of client.ts (`pnpm test:mutation`): each pins behaviour that decides
// whether an event reaches the server once, unchanged and under the same name as in the CLI catalog. A change
// that breaks one of them loses, duplicates or renames events without any other test noticing.

type SentEvent = { idempotencyKey: string; name: string; userId?: string; timestamp: string };
type Body = { events: SentEvent[]; diagnostics?: { byReason: Record<string, number> } };

let active: Eventra[] = [];

function recordingFetch(respond: (call: number) => Response | Promise<Response> = () => new Response(null, { status: 200 })) {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return respond(bodies.length);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

function makeSdk(extra: Partial<TrackerOptions> = {}, respond?: Parameters<typeof recordingFetch>[0]) {
  const { fetchImpl, bodies } = recordingFetch(respond);
  const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, ...extra });
  active.push(sdk);
  return { sdk, bodies, sent: () => bodies.flatMap((b) => b.events) };
}

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("event names keep the exact characters the CLI catalog holds", () => {
  async function sentName(name: string): Promise<string | undefined> {
    const { sdk, sent } = makeSdk();
    sdk.track(name);
    await sdk.flush();
    return sent()[0]?.name;
  }

  it("keeps characters above the surrogate range (fullwidth, private use)", async () => {
    expect(await sentName("ｱｲ")).toBe("ｱｲ");
    expect(await sentName("ab")).toBe("ab");
  });

  it("keeps whole pairs at both ends of the surrogate ranges", async () => {
    expect(await sentName("x𐀀y")).toBe("x𐀀y"); // U+10000
    expect(await sentName("x􏿿y")).toBe("x􏿿y"); // U+10FFFF
  });

  it("drops half a pair, wherever it stands", async () => {
    expect(await sentName("x\uD83Dy")).toBe("xy"); // high half before a plain letter
    expect(await sentName("x\uD83D")).toBe("x"); // high half before a non-surrogate above it
    expect(await sentName("a\uDFFFb")).toBe("ab"); // lone low half at the top of its range
    expect(await sentName("a\uDC00b")).toBe("ab"); // lone low half at the bottom of its range
  });

  it("cuts at 64 without splitting a pair, at either end of the high-surrogate range", async () => {
    const a63 = "a".repeat(63);
    expect(await sentName(`${a63}𐀀`)).toBe(a63);
    expect(await sentName(`${a63}􏰀`)).toBe(a63);
    // a character just above the surrogates at position 64 is kept whole
    expect(await sentName(`${a63}ＡＢ`)).toBe(`${a63}Ａ`);
  });

  it("cuts a user id at 120, keeping one that is exactly 120 long untouched", async () => {
    const { sdk, sent } = makeSdk();
    const exact = `${"u".repeat(119)}\uD83D`; // 120 code units, the last one half a pair
    sdk.track("a", { userId: exact });
    sdk.track("b", { userId: `${"u".repeat(119)}😀` }); // 121: the pair would be split, so 119
    await sdk.flush();
    expect(sent().map((e) => e.userId)).toEqual([exact, "u".repeat(119)]);
  });
});

describe("idempotency keys", () => {
  const keyOf = async () => {
    const { sdk, sent } = makeSdk();
    sdk.track("a");
    await sdk.flush();
    return sent()[0].idempotencyKey;
  };

  it("come from crypto.randomUUID when it exists", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555" });
    expect(await keyOf()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("are built from getRandomValues as a v4 UUID, every byte as two hex digits", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0x05),
    });
    expect(await keyOf()).toBe("05050505-0505-4505-8505-050505050505");
  });

  it("fall back to Math.random mixed with the time, still shaped as a v4 UUID", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.5); // every byte 0x80
    vi.spyOn(Date, "now").mockReturnValue(0x010203040506);
    // the six low bytes of the time, lowest first, are XORed into the first six bytes
    expect(await keyOf()).toBe("86858483-8281-4080-8080-808080808080");
  });
});

describe("payload size is counted in UTF-8 bytes", () => {
  // a name of 60 three-byte characters: 60 characters, 180 bytes
  const NAME = "日".repeat(60);

  async function bodySize(): Promise<{ chars: number; bytes: number }> {
    const { fetchImpl, bodies } = recordingFetch();
    const probe = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, diagnostics: false });
    active.push(probe);
    probe.track(NAME);
    await probe.flush();
    const json = JSON.stringify(bodies[0]);
    return { chars: json.length, bytes: Buffer.byteLength(json, "utf8") };
  }

  async function refusedAsTooLarge(limit: number): Promise<boolean> {
    const onDeliveryFailed = vi.fn();
    const { sdk } = makeSdk({ maxPayloadBytes: limit, diagnostics: false, onDeliveryFailed });
    sdk.track(NAME);
    await sdk.flush();
    return onDeliveryFailed.mock.calls.some(([info]) => info.status === 413);
  }

  it("with TextEncoder, and with Buffer where there is none", async () => {
    const { chars, bytes } = await bodySize();
    const between = Math.floor((chars + bytes) / 2);
    expect(await refusedAsTooLarge(between)).toBe(true);
    expect(await refusedAsTooLarge(bytes + 50)).toBe(false);

    vi.stubGlobal("TextEncoder", undefined);
    expect(await refusedAsTooLarge(between)).toBe(true);
  });

  it("falls back to counting characters only where neither exists", async () => {
    const { chars, bytes } = await bodySize();
    vi.stubGlobal("TextEncoder", undefined);
    vi.stubGlobal("Buffer", undefined);
    expect(await refusedAsTooLarge(Math.floor((chars + bytes) / 2))).toBe(false);
  });
});

describe("a saved queue is read back only when each event is well formed", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => env.restore());

  const event = (key: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: key,
    name: "e",
    timestamp: new Date().toISOString(),
    ...extra,
  });

  it("keeps the events at every limit and drops the ones past it", async () => {
    env.storage.setItem(
      "__eventra_q__ee0c38ea",
      JSON.stringify([
        "not an event",
        null,
        event("k".repeat(100)),
        event("k".repeat(101)),
        event("name-64", { name: "n".repeat(64) }),
        event("name-65", { name: "n".repeat(65) }),
        event("name-empty", { name: "" }),
        event("name-number", { name: 5 }),
        event("user-120", { userId: "u".repeat(120) }),
        event("user-121", { userId: "u".repeat(121) }),
        event("user-number", { userId: 5 }),
        event("props-object", { properties: { a: 1 } }),
        event("props-null", { properties: null }),
        event("props-array", { properties: [1] }),
        event("props-string", { properties: "x" }),
        event("no-timestamp", { timestamp: undefined }),
      ]),
    );
    const { sdk, sent } = makeSdk();
    await sdk.flush();
    expect(sent().map((e) => e.idempotencyKey)).toEqual(["k".repeat(100), "name-64", "user-120", "props-object"]);
  });
});

describe("Retry-After", () => {
  async function delayAfter(header: string): Promise<number> {
    const { sdk } = makeSdk({ maxRetries: 1 }, () => new Response(null, { status: 429, headers: { "retry-after": header } }));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    sdk.track("a");
    await sdk.flush();
    const nextFlushAt = (sdk as unknown as { nextFlushAt: number }).nextFlushAt;
    return nextFlushAt === 0 ? 0 : nextFlushAt - now;
  }

  it("reads seconds, also with spaces around them, and caps them at 30 s", async () => {
    expect(await delayAfter("5")).toBe(5000);
    expect(await delayAfter(" 5 ")).toBe(5000);
    expect(await delayAfter("120")).toBe(30_000);
  });

  it("reads an HTTP date in the future", async () => {
    const at = new Date(Date.now() + 10_000);
    at.setUTCMilliseconds(0);
    const delay = await delayAfter(at.toUTCString());
    expect(delay).toBeGreaterThan(8000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it("ignores zero, a past date and anything that is not seconds or a date", async () => {
    expect(await delayAfter("0")).toBe(0);
    expect(await delayAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    expect(await delayAfter("5x")).toBe(0);
    expect(await delayAfter("soon")).toBe(0);
  });

  it("holds back a flush that a full batch would start", async () => {
    const { sdk, bodies } = makeSdk({ maxRetries: 1, maxBatchSize: 2 }, (n) =>
      n === 1 ? new Response(null, { status: 429, headers: { "retry-after": "5" } }) : new Response(null, { status: 200 }),
    );
    sdk.track("a");
    await sdk.flush();
    expect(bodies).toHaveLength(1);
    sdk.track("b"); // the batch is full: this would send at once without the wait
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(bodies).toHaveLength(1);
  });

  it("holds back the immediate flush of a serverless function too", async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
    try {
      const { sdk, bodies } = makeSdk({ maxRetries: 1 }, (n) =>
        n === 1 ? new Response(null, { status: 429, headers: { "retry-after": "5" } }) : new Response(null, { status: 200 }),
      );
      sdk.track("a");
      await sdk.flush();
      const before = bodies.length;
      sdk.track("b");
      await new Promise((r) => setTimeout(r, 0));
      expect(bodies).toHaveLength(before);
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });
});

describe("shutdown", () => {
  it("ignores an event tracked while shutdown() is still flushing", async () => {
    const { sdk, sent } = makeSdk();
    sdk.track("before");
    const done = sdk.shutdown();
    sdk.track("late");
    await done;
    expect(sent().map((e) => e.name)).toEqual(["before"]);
  });
});

describe("open tabs never lose or double an event", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => env.restore());

  const channel = () => new (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel("eventra-sdk:ee0c38ea");
  const queueOf = (sdk: Eventra) => (sdk as unknown as { queue: SentEvent[] }).queue;

  it("keeps an event tracked during a send when another tab delivered part of that batch", async () => {
    let release!: () => void;
    const { sdk, sent } = makeSdk({}, (n) =>
      n === 1 ? new Promise<Response>((r) => (release = () => r(new Response(null, { status: 200 })))) : new Response(null, { status: 200 }),
    );
    sdk.track("e1");
    sdk.track("e2");
    const [, e2] = queueOf(sdk);
    const sending = sdk.flush();
    await new Promise((r) => setTimeout(r, 0));

    channel().postMessage({ type: "delivered", keys: [e2.idempotencyKey] }); // another tab sent e2 meanwhile
    sdk.track("e3");
    release();
    await sending; // the same flush goes on to send what is left

    expect(sent().map((e) => e.name)).toEqual(["e1", "e2", "e3"]);
    expect(queueOf(sdk)).toEqual([]);
  });

  it("tells the other tabs what it delivered, so they never send it again", async () => {
    const a = makeSdk({ persistQueue: false });
    const b = makeSdk({ persistQueue: false });
    a.sdk.track("shared");
    expect(queueOf(b.sdk).map((e) => e.name)).toEqual(["shared"]);
    await a.sdk.flush();
    expect(queueOf(b.sdk)).toEqual([]);
  });

  it("still takes a new event from another tab after it delivered events of its own", async () => {
    const a = makeSdk({ persistQueue: false });
    const b = makeSdk({ persistQueue: false });
    b.sdk.track("own");
    await b.sdk.flush();
    a.sdk.track("new");
    expect(queueOf(b.sdk).map((e) => e.name)).toEqual(["new"]);
  });

  it("drops the oldest events past maxQueueSize, keeps the newest, and reports why", async () => {
    const a = makeSdk({ persistQueue: false, maxQueueSize: 2 });
    a.sdk.track("a1");
    a.sdk.track("a2");
    const tab = channel();
    const remote = (key: string) => ({ idempotencyKey: key, name: key, timestamp: new Date().toISOString() });
    // an older SDK version announces a whole queue at once; three events for a limit of two
    tab.postMessage({ type: "queue-sync", events: [remote("b1")] });
    expect(queueOf(a.sdk).map((e) => e.name)).toEqual(["a2", "b1"]);
    await a.sdk.flush();
    expect(a.bodies[0].diagnostics?.byReason).toEqual({ queue_full: 1 });
  });

  it("leaves an announced event to its tab for the grace period, measured from the first announcement", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const { sdk } = makeSdk({ persistQueue: false });
    const leftToItsTab = (e: SentEvent) => (sdk as unknown as { leftToItsTab: (e: SentEvent) => boolean }).leftToItsTab(e);
    const ev = { idempotencyKey: "remote-1", name: "r", timestamp: new Date().toISOString() };
    const tab = channel();
    tab.postMessage({ type: "queue-add", events: [ev] });

    vi.setSystemTime(1_000_000 + 10_000);
    tab.postMessage({ type: "queue-add", events: [ev] }); // announced again: the grace does not start over

    vi.setSystemTime(1_000_000 + 15_000 - 1);
    expect(leftToItsTab(ev)).toBe(true);
    vi.setSystemTime(1_000_000 + 15_000); // exactly at the end of the grace: anyone may send it
    expect(leftToItsTab(ev)).toBe(false);
  });
});

describe("event properties", () => {
  async function accepted(properties: unknown): Promise<boolean> {
    const onEventsDropped = vi.fn();
    const { sdk, sent } = makeSdk({ onEventsDropped });
    sdk.track("e", { properties: properties as Record<string, unknown> });
    await sdk.flush();
    return sent().length === 1 && onEventsDropped.mock.calls.length === 0;
  }

  const nested = (levels: number) => {
    let value: unknown = 1;
    for (let i = 0; i < levels; i++) value = { a: value };
    return value;
  };

  it("accepts 8 levels of nested objects and refuses 9", async () => {
    expect(await accepted(nested(8))).toBe(true);
    expect(await accepted(nested(9))).toBe(false);
  });

  it("accepts properties of exactly 32,000 bytes of JSON and refuses one more", async () => {
    // {"a":"..."} is 8 bytes around the value
    expect(await accepted({ a: "x".repeat(32_000 - 8) })).toBe(true);
    expect(await accepted({ a: "x".repeat(32_000 - 7) })).toBe(false);
  });

  it("accepts null values inside the properties", async () => {
    expect(await accepted({ a: null, b: [null, { c: null }] })).toBe(true);
  });

  it("counts nested lists toward the depth limit like objects", async () => {
    const lists = (levels: number) => {
      let value: unknown = 1;
      for (let i = 0; i < levels; i++) value = [value];
      return value;
    };
    expect(await accepted({ a: lists(7) })).toBe(true);
    expect(await accepted({ a: lists(8) })).toBe(false);
  });

  it("refuses an object whose toJSON() gives something that is not an object", async () => {
    // sent as is, `properties: null` would make the server refuse the whole batch
    expect(await accepted({ toJSON: () => null })).toBe(false);
    expect(await accepted({ toJSON: () => [1] })).toBe(false);
    expect(await accepted({ toJSON: () => ({ ok: true }) })).toBe(true);
  });

  it("refuses values that are not a plain object", async () => {
    for (const value of [5, "x", [1], new Date(), new Map()]) {
      expect(await accepted(value)).toBe(false);
    }
  });
});

describe("what the server's answer does to a batch", () => {
  it("sends a POST", async () => {
    const { sdk } = makeSdk();
    const fetchImpl = (sdk as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    sdk.track("a");
    await sdk.flush();
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("retries a 500 within the same flush", async () => {
    const { sdk, sent } = makeSdk({ maxRetries: 2, retryBaseDelayMs: 0 }, (n) =>
      new Response(null, { status: n === 1 ? 500 : 200 }),
    );
    sdk.track("a");
    await sdk.flush();
    expect(sent().map((e) => e.name)).toEqual(["a", "a"]);
  });

  it("reports a batch that ended on a 500 as a server error, and keeps its events", async () => {
    const { sdk, sent, bodies } = makeSdk({ maxRetries: 1 }, (n) => new Response(null, { status: n === 1 ? 500 : 200 }));
    sdk.track("a");
    await sdk.flush();
    await sdk.flush();
    expect(sent().map((e) => e.name)).toEqual(["a", "a"]);
    expect(bodies[1].diagnostics?.byReason).toEqual({ server_error: 1 });
  });

  it("drops a batch the server refuses with a 4xx other than 400/422 at once, even when it carries diagnostics", async () => {
    const onDeliveryFailed = vi.fn();
    const { sdk, bodies } = makeSdk({ onDeliveryFailed }, () => new Response(null, { status: 403 }));
    sdk.track(""); // a dropped event: the next batch carries diagnostics
    sdk.track("a");
    await sdk.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].diagnostics).toBeDefined();
    // the callback gets the events themselves
    expect(onDeliveryFailed.mock.calls[0][0].events.map((e: SentEvent) => e.name)).toEqual(["a"]);
  });

  it("gives up a retry that would outlast the shutdown budget", async () => {
    const { sdk, bodies } = makeSdk({ maxRetries: 3, retryBaseDelayMs: 2000, shutdownTimeoutMs: 200 }, () =>
      new Response(null, { status: 503 }),
    );
    sdk.track("a");
    const started = Date.now();
    await sdk.shutdown();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(bodies).toHaveLength(1);
  });
});

describe("leaving the page", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => env.restore());

  async function keepaliveFor(name: string): Promise<boolean> {
    const { sdk } = makeSdk({ persistQueue: false, maxPayloadBytes: 200_000 });
    const fetchImpl = (sdk as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    sdk.track("x", { properties: { pad: name } });
    env.document.visibilityState = "hidden";
    await sdk.flush();
    env.document.visibilityState = "visible";
    return Boolean((fetchImpl.mock.calls[0][1] as RequestInit & { keepalive?: boolean }).keepalive);
  }

  it("sends with keepalive while hidden, but not a body over the 64 KiB browsers allow", async () => {
    expect(await keepaliveFor("small")).toBe(true);
    // properties are at most 32 KB, so a large body is two events' worth: build one past 60,000 bytes
    const { sdk } = makeSdk({ persistQueue: false, maxPayloadBytes: 200_000 });
    const fetchImpl = (sdk as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    for (let i = 0; i < 3; i++) sdk.track("x", { properties: { pad: "p".repeat(25_000) } });
    env.document.visibilityState = "hidden";
    await sdk.flush();
    expect((fetchImpl.mock.calls[0][1] as RequestInit & { keepalive?: boolean }).keepalive).toBe(false);
  });
});
