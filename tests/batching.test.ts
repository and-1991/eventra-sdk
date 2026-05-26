import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

describe("batching", () => {
  it("auto-flushes when queue reaches maxBatchSize", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxBatchSize: 3,
    });
    active.push(sdk);

    sdk.track("a");
    sdk.track("b");
    expect(calls.length).toBe(0);

    sdk.track("c"); // crosses threshold
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body.events).toHaveLength(3);
  });

  it("respects maxBatchSize across multiple batches in one flush", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200, 200, 200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxBatchSize: 2,
    });
    active.push(sdk);

    sdk.track("a");
    sdk.track("b");
    sdk.track("c");
    sdk.track("d");
    sdk.track("e");
    await sdk.flush();
    // first batch was kicked off by track() (queue >= maxBatch), so the
    // remaining batches drain via the still-in-flight loop — wait for it
    await vi.waitFor(() => expect(calls.length).toBe(3));

    const sizes = calls.map((c) => c.body.events.length);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it("does nothing when flushed with empty queue", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    await sdk.flush();
    expect(calls.length).toBe(0);
  });

  it("periodic timer triggers flush", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      flushInterval: 50,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("a");
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(60);
    expect(calls.length).toBe(1);
  });

  it("drops events when queue exceeds maxQueueSize and reports via onEventsDropped", () => {
    const onEventsDropped = vi.fn();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxQueueSize: 2,
      maxBatchSize: 100,
      onEventsDropped,
    });
    active.push(sdk);

    sdk.track("a");
    sdk.track("b");
    sdk.track("c"); // queue is full → drop
    sdk.track("d");

    expect(onEventsDropped).toHaveBeenCalledTimes(2);
    expect(onEventsDropped).toHaveBeenCalledWith(1);
  });

  it("forwards x-api-key and Content-Type on every batch", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "super-secret",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    expect(calls[0].headers["x-api-key"]).toBe("super-secret");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("includes sdk metadata in every payload", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    expect(calls[0].body.sdk).toMatchObject({
      name: "@eventra_dev/eventra-sdk",
      version: "test",
    });
    expect(typeof (calls[0].body.sdk as { runtime: string }).runtime).toBe("string");
  });
});
