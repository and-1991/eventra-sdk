import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

describe("retry / backoff", () => {
  it("retries on 5xx and eventually succeeds", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [500, 503, 200] });
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
    await sdk.flush();
    expect(calls.length).toBe(3);
    // event should be removed from queue after final success
    sdk.track("b");
    await sdk.flush();
    expect(calls.length).toBe(4);
    expect(calls[3].body.events.map((e) => e.name)).toEqual(["b"]);
  });

  it("retries on 429", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [429, 200] });
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
    await sdk.flush();
    expect(calls.length).toBe(2);
  });

  it("retries on network error", async () => {
    const { fetchImpl, calls } = createMockFetch({
      responses: ["network", "network", 200],
    });
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
    await sdk.flush();
    expect(calls.length).toBe(3);
  });

  it("does not retry on 4xx (except 429) and fires onDeliveryFailed", async () => {
    const onDeliveryFailed = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [401] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      onDeliveryFailed,
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    expect(calls.length).toBe(1);
    expect(onDeliveryFailed).toHaveBeenCalledTimes(1);
    expect(onDeliveryFailed.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it("does not retry on 422 and removes events from queue", async () => {
    const onDeliveryFailed = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [422, 200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      onDeliveryFailed,
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    sdk.track("b");
    await sdk.flush();

    expect(calls.length).toBe(2);
    expect(onDeliveryFailed).toHaveBeenCalledTimes(1);
    // second flush must carry only "b" (event "a" not requeued after 422)
    expect(calls[1].body.events.map((e) => e.name)).toEqual(["b"]);
  });

  it("keeps events in queue after exhausting retries on 5xx", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [500, 500, 500] });
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
    await sdk.flush();
    expect(calls.length).toBe(3);

    // event should still be queued — the next flush retries it
    const { fetchImpl: fetchImpl2, calls: calls2 } = createMockFetch({
      responses: [200],
    });
    // swap fetch by destroying and creating a new client over the same queue?
    // easier path: use a single client and verify queue still has "a"
    (sdk as unknown as { fetch: typeof fetch }).fetch = fetchImpl2;
    await sdk.flush();
    expect(calls2[0].body.events.map((e) => e.name)).toEqual(["a"]);
  });
});
