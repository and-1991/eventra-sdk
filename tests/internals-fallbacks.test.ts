import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

function runtimeFromSdk(sdk: Eventra): string {
  return (sdk as unknown as { runtime: string }).runtime;
}

describe("runtime detection — unknown fallback", () => {
  it("reports 'unknown' when no window/EdgeRuntime/AWS marker/process.versions.node is present", () => {
    // simulate a JS environment with a `process`-like global that carries
    // neither `.on` (Node/EventEmitter-style) nor `versions.node`
    const original = globalThis.process;
    (globalThis as { process?: unknown }).process = { env: {} };

    try {
      const { fetchImpl } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        // leave autoFlushOnExit at its default (true) to also exercise
        // setupProcessExit()'s early return when process.on is missing
        fetchImpl,
      });
      active.push(sdk);
      expect(runtimeFromSdk(sdk)).toBe("unknown");
    } finally {
      (globalThis as { process?: unknown }).process = original;
    }
  });
});

describe("uuidV4 fallbacks", () => {
  // `crypto` is an accessor-only global (getter, no setter) in Node's ESM
  // runtime — a plain assignment throws in strict mode, so overriding it for
  // a test requires redefining the property descriptor outright.
  function overrideCrypto(value: unknown): () => void {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      value,
      configurable: true,
      writable: true,
    });
    return () => {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    };
  }

  it("falls back to crypto.getRandomValues when crypto.randomUUID is unavailable", async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const restore = overrideCrypto({ getRandomValues /* no randomUUID */ });

    try {
      const { sdk, calls } = makeSdk();
      sdk.track("a");
      await sdk.flush();
      const key = calls[0].body.events[0].idempotencyKey as string;
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      restore();
    }
  });

  it("throws when no crypto API is available at all (track() cannot generate an idempotencyKey)", () => {
    const restore = overrideCrypto(undefined);

    try {
      const { sdk } = makeSdk();
      expect(() => sdk.track("a")).toThrow(/crypto API unavailable/);
    } finally {
      restore();
    }
  });

  function makeSdk() {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);
    return { sdk, calls };
  }
});

describe("utf8ByteLength fallbacks", () => {
  it("falls back to Buffer.byteLength when TextEncoder is unavailable", async () => {
    const originalTextEncoder = globalThis.TextEncoder;
    (globalThis as { TextEncoder?: unknown }).TextEncoder = undefined;

    try {
      const { fetchImpl, calls } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        autoFlushOnExit: false,
        fetchImpl,
      });
      active.push(sdk);

      sdk.track("evt", { properties: { hello: "world" } });
      await sdk.flush();
      expect(calls.length).toBe(1);
      expect(calls[0].body.events[0].name).toBe("evt");
    } finally {
      (globalThis as { TextEncoder?: unknown }).TextEncoder = originalTextEncoder;
    }
  });

  it("falls back to raw string length when neither TextEncoder nor Buffer is available", async () => {
    const originalTextEncoder = globalThis.TextEncoder;
    const originalBuffer = globalThis.Buffer;
    (globalThis as { TextEncoder?: unknown }).TextEncoder = undefined;
    (globalThis as { Buffer?: unknown }).Buffer = undefined;

    try {
      const { fetchImpl, calls } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        autoFlushOnExit: false,
        fetchImpl,
      });
      active.push(sdk);

      sdk.track("evt", { properties: { hello: "world" } });
      await sdk.flush();
      expect(calls.length).toBe(1);
      expect(calls[0].body.events[0].name).toBe("evt");
    } finally {
      (globalThis as { TextEncoder?: unknown }).TextEncoder = originalTextEncoder;
      (globalThis as { Buffer?: unknown }).Buffer = originalBuffer;
    }
  });
});

describe("validateProperties — array traversal", () => {
  it("walks into arrays when computing nesting depth", () => {
    const onEventsDropped = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      onEventsDropped,
    });
    active.push(sdk);

    // array of objects within the depth limit — should pass through untouched
    sdk.track("ok", { properties: { list: [{ a: 1 }, { b: 2 }] } });

    // an array nested past MAX_PROPERTIES_DEPTH (8) inside more arrays — dropped
    let deep: unknown = "leaf";
    for (let i = 0; i < 10; i++) deep = [deep];
    sdk.track("too-deep", { properties: { list: deep } });

    expect(onEventsDropped).toHaveBeenCalledTimes(1);
    expect(onEventsDropped).toHaveBeenCalledWith(1);
    return sdk.flush().then(() => {
      expect(calls[0].body.events.map((e) => e.name)).toEqual(["ok"]);
    });
  });
});

describe("send() — AbortController unavailable", () => {
  it("surfaces a non-retryable-typed failure without crashing when AbortController is missing", async () => {
    const originalAbortController = globalThis.AbortController;
    (globalThis as { AbortController?: unknown }).AbortController = undefined;

    try {
      const { fetchImpl, calls } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        autoFlushOnExit: false,
        fetchImpl,
        maxRetries: 3,
        retryBaseDelayMs: 1,
      });
      active.push(sdk);

      sdk.track("a");
      await expect(sdk.flush()).resolves.toBeUndefined();
      // fetch was never reached — AbortController blew up before it
      expect(calls.length).toBe(0);
    } finally {
      (globalThis as { AbortController?: unknown }).AbortController = originalAbortController;
    }
  });
});
