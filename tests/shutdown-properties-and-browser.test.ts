import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function make(extra: Record<string, unknown> = {}, responses: Array<number | "network" | "abort"> = [200]) {
  const { fetchImpl, calls } = createMockFetch({ responses });
  const sdk = new Eventra({ apiKey: "secret-key", disableTimer: true, autoFlushOnExit: false, fetchImpl, ...extra } as never);
  active.push(sdk);
  return { sdk, calls };
}

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const bodies: string[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    await gate;
    return { status: 200, ok: true } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, release, bodies };
}

describe("beforeExit does not keep a failing flush going", () => {
  const setup = (responses: Array<number | "network">) => {
    const onceSpy = vi.spyOn(process, "once");
    const made = make({ autoFlushOnExit: true, maxRetries: 1 }, responses);
    const handler = onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").pop()![1] as () => void;
    const listens = () => onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").length;
    return { ...made, handler, listens };
  };

  it("does not listen again while events are still queued after a failed flush", async () => {
    const { sdk, calls, handler, listens } = setup([500]);
    sdk.track("a");
    const before = listens();
    handler();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(listens()).toBe(before);
  });

  it("listens again after everything was delivered, and when there was nothing to send", async () => {
    const { sdk, calls, handler, listens } = setup([200]);
    const start = listens();
    handler();
    expect(listens()).toBe(start + 1);
    sdk.track("a");
    handler();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(listens()).toBe(start + 2));
  });
});

describe("a second shutdown()", () => {
  it("waits for the first, so await shutdown() then process.exit() loses nothing", async () => {
    const { fetchImpl, release, bodies } = gated();
    const { sdk } = make({ fetchImpl });
    sdk.track("a");
    const first = sdk.shutdown();
    const second = sdk.shutdown();
    expect(second).toBe(first);
    let done = false;
    void second.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(bodies).toHaveLength(1);
    release();
    await second;
    expect(done).toBe(true);
  });
});

describe("properties", () => {
  const sent = async (properties: unknown) => {
    const { sdk, calls } = make();
    sdk.track("e", { properties } as never);
    await sdk.flush();
    return calls[0]?.body.events[0];
  };

  it("an empty object is copied too: filling it in later changes nothing", async () => {
    const { sdk, calls } = make();
    const props: Record<string, unknown> = {};
    sdk.track("e", { properties: props });
    props.later = 1;
    await sdk.flush();
    expect(calls[0].body.events[0].properties).toEqual({});
  });

  it("only an object is a properties value: a number, a string, a list or a date is dropped", async () => {
    const dropped = vi.fn();
    for (const bad of [5, "abc", [1, 2], true, new Date(0)]) {
      const { sdk, calls } = make({ onEventsDropped: dropped });
      sdk.track("e", { properties: bad } as never);
      await sdk.flush();
      expect(calls).toHaveLength(0);
    }
    expect(dropped).toHaveBeenCalledTimes(5);
    expect((await sent({ a: 1 }))!.properties).toEqual({ a: 1 });
  });

  it("an object whose toJSON gives something that is not an object is dropped", async () => {
    expect(await sent({ a: 1, toJSON: () => 5 })).toBeUndefined();
  });

  it("a fan-out of shared references does not take exponential time", async () => {
    let level: unknown = { leaf: 1 };
    for (let i = 0; i < 6; i++) level = { a: level, b: level, c: level, d: level, e: level, f: level, g: level, h: level, i: level, j: level, k: level, l: level };
    const started = Date.now();
    const event = await sent({ root: level });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(event).toBeUndefined();
  });
});

describe("track() never throws", () => {
  it("not even for a userId getter that throws", () => {
    const dropped = vi.fn();
    const { sdk } = make({ onEventsDropped: dropped });
    const options = {
      get userId(): string {
        throw new Error("boom");
      },
    };
    expect(() => sdk.track("e", options)).not.toThrow();
    expect(dropped).toHaveBeenCalledWith(1);
  });
});

