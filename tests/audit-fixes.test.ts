import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

let active: Eventra[] = [];
let env: BrowserEnvHandle | null = null;

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  env?.restore();
  env = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const QUEUE_KEY = "__eventra_q__";

function make(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof Eventra>[0]> = {},
) {
  const sdk = new Eventra({
    apiKey: "k",
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
    ...extra,
  });
  active.push(sdk);
  return sdk;
}

// fetch double that can also return headers (Retry-After)
function headerFetch(
  responses: Array<{ status: number; headers?: Record<string, string> }>,
) {
  const calls: Array<{ at: number; body: string }> = [];
  let cursor = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({ at: Date.now(), body: String(init?.body) });
    const r = responses[Math.min(cursor++, responses.length - 1)];
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("browser queue persistence (coalesced)", () => {
  beforeEach(() => {
    env = installBrowserEnv();
  });

  it("writes localStorage once for a burst of track() calls", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const setSpy = vi.spyOn(env!.storage, "setItem");
    const sdk = make(fetchImpl, { maxBatchSize: 1000 });

    for (let i = 0; i < 500; i++) sdk.track(`evt.${i % 5}`);

    const queueWrites = () => setSpy.mock.calls.filter((c) => c[0] === QUEUE_KEY).length;
    expect(queueWrites()).toBe(0); // nothing written synchronously
    await vi.waitFor(() => expect(queueWrites()).toBe(1));
    expect(JSON.parse(env!.storage.getItem(QUEUE_KEY) as string)).toHaveLength(500);
  });

  it("writes immediately on pagehide and when the tab becomes hidden", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);

    sdk.track("a");
    expect(env!.storage.getItem(QUEUE_KEY)).toBeNull();
    env!.window.dispatch("pagehide", {});
    expect(JSON.parse(env!.storage.getItem(QUEUE_KEY) as string)).toHaveLength(1);

    sdk.track("b");
    env!.document.visibilityState = "hidden";
    env!.document.dispatch("visibilitychange", {});
    expect(JSON.parse(env!.storage.getItem(QUEUE_KEY) as string)).toHaveLength(2);
  });

  it("writes pending events on destroy() and shutdown()", async () => {
    const { fetchImpl } = createMockFetch({ responses: [500] });
    const sdk = make(fetchImpl, { maxRetries: 1 });
    sdk.track("kept");
    await sdk.shutdown(); // delivery fails, event must survive in storage
    expect(JSON.parse(env!.storage.getItem(QUEUE_KEY) as string)).toHaveLength(1);
  });

  it("does not bring delivered events back into the queue (and does not resend them)", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);

    sdk.track("once");
    await sdk.flush();
    await sdk.flush();
    await sdk.flush();
    expect(calls).toHaveLength(1);

    env!.window.dispatch("pagehide", {});
    expect(JSON.parse(env!.storage.getItem(QUEUE_KEY) as string)).toEqual([]);
  });

  it("keeps delivered events out even if a stale copy is still in localStorage", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);

    sdk.track("once");
    const stale = JSON.stringify(
      (sdk as unknown as { queue: unknown[] }).queue,
    );
    await sdk.flush();

    env!.storage.setItem(QUEUE_KEY, stale); // another tab wrote the old queue back
    env!.window.dispatch("storage", { key: QUEUE_KEY });
    await sdk.flush();
    expect(calls).toHaveLength(1);
  });

  it("broadcasts only the new event, not the whole queue", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl, { maxBatchSize: 1000 });
    const channel = (sdk as unknown as { channel: { postMessage: (m: unknown) => void } })
      .channel;
    const post = vi.spyOn(channel, "postMessage");

    for (let i = 0; i < 100; i++) sdk.track(`e.${i}`);

    expect(post).toHaveBeenCalledTimes(100);
    for (const [message] of post.mock.calls) {
      const m = message as { type: string; events: unknown[] };
      expect(m.type).toBe("queue-add");
      expect(m.events).toHaveLength(1);
    }
  });

  it("a sibling's queue-add is merged and its 'delivered' message removes the events", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);
    const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel })
      .BroadcastChannel;
    const sibling = new Channel("eventra-sdk");
    const event = {
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      name: "remote",
      properties: {},
      timestamp: new Date().toISOString(),
    };

    sibling.postMessage({ type: "queue-add", events: [event] });
    sibling.postMessage({ type: "queue-add", events: [event] }); // duplicate
    expect((sdk as unknown as { queue: unknown[] }).queue).toHaveLength(1);

    sibling.postMessage({ type: "delivered", keys: [event.idempotencyKey] });
    expect((sdk as unknown as { queue: unknown[] }).queue).toHaveLength(0);

    // late re-delivery of the same event from the other tab stays out
    sibling.postMessage({ type: "queue-sync", events: [event] });
    await sdk.flush();
    expect(calls).toHaveLength(0);
  });

  it("merges events another tab wrote to localStorage when persisting, never overwriting them", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);

    sdk.track("mine");
    env!.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        {
          idempotencyKey: "44444444-4444-4444-8444-444444444444",
          name: "theirs",
          properties: {},
          timestamp: new Date().toISOString(),
        },
      ]),
    );
    env!.window.dispatch("pagehide", {});

    const names = JSON.parse(env!.storage.getItem(QUEUE_KEY) as string).map(
      (e: { name: string }) => e.name,
    );
    expect(names.sort()).toEqual(["mine", "theirs"]);
  });
});

