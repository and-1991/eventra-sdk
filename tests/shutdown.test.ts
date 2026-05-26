import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

describe("shutdown & destroy", () => {
  it("shutdown flushes pending events first, then tears down", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("bye");
    await sdk.shutdown();

    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["bye"]);

    // any subsequent track() is a no-op
    sdk.track("ghost");
    await sdk.flush();
    expect(calls.length).toBe(1);
  });

  it("destroy stops the periodic timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = createMockFetch({ responses: [200, 200] });
    const sdk = new Eventra({
      apiKey: "k",
      flushInterval: 20,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("a");
    await vi.advanceTimersByTimeAsync(30);
    expect(calls.length).toBe(1);

    sdk.destroy();
    await vi.advanceTimersByTimeAsync(200);
    // no extra timer-driven sends after destroy
    expect(calls.length).toBe(1);
  });

  it("shutdown is idempotent", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    await sdk.shutdown();
    await sdk.shutdown(); // should not throw
  });
});
