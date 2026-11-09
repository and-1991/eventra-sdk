import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
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

// a fetch that resolves only when `release()` is called, so a flush stays in flight
function gatedFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    await gate;
    return { status: 200, ok: true } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, release, bodies };
}

describe("flush() while another flush is in flight", () => {
  it("waits for the running flush instead of resolving immediately", async () => {
    const { fetchImpl, release, bodies } = gatedFetch();
    const sdk = make(fetchImpl, { maxBatchSize: 2 });

    // reaching maxBatchSize starts a background flush (what serverless does per track())
    sdk.track("a");
    sdk.track("b");
    expect(bodies).toHaveLength(1);

    let resolved = false;
    const p = sdk.flush().then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false); // the request is still pending

    release();
    await p;
    expect(resolved).toBe(true);
  });

  it("picks up events queued during the in-flight flush", async () => {
    const { fetchImpl, release, bodies } = gatedFetch();
    const sdk = make(fetchImpl, { maxBatchSize: 1 });
    sdk.track("a");
    sdk.track("b");
    const p = sdk.flush();
    release();
    await p;
    const names = bodies.flatMap((b) => JSON.parse(b).events.map((e: { name: string }) => e.name));
    expect(names.sort()).toEqual(["a", "b"]);
  });

  it("does not hang or reject when the running flush fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl, { maxBatchSize: 1, maxRetries: 0 });
    sdk.track("a");
    await expect(sdk.flush()).resolves.toBeUndefined();
  });
});

describe("properties are snapshotted at track() time", () => {
  it("a circular reference added afterwards cannot crash or wedge the SDK", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      return { status: 200, ok: true } as Response;
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl);

    const props: Record<string, unknown> = { a: 1, nested: { x: 1 } };
    sdk.track("first", { properties: props });
    props.self = props;
    (props.nested as Record<string, unknown>).y = 2;

    await expect(sdk.flush()).resolves.toBeUndefined();
    const ev = JSON.parse(sent[0]).events[0];
    expect(ev.properties).toEqual({ a: 1, nested: { x: 1 } });

    sdk.track("second");
    await expect(sdk.shutdown()).resolves.toBeUndefined();
    expect(sent).toHaveLength(2);
  });

  it("drops an event whose properties are circular at call time", async () => {
    const dropped = vi.fn();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const sdk = make(fetchImpl, { onEventsDropped: dropped });
    const props: Record<string, unknown> = { a: 1 };
    props.self = props;
    expect(() => sdk.track("x", { properties: props })).not.toThrow();
    expect(dropped).toHaveBeenCalledWith(1);
    await sdk.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("corrupt persisted queue", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => {
    for (const sdk of active) sdk.destroy();
    active = [];
    env.restore();
  });

  for (const raw of ["[null]", "[1,\"x\",[],{}]", "[{\"name\":\"a\"}]", "{}", "\"str\"", "not json"]) {
    it(`does not throw on stored queue ${raw}`, async () => {
      env.storage.setItem("__eventra_q__", raw);
      const sent: string[] = [];
      const fetchImpl = (async (_u: string, init?: RequestInit) => {
        sent.push(String(init?.body));
        return { status: 200, ok: true } as Response;
      }) as unknown as typeof fetch;
      let sdk!: Eventra;
      expect(() => (sdk = make(fetchImpl))).not.toThrow();
      sdk.track("ok");
      await sdk.flush();
      const names = JSON.parse(sent[0]).events.map((e: { name: string }) => e.name);
      expect(names).toEqual(["ok"]);
    });
  }

  it("keeps valid events and skips junk entries in the same stored queue", async () => {
    env.storage.setItem(
      "__eventra_q__",
      JSON.stringify([
        null,
        { idempotencyKey: "11111111-1111-4111-8111-111111111111", name: "good", properties: {}, timestamp: new Date().toISOString() },
        7,
      ]),
    );
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      return { status: 200, ok: true } as Response;
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl);
    await sdk.flush();
    expect(JSON.parse(sent[0]).events.map((e: { name: string }) => e.name)).toEqual(["good"]);
  });
});

describe("an event that cannot be serialized", () => {
  it("is dropped instead of wedging the queue, and the events after it are still sent", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      return { status: 200, ok: true } as Response;
    }) as unknown as typeof fetch;
    const failed = vi.fn();
    const sdk = make(fetchImpl, { onDeliveryFailed: failed });
    (sdk as unknown as { queue: unknown[] }).queue.push({
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      name: "poison",
      properties: { n: 1n },
      timestamp: new Date().toISOString(),
    });
    sdk.track("fine");
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sent[0]).events.map((e: { name: string }) => e.name)).toEqual(["fine"]);
  });
});

describe("a browser that refuses BroadcastChannel", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => {
    for (const sdk of active) sdk.destroy();
    active = [];
    env.restore();
  });

  it("still builds the SDK, which then works on its own", async () => {
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = class {
      constructor() {
        throw new Error("SecurityError");
      }
    };
    try {
      const sent: string[] = [];
      const fetchImpl = (async (_u: string, init?: RequestInit) => {
        sent.push(String(init?.body));
        return { status: 200, ok: true } as Response;
      }) as unknown as typeof fetch;
      let sdk!: Eventra;
      expect(() => (sdk = make(fetchImpl))).not.toThrow();
      sdk.track("alone");
      await sdk.flush();
      expect(JSON.parse(sent[0]).events[0].name).toBe("alone");
    } finally {
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    }
  });
});