describe("delivered-key memory", () => {
  it("is bounded and forgets the oldest keys first", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);
    const internals = sdk as unknown as {
      rememberDelivered: (keys: Iterable<string>) => void;
      deliveredKeys: Set<string>;
    };

    internals.rememberDelivered(Array.from({ length: 10_005 }, (_, i) => `k${i}`));

    expect(internals.deliveredKeys.size).toBe(10_000);
    expect(internals.deliveredKeys.has("k0")).toBe(false);
    expect(internals.deliveredKeys.has("k4")).toBe(false);
    expect(internals.deliveredKeys.has("k5")).toBe(true);
    expect(internals.deliveredKeys.has("k10004")).toBe(true);
  });
});

describe("process exit and timers (node)", () => {
  it("the flush timer does not keep the process alive", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      autoFlushOnExit: false,
      fetchImpl,
      flushInterval: 10_000,
    });
    active.push(sdk);
    const timer = (sdk as unknown as { timer: { hasRef: () => boolean } }).timer;
    expect(timer.hasRef()).toBe(false);
  });

  it("re-raises the signal after flushing when nothing else listens", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl, exitOnSignal: true });
    active.push(sdk);

    const sigterm = onceSpy.mock.calls.find((c) => c[0] === "SIGTERM")![1] as () => void;
    sdk.track("bye");
    sigterm();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
    expect(calls).toHaveLength(1);
  });

  it("by default flushes on a signal and never re-raises it (the app owns its shutdown)", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl });
    active.push(sdk);

    const sigterm = onceSpy.mock.calls.find((c) => c[0] === "SIGTERM")![1] as () => void;
    sdk.track("bye");
    sigterm();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // even with the SDK's own once-handler consumed and the app's gone, the
    // SDK must not kill the process mid-shutdown
    await new Promise((r) => setTimeout(r, 50));
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill the process when the app has its own signal handler", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const appHandler = () => undefined;
    process.on("SIGINT", appHandler); // the app has its own handler
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl, exitOnSignal: true });
    active.push(sdk);

    const sigint = onceSpy.mock.calls.find((c) => c[0] === "SIGINT")![1] as () => void;
    sdk.track("bye");
    sigint();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    process.off("SIGINT", appHandler);
    expect(kill).not.toHaveBeenCalled();
  });

  it("flushes what is still queued on beforeExit", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl });
    active.push(sdk);

    const beforeExit = onceSpy.mock.calls.find((c) => c[0] === "beforeExit")![1] as () => void;
    sdk.track("last");
    beforeExit();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("beforeExit with nothing queued does not send anything", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl });
    active.push(sdk);

    const beforeExit = onceSpy.mock.calls.find((c) => c[0] === "beforeExit")![1] as () => void;
    beforeExit();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it("works with a minimal process shim (no kill, no listenerCount)", async () => {
    const original = globalThis.process;
    const handlers: Record<string, () => void> = {};
    (globalThis as { process?: unknown }).process = {
      env: {},
      versions: { node: "22.0.0" },
      on: () => undefined,
      once: (event: string, fn: () => void) => {
        handlers[event] = fn;
      },
      off: undefined,
    };
    try {
      const { fetchImpl, calls } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({ apiKey: "k", disableTimer: true, fetchImpl });
      active.push(sdk);

      sdk.track("bye");
      handlers.SIGTERM();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20)); // finally-block ran without throwing
    } finally {
      (globalThis as { process?: unknown }).process = original;
    }
  });

  it("shutdown() waits for a flush already in flight and then sends what is left", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: string[][] = [];
    let first = true;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)).events.map((e: { name: string }) => e.name));
      if (first) {
        first = false;
        await gate;
      }
      return { status: 200, ok: true } as unknown as Response;
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl, { maxBatchSize: 1 });

    sdk.track("one"); // maxBatchSize 1 starts a flush, held at the gate
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // events tracked while the flush is running are queued behind it
    (sdk as unknown as { queue: unknown[] }).queue.push({
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      name: "two",
      properties: {},
      timestamp: new Date().toISOString(),
    });

    const done = sdk.shutdown();
    release();
    await done;

    expect(bodies.flat().sort()).toEqual(["one", "two"]);
  });
});