describe("callbacks and destroy()", () => {
  it("a callback that empties the events it is given does not make the SDK resend in a loop", async () => {
    const { sdk, calls } = make(
      { onDeliveryFailed: ({ events }: { events: unknown[] }) => { events.length = 0; } },
      [422],
    );
    sdk.track("a");
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  it("destroy() stops a flush that is already running from sending the rest", async () => {
    const { fetchImpl, release, bodies } = gated();
    const { sdk } = make({ fetchImpl, maxBatchSize: 1 });
    for (let i = 0; i < 5; i++) sdk.track(`e${i}`);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    sdk.destroy();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(bodies).toHaveLength(1);
  });
});

describe("the constructor", () => {
  it("leaves nothing behind when it throws, so a later instance is not 'a second instance'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", undefined);
    expect(() => new Eventra({ apiKey: "k", disableTimer: true })).toThrow(/fetch not available/);
    expect(() => new Eventra({ apiKey: "k", disableTimer: true })).toThrow(/fetch not available/);
    vi.unstubAllGlobals();
    make();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("multiple SDK instances"))).toBe(false);
  });

  it("undoes what it started when it fails late (timer, process listeners)", () => {
    const once = vi.spyOn(process, "once").mockImplementation(() => {
      throw new Error("no listeners for you");
    });
    expect(() => new Eventra({ apiKey: "k", fetchImpl: (async () => ({ status: 200, ok: true })) as unknown as typeof fetch })).toThrow("no listeners");
    once.mockRestore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    make();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("multiple SDK instances"))).toBe(false);
  });

  it("also removes the exit listeners it had registered when it fails at the very end", () => {
    const original = Object.defineProperty;
    const spy = vi.spyOn(Object, "defineProperty").mockImplementation(((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
      if (key === "apiKey") throw new Error("cannot hide the key");
      return original(target, key, descriptor);
    }) as typeof Object.defineProperty);
    const before = process.listenerCount("SIGTERM");
    try {
      expect(() => new Eventra({ apiKey: "k", fetchImpl: (async () => ({ status: 200, ok: true })) as unknown as typeof fetch })).toThrow("cannot hide");
    } finally {
      spy.mockRestore();
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("does not show the API key in JSON.stringify or util.inspect", () => {
    const { sdk } = make();
    expect(JSON.stringify(sdk)).not.toContain("secret-key");
    expect(inspect(sdk, { depth: 6 })).not.toContain("secret-key");
  });
});

describe("in a browser", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => {
    for (const sdk of active) sdk.destroy();
    active = [];
    env.restore();
  });

  it("keepalive is only used for a payload a browser accepts (64 KiB), whatever maxPayloadBytes says", async () => {
    env.document.visibilityState = "hidden";
    const big = "x".repeat(2000);
    const { sdk, calls } = make({ maxPayloadBytes: 200_000, maxBatchSize: 1000 });
    for (let i = 0; i < 40; i++) sdk.track(`e${i}`, { properties: { big } });
    await sdk.flush();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].keepalive).toBe(false);
    const small = make({ maxPayloadBytes: 200_000 });
    small.sdk.track("tiny");
    await small.sdk.flush();
    expect(small.calls[0].keepalive).toBe(true);
  });

  it("closes the channel and the leader lease when it fails late in a browser", () => {
    const original = Object.defineProperty;
    const spy = vi.spyOn(Object, "defineProperty").mockImplementation(((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
      if (key === "apiKey") throw new Error("cannot hide the key");
      return original(target, key, descriptor);
    }) as typeof Object.defineProperty);
    try {
      expect(() => make({ multiTabMode: "leader" })).toThrow("cannot hide");
    } finally {
      spy.mockRestore();
    }
    expect(env.storage.getItem("__eventra_leader__6a82cc93")).toBeNull();
  });

  it("leader mode survives a localStorage that throws on access (a sandboxed iframe)", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      let sdk!: Eventra;
      expect(() => (sdk = make({ multiTabMode: "leader" }).sdk)).not.toThrow();
      sdk.track("a");
      await expect(sdk.flush()).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: env.storage });
    }
  });

  it("a stored event that is missing its timestamp, has a long name, or a user id that is not text is not forwarded", async () => {
    const good = { idempotencyKey: "44444444-4444-4444-8444-444444444444", name: "good", properties: {}, timestamp: new Date().toISOString() };
    env.storage.setItem(
      "__eventra_q__6a82cc93",
      JSON.stringify([
        good,
        { ...good, idempotencyKey: "a1", timestamp: undefined },
        { ...good, idempotencyKey: "a2", name: "n".repeat(500) },
        { ...good, idempotencyKey: "a3", userId: 5 },
        { ...good, idempotencyKey: "a4", properties: [1] },
        { ...good, idempotencyKey: "", name: "empty.key" },
        { ...good, idempotencyKey: "k".repeat(200), name: "long.key" },
        { ...good, idempotencyKey: 5, name: "numeric.key" },
        { ...good, idempotencyKey: "a5", properties: null, name: "null.props" },
        { ...good, idempotencyKey: "a6", userId: "u".repeat(200), name: "long.user" },
        { ...good, idempotencyKey: "a7", userId: "someone", name: "good.user" },
      ]),
    );
    const { sdk, calls } = make();
    await sdk.flush();
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["good", "good.user"]);
  });
});

