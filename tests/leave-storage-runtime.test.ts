import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUEUE_KEY = "__eventra_q__ee0c38ea";

type Sent = { keepalive: boolean; names: string[]; bytes: number };

/** Normal requests hang until released (like one the browser cancels on unload); keepalive ones answer 200. */
function hangingFetch() {
  const sent: Sent[] = [];
  const pending: Array<() => void> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    sent.push({
      keepalive: !!init?.keepalive,
      names: JSON.parse(body).events.map((e: { name: string }) => e.name),
      bytes: new TextEncoder().encode(body).length,
    });
    if (!init?.keepalive) await new Promise<void>((r) => pending.push(r));
    return { status: 200, ok: true } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, release: () => pending.splice(0).forEach((r) => r()) };
}

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, ...extra } as never);
  active.push(sdk);
  return sdk;
}

describe("leaving the page while a request is in flight", () => {
  it("sends the queued events and the batch in flight with keepalive at once, without waiting for that request", async () => {
    env = installBrowserEnv();
    const { fetchImpl, sent, release } = hangingFetch();
    const sdk = make(fetchImpl);

    for (let i = 0; i < 50; i++) sdk.track(`a${i}`); // the 50th starts a flush that hangs
    expect(sent).toHaveLength(1);
    expect(sent[0].keepalive).toBe(false);
    for (let i = 0; i < 10; i++) sdk.track(`b${i}`);

    env.window.dispatch("pagehide", {});

    // started right away, inside the pagehide handler
    expect(sent).toHaveLength(2);
    expect(sent[1].keepalive).toBe(true);
    // the events not in flight first, then the batch in flight (the server drops copies by idempotencyKey)
    expect(sent[1].names).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `b${i}`),
      ...Array.from({ length: 50 }, (_, i) => `a${i}`),
    ]);

    // the keepalive reply was seen (the page stayed): nothing is left to send
    await vi.waitFor(() => expect((sdk as unknown as { queue: unknown[] }).queue).toHaveLength(0));
    release();
    await sdk.flush();
    expect(sent).toHaveLength(2);
  });

  it("keeps the keepalive request within the keepalive size limit, the events not in flight first", () => {
    env = installBrowserEnv();
    const { fetchImpl, sent } = hangingFetch();
    const sdk = make(fetchImpl, { maxBatchSize: 20 });
    const filler = "x".repeat(1500);

    for (let i = 0; i < 20; i++) sdk.track(`a${i}`, { properties: { filler } }); // in flight
    for (let i = 0; i < 30; i++) sdk.track(`b${i}`, { properties: { filler } });
    expect(sent).toHaveLength(1);

    env.window.dispatch("pagehide", {});

    expect(sent).toHaveLength(2);
    const leave = sent[1];
    expect(leave.keepalive).toBe(true);
    expect(leave.bytes).toBeLessThanOrEqual(60_000);
    expect(leave.names.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `b${i}`));
    const fromFlight = leave.names.slice(30);
    expect(fromFlight.length).toBeGreaterThan(0);
    expect(fromFlight.length).toBeLessThan(20);
  });

  it("skips an event from another tab that cannot be serialized, and sends nothing when nothing fits", () => {
    env = installBrowserEnv();
    const { fetchImpl, sent } = hangingFetch();
    const sdk = make(fetchImpl, { maxBatchSize: 1, maxPayloadBytes: 200_000 });
    const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;
    const other = new Channel("eventra-sdk:ee0c38ea");
    const at = new Date().toISOString();
    // larger than a keepalive request may be, but within maxPayloadBytes: it goes out as a normal request
    other.postMessage({ type: "queue-add", events: [{ idempotencyKey: "big", name: "big", properties: { f: "z".repeat(70_000) }, timestamp: at }] });
    // the other tab had its 15 s to send it (S10): now this one does
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    void sdk.flush();
    expect(sent).toHaveLength(1);
    // a BigInt survives a BroadcastChannel but not JSON
    other.postMessage({ type: "queue-add", events: [{ idempotencyKey: "bad", name: "bad", properties: { n: 1n }, timestamp: at }] });

    env.window.dispatch("pagehide", {});
    expect(sent).toHaveLength(1);
    other.close();
  });

  it("leaves the sending to the new leader when this tab lost leadership while its request was in flight", () => {
    env = installBrowserEnv();
    const { fetchImpl, sent } = hangingFetch();
    const sdk = make(fetchImpl, { multiTabMode: "leader", maxBatchSize: 1 });
    sdk.track("a");
    expect(sent).toHaveLength(1);
    (sdk as unknown as { leader: { canSend: () => boolean } }).leader.canSend = () => false;
    env.window.dispatch("pagehide", {});
    expect(sent).toHaveLength(1);
  });

  it("a keepalive request that fails, is refused, or throws keeps the events queued", async () => {
    env = installBrowserEnv();
    const outcomes: Array<"reject" | "throw" | 500 | 200> = ["reject", "throw", 500, 200];
    for (const outcome of outcomes) {
      let normal = 0;
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        if (!init?.keepalive) {
          normal++;
          return new Promise(() => undefined); // in flight for good
        }
        if (outcome === "throw") throw new TypeError("refused");
        if (outcome === "reject") return Promise.reject(new TypeError("network"));
        return Promise.resolve({ status: outcome, ok: outcome === 200 } as Response);
      }) as unknown as typeof fetch;
      env.storage.clear(); // not the queue the previous round left
      const sdk = make(fetchImpl, { maxBatchSize: 1 });
      sdk.track("a");
      expect(normal).toBe(1);
      env.window.dispatch("pagehide", {});
      if (outcome === 200) sdk.destroy(); // the reply comes after destroy(): nothing is touched
      await new Promise((r) => setTimeout(r, 5));
      expect((sdk as unknown as { queue: unknown[] }).queue).toHaveLength(1);
      sdk.destroy();
    }
  });

  it("after a back/forward cache restore (pageshow) sends normal requests again, not keepalive", async () => {
    env = installBrowserEnv();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);

    sdk.track("before.leaving");
    env.window.dispatch("pagehide", {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].keepalive).toBe(true);

    env.window.dispatch("pageshow", { persisted: true });
    sdk.track("after.restore");
    await sdk.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].keepalive).toBe(false);
  });
});