describe("batch building", () => {
  it("serializes each event once and keeps the envelope shape", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return { status: 200, ok: true } as unknown as Response;
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl);

    sdk.track("a", { userId: "u1", properties: { n: 1, s: "é😀" } });
    sdk.track("b");
    await sdk.flush();

    const parsed = JSON.parse(bodies[0]);
    expect(Object.keys(parsed)).toEqual(["sentAt", "sdk", "events"]);
    expect(parsed.events.map((e: { name: string }) => e.name)).toEqual(["a", "b"]);
    expect(parsed.events[0].properties).toEqual({ n: 1, s: "é😀" });
  });

  it("the size estimate equals the real payload size, so the cap is exact", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return { status: 200, ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    // measure the real size of a two-event payload
    const probe = make(fetchImpl);
    probe.track("x".repeat(10), { properties: { k: "é".repeat(20) } });
    probe.track("y".repeat(10), { properties: { k: "😀".repeat(5) } });
    await probe.flush();
    const exact = Buffer.byteLength(bodies[0], "utf8");
    bodies.length = 0;

    // a cap of exactly that size still fits both events in one request...
    const fits = make(fetchImpl, { maxPayloadBytes: exact });
    fits.track("x".repeat(10), { properties: { k: "é".repeat(20) } });
    fits.track("y".repeat(10), { properties: { k: "😀".repeat(5) } });
    await fits.flush();
    expect(bodies).toHaveLength(1);
    expect(Buffer.byteLength(bodies[0], "utf8")).toBeLessThanOrEqual(exact);
    bodies.length = 0;

    // ...and one byte less splits them
    const splits = make(fetchImpl, { maxPayloadBytes: exact - 1 });
    splits.track("x".repeat(10), { properties: { k: "é".repeat(20) } });
    splits.track("y".repeat(10), { properties: { k: "😀".repeat(5) } });
    await splits.flush();
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(Buffer.byteLength(b, "utf8")).toBeLessThanOrEqual(exact - 1);
    }
  });

  it("accepts events without properties and still rejects over-deep ones", async () => {
    const onEventsDropped = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl, { onEventsDropped });

    sdk.track("no.props");
    sdk.track("empty", { properties: {} });
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) deep = { d: deep };
    sdk.track("too.deep", { properties: deep });
    await sdk.flush();

    expect(calls[0].body.events.map((e) => e.name)).toEqual(["no.props", "empty"]);
    expect(onEventsDropped).toHaveBeenCalledWith(1);
  });
});

