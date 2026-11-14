import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv } from "./helpers/browserEnv";

// S9 of AUDIT-2026-11-10: retries went on after destroy(), and destroy() in Node dropped the queue
// without telling onEventsDropped (shutdown() with the circuit breaker open, for one).

afterEach(() => {
  vi.useRealTimers();
});

describe("destroy() and what is still queued", () => {
  it("stops retrying once destroy() is called during the wait between attempts", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = createMockFetch({ responses: ["network", "network", 200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, retryBaseDelayMs: 1000, maxRetries: 3 });

    sdk.track("a");
    const flushing = sdk.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.length).toBe(1);

    sdk.destroy();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushing;

    expect(calls.length).toBe(1);
  });

  it("reports the events a Node process drops on destroy", () => {
    const dropped = vi.fn();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, onEventsDropped: dropped });

    sdk.track("a");
    sdk.track("b");
    sdk.track("c");
    sdk.destroy();

    expect(dropped).toHaveBeenCalledWith(3);
  });

  it("says nothing when nothing was left", async () => {
    const dropped = vi.fn();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, onEventsDropped: dropped });

    sdk.track("a");
    await sdk.shutdown();

    expect(dropped).not.toHaveBeenCalled();
  });

  it("reports what shutdown() leaves behind when the circuit breaker is open", async () => {
    const dropped = vi.fn();
    const { fetchImpl } = createMockFetch({ responses: ["network"] });
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, onEventsDropped: dropped, maxRetries: 1, retryBaseDelayMs: 0 });

    // enough failed flushes to open the breaker
    sdk.track("a");
    for (let i = 0; i < 6; i++) await sdk.flush();
    sdk.track("b");
    await sdk.shutdown();

    expect(dropped).toHaveBeenCalledWith(2);
  });

  it("does not count a batch that is still in flight", async () => {
    const dropped = vi.fn();
    let release: (value: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl: fetchImpl as unknown as typeof fetch, onEventsDropped: dropped });

    sdk.track("in.flight");
    const flushing = sdk.flush();
    await Promise.resolve();
    sdk.track("queued");
    sdk.destroy();

    expect(dropped).toHaveBeenCalledWith(1);
    release(new Response(null, { status: 202 }));
    await flushing;
  });

  it("does not report a browser queue that is kept in localStorage", () => {
    const env = installBrowserEnv();
    try {
      const dropped = vi.fn();
      const { fetchImpl } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, onEventsDropped: dropped });

      sdk.track("a");
      sdk.destroy();

      expect(dropped).not.toHaveBeenCalled();
    } finally {
      env.restore();
    }
  });

  it("reports a browser queue when persistQueue is off", () => {
    const env = installBrowserEnv();
    try {
      const dropped = vi.fn();
      const { fetchImpl } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, onEventsDropped: dropped, persistQueue: false });

      sdk.track("a");
      sdk.destroy();

      expect(dropped).toHaveBeenCalledWith(1);
    } finally {
      env.restore();
    }
  });
});