describe("draining a large queue", () => {
  it("takes the delivered batch off the front instead of testing every event, so 100,000 events do not take minutes", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, maxQueueSize: 120_000, maxBatchSize: 50 } as never);
    active.push(sdk);
    for (let i = 0; i < 100_000; i++) sdk.track(`e${i % 10}`);
    const started = Date.now();
    await sdk.flush();
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(calls.reduce((total, call) => total + call.body.events.length, 0)).toBe(100_000);
  }, 60_000);

  it("still removes a batch that is not at the front of the queue (events taken in a different order)", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const { sdk } = (() => {
      const made = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl });
      active.push(made);
      return { sdk: made };
    })();
    sdk.track("a");
    sdk.track("b");
    sdk.track("c");
    const internals = sdk as unknown as { queue: Array<{ name: string }>; removeDelivered(batch: unknown[]): void };
    internals.removeDelivered([internals.queue[1]]);
    expect(internals.queue.map((e) => e.name)).toEqual(["a", "c"]);
    internals.removeDelivered([internals.queue[0], internals.queue[1]]);
    expect(internals.queue).toEqual([]);
    await sdk.flush();
    expect(calls).toHaveLength(0);
  });
});

describe("the exit flush, the options and odd values", () => {
  it("the timer does not start a flush behind the exit flush, so a failing server cannot keep the process alive", async () => {
    vi.useFakeTimers();
    try {
      const onceSpy = vi.spyOn(process, "once");
      const { fetchImpl, calls } = createMockFetch({ responses: [500] });
      const sdk = new Eventra({ apiKey: "k", fetchImpl, flushInterval: 100, maxRetries: 2, retryBaseDelayMs: 1, autoFlushOnExit: true } as never);
      active.push(sdk);
      const beforeExit = onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").pop()![1] as () => void;
      sdk.track("a");
      beforeExit();
      await vi.advanceTimersByTimeAsync(50);
      const internals = sdk as unknown as { shutdownDeadline: number; queue: unknown[] };
      // the flush failed, the event is still queued, and the exit limit is still in force
      await vi.advanceTimersByTimeAsync(2000);
      expect(internals.queue.length).toBe(1);
      expect(internals.shutdownDeadline).toBeGreaterThan(0);
      const sent = calls.length;
      // the timer keeps firing, but each flush it starts is cut short by the limit instead of retrying and sleeping
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.length - sent).toBeLessThan(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an API key with characters a header cannot carry, and a fetchImpl that is not a function, are refused at once", () => {
    expect(() => new Eventra({ apiKey: "ключ" } as never)).toThrow(/cannot be sent in a header/);
    expect(() => new Eventra({ apiKey: "k", fetchImpl: "x" } as never)).toThrow(/fetchImpl must be a function/);
  });

  it("an endpoint that is not a URL, an unknown multiTabMode, a diagnostics that is not true or false, a fractional batch size and a huge maxRetries all say so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    make({ endpoint: "not a url", multiTabMode: "x", diagnostics: "no", maxBatchSize: 1.5, maxQueueSize: 2.5, maxRetries: 1e9 });
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    for (const name of ["endpoint", "multiTabMode", "diagnostics", "maxBatchSize", "maxQueueSize", "maxRetries"]) expect(said).toContain(`"${name}"`);
  });

  it("a non-finite number is not a user id", async () => {
    const { sdk, calls } = make({});
    sdk.track("a", { userId: Number.NaN });
    sdk.track("b", { userId: Number.POSITIVE_INFINITY });
    sdk.track("c", { userId: 7 });
    await sdk.flush();
    expect(calls[0].body.events.map((e) => e.userId)).toEqual([undefined, undefined, "7"]);
  });

  it("a properties object with a million keys is refused after listing its keys once (listing them is the only cost left)", async () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 1_000_000; i++) big[`k${i}`] = i;
    const dropped = vi.fn();
    const { sdk } = make({ onEventsDropped: dropped });
    const started = Date.now();
    sdk.track("a", { properties: big });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(dropped).toHaveBeenCalledWith(1);
  });

  it("a big object nested inside, or a long list, is refused before its items are walked", async () => {
    const dropped = vi.fn();
    const { sdk, calls } = make({ onEventsDropped: dropped });
    const wide: Record<string, number> = {};
    for (let i = 0; i < 60_000; i++) wide[`k${i}`] = i;
    sdk.track("a", { properties: { nested: wide } });
    sdk.track("b", { properties: { list: new Array(60_000).fill(1) } });
    // each object alone is under the budget, together they are not
    const almost: Record<string, number> = {};
    for (let i = 0; i < 49_990; i++) almost[`k${i}`] = i;
    const spread: Record<string, unknown> = { almost };
    for (let i = 0; i < 20; i++) spread[`p${i}`] = i;
    sdk.track("d", { properties: spread });
    sdk.track("c", { properties: { fine: [1, 2, { x: "y" }] } });
    expect(dropped).toHaveBeenCalledTimes(3);
    await sdk.flush();
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["c"]);
    expect(calls[0].body.events[0].properties).toEqual({ fine: [1, 2, { x: "y" }] });
  });

  it("properties inherited from a prototype are not walked or sent, only the object's own", async () => {
    const { sdk, calls } = make({});
    sdk.track("a", { properties: Object.assign(Object.create({ inherited: { deep: 1 } }), { own: 1 }) });
    await sdk.flush();
    expect(calls[0].body.events[0].properties).toEqual({ own: 1 });
  });

  it("shutdown() still completes when the channel cannot be closed", async () => {
    const { sdk } = make({});
    (sdk as unknown as { channel: { close(): void } | undefined }).channel = {
      close() {
        throw new Error("InvalidStateError");
      },
    };
    await expect(sdk.shutdown()).resolves.toBeUndefined();
  });
});

describe("more behavior in a browser", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => {
    for (const sdk of active) sdk.destroy();
    active = [];
    env.restore();
  });

  it("the flush on pagehide uses keepalive even while the page still counts as visible", async () => {
    const { sdk, calls } = make({});
    sdk.track("leaving");
    env.window.dispatch("pagehide", {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(env.document.visibilityState).not.toBe("hidden");
    expect(calls[0].keepalive).toBe(true);
  });

  it("a broadcast event with a time nobody can read is merged with a valid time", async () => {
    const { sdk, calls } = make({});
    const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;
    new Channel("eventra-sdk:6a82cc93").postMessage({ type: "queue-add", events: [{ idempotencyKey: "bc1", name: "remote", properties: {}, timestamp: "notadate" }] });
    // the other tab had its 15 s to send it (S10): now this one does
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await sdk.flush();
    expect(calls).toHaveLength(1);
    expect(Number.isNaN(Date.parse(String(calls[0].body.events[0].timestamp)))).toBe(false);
  });
});