describe("retry timing and Retry-After", () => {
  it("the first retry waits about the base delay, not twice it", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([{ status: 500 }, { status: 200 }]);
    const sdk = make(fetchImpl, { maxRetries: 2, retryBaseDelayMs: 1000 });

    sdk.track("a");
    const flush = sdk.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(499); // jitter is 50-100% of the base
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(501); // 1000ms at most
    expect(calls).toHaveLength(2);
    await flush;
  });

  it("honours Retry-After (seconds) on 429", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([
      { status: 429, headers: { "retry-after": "5" } },
      { status: 200 },
    ]);
    const sdk = make(fetchImpl, { maxRetries: 2, retryBaseDelayMs: 10 });

    sdk.track("a");
    const flush = sdk.flush();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    await flush;
  });

  it("honours Retry-After given as an HTTP date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { fetchImpl, calls } = headerFetch([
      { status: 429, headers: { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" } },
      { status: 200 },
    ]);
    const sdk = make(fetchImpl, { maxRetries: 2, retryBaseDelayMs: 10 });

    sdk.track("a");
    const flush = sdk.flush();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    await flush;
  });

  it("ignores a zero or already-passed Retry-After and uses the normal backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    for (const value of ["0", "Thu, 01 Jan 2026 00:00:01 GMT"]) {
      const { fetchImpl, calls } = headerFetch([
        { status: 429, headers: { "retry-after": value } },
        { status: 200 },
      ]);
      const sdk = make(fetchImpl, { maxRetries: 2, retryBaseDelayMs: 10 });
      sdk.track("a");
      const flush = sdk.flush();
      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toHaveLength(2);
      await flush;
    }
  });

  it("caps an absurd Retry-After and ignores a garbage one", async () => {
    vi.useFakeTimers();
    const capped = headerFetch([
      { status: 429, headers: { "retry-after": "999999" } },
      { status: 200 },
    ]);
    const a = make(capped.fetchImpl, { maxRetries: 2, retryBaseDelayMs: 10 });
    a.track("a");
    const flushA = a.flush();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(capped.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(capped.calls).toHaveLength(2); // waited 30s, not 999999s
    await flushA;

    const garbage = headerFetch([
      { status: 429, headers: { "retry-after": "soon" } },
      { status: 200 },
    ]);
    const b = make(garbage.fetchImpl, { maxRetries: 2, retryBaseDelayMs: 10 });
    b.track("b");
    const flushB = b.flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(garbage.calls).toHaveLength(2);
    await flushB;
  });
});

describe("circuit breaker recovery", () => {
  async function openCircuit(sdk: Eventra) {
    for (let i = 0; i < 5; i++) {
      sdk.track(`e${i}`);
      await sdk.flush();
    }
  }

  it("a half-open breaker sends a single probe request, without retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetchImpl, calls } = createMockFetch({ responses: Array(100).fill(503) });
    const sdk = make(fetchImpl, { maxRetries: 3, retryBaseDelayMs: 1 });

    // 5 failed flushes of 3 attempts each open the circuit
    await openCircuit(sdk);
    expect(calls).toHaveLength(15);

    vi.setSystemTime(Date.now() + 5_100);
    await sdk.flush();
    expect(calls).toHaveLength(16); // one probe, not three attempts
  });

  it("the cooldown doubles after a failed probe and is capped at 60s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetchImpl, calls } = createMockFetch({ responses: Array(100).fill(503) });
    const sdk = make(fetchImpl, { maxRetries: 1, retryBaseDelayMs: 1 });

    await openCircuit(sdk); // first opening: 5s
    expect(calls).toHaveLength(5);

    vi.setSystemTime(Date.now() + 5_100);
    await sdk.flush(); // probe fails: next cooldown is 10s
    expect(calls).toHaveLength(6);

    vi.setSystemTime(Date.now() + 6_000);
    await sdk.flush(); // still cooling down
    expect(calls).toHaveLength(6);

    vi.setSystemTime(Date.now() + 4_100);
    await sdk.flush(); // probe, fails: next cooldown is 20s
    expect(calls).toHaveLength(7);

    // keep failing probes until the cap
    for (const wait of [20_100, 40_100, 60_100, 60_100]) {
      vi.setSystemTime(Date.now() + wait);
      await sdk.flush();
    }
    expect(calls).toHaveLength(11);

    vi.setSystemTime(Date.now() + 59_000);
    await sdk.flush();
    expect(calls).toHaveLength(11); // capped at 60s, not 80s or more
    vi.setSystemTime(Date.now() + 1_200);
    await sdk.flush();
    expect(calls).toHaveLength(12);
  });

  it("a success resets the cooldown back to the base", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fetchImpl, calls } = createMockFetch({
      responses: [503, 503, 503, 503, 503, 503, 200, 503, 503, 503, 503, 503],
    });
    const sdk = make(fetchImpl, { maxRetries: 1, retryBaseDelayMs: 1 });

    await openCircuit(sdk);
    vi.setSystemTime(Date.now() + 5_100);
    await sdk.flush(); // failed probe (6th call), cooldown now 10s
    vi.setSystemTime(Date.now() + 10_100);
    await sdk.flush(); // probe succeeds (7th call)
    expect(calls).toHaveLength(7);

    for (let i = 0; i < 5; i++) {
      sdk.track(`again.${i}`);
      await sdk.flush();
    }
    expect(calls).toHaveLength(12);
    vi.setSystemTime(Date.now() + 5_100); // base cooldown again, not 20s
    await sdk.flush();
    expect(calls).toHaveLength(13);
  });
});