describe("the queue in localStorage is capped by size", () => {
  it("writes only the newest events that fit in about 1 MB, and keeps all of them in memory", () => {
    env = installBrowserEnv();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl, { maxBatchSize: 500 });
    const filler = "y".repeat(20_000);

    for (let i = 0; i < 100; i++) sdk.track(`e${i}`, { properties: { filler } });
    (sdk as unknown as { persistNow: () => void }).persistNow();

    expect(calls).toHaveLength(0);
    const raw = env.storage.getItem(QUEUE_KEY)!;
    expect(raw.length).toBeLessThanOrEqual(1_000_000);
    const stored = JSON.parse(raw) as Array<{ name: string }>;
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(100);
    // the newest ones, in queue order
    expect(stored.map((e) => e.name)).toEqual(
      Array.from({ length: stored.length }, (_, i) => `e${100 - stored.length + i}`),
    );
    expect((sdk as unknown as { queue: unknown[] }).queue).toHaveLength(100);
  });

  it("leaves out an event from another tab that cannot be serialized", () => {
    env = installBrowserEnv();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);
    const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;
    const other = new Channel("eventra-sdk:ee0c38ea");
    sdk.track("one");
    other.postMessage({ type: "queue-add", events: [{ idempotencyKey: "bad", name: "bad", properties: { n: 1n }, timestamp: new Date().toISOString() }] });
    sdk.track("two");
    (sdk as unknown as { persistNow: () => void }).persistNow();
    const stored = JSON.parse(env.storage.getItem(QUEUE_KEY)!) as Array<{ name: string }>;
    expect(stored.map((e) => e.name)).toEqual(["one", "two"]);
    other.close();
  });

  it("writes a small queue as it is", () => {
    env = installBrowserEnv();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make(fetchImpl);
    sdk.track("one");
    sdk.track("two");
    (sdk as unknown as { persistNow: () => void }).persistNow();
    const stored = JSON.parse(env.storage.getItem(QUEUE_KEY)!) as Array<{ name: string }>;
    expect(stored.map((e) => e.name)).toEqual(["one", "two"]);
  });
});

describe("a global window that is not a browser", () => {
  const runtime = (sdk: Eventra) => (sdk as unknown as { runtime: string }).runtime;

  it("React Native (window without addEventListener) does not throw and is not treated as a browser", () => {
    vi.stubGlobal("window", globalThis);
    const { fetchImpl } = createMockFetch({ responses: [200] });
    let sdk!: Eventra;
    expect(() => {
      sdk = make(fetchImpl);
    }).not.toThrow();
    expect(runtime(sdk)).not.toBe("browser");
  });

  it("Deno 1.x (window with addEventListener but no document) does not throw and is not treated as a browser", () => {
    vi.stubGlobal("window", new EventTarget());
    const { fetchImpl } = createMockFetch({ responses: [200] });
    let sdk!: Eventra;
    expect(() => {
      sdk = make(fetchImpl);
    }).not.toThrow();
    expect(runtime(sdk)).not.toBe("browser");
  });

  it("a window that throws when touched is not treated as a browser", () => {
    const g = globalThis as { window?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, "window");
    Object.defineProperty(g, "window", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const { fetchImpl } = createMockFetch({ responses: [200] });
      expect(runtime(make(fetchImpl))).not.toBe("browser");
    } finally {
      if (had) Object.defineProperty(g, "window", had);
      else delete g.window;
    }
  });

  it("a browser that refuses to add a listener does not make the constructor throw", () => {
    env = installBrowserEnv();
    env.window.addEventListener = () => {
      throw new Error("no listeners here");
    };
    env.document.addEventListener = () => {
      throw new Error("no listeners here");
    };
    const { fetchImpl } = createMockFetch({ responses: [200] });
    let sdk!: Eventra;
    expect(() => {
      sdk = make(fetchImpl, { multiTabMode: "leader" });
    }).not.toThrow();
    expect(runtime(sdk)).toBe("browser");
    expect(() => sdk.destroy()).not.toThrow();
  });
});
