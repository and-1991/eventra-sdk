import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

describe("circuit breaker", () => {
  it("opens after 5 consecutive retryable failures, blocking flush during cooldown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });

    // each flush exhausts retries (we feed only 5xx)
    const { fetchImpl, calls } = createMockFetch({
      responses: Array(50).fill(503),
    });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxRetries: 1, // one attempt per flush, fail fast
      retryBaseDelayMs: 1,
    });
    active.push(sdk);

    // 5 failed flushes → circuit opens
    for (let i = 0; i < 5; i++) {
      sdk.track(`evt.${i}`);
      await sdk.flush();
    }

    expect(calls.length).toBe(5);

    // 6th flush is blocked by the open circuit
    sdk.track("during-cooldown");
    await sdk.flush();
    expect(calls.length).toBe(5);

    // advance Date past cooldown
    const origNow = Date.now;
    const future = origNow() + 6000;
    vi.setSystemTime(future);

    // first call after cooldown enters half-open and tries again (still fails)
    await sdk.flush();
    expect(calls.length).toBe(6);
  });

  it("resets failure count after a successful delivery", async () => {
    const { fetchImpl, calls } = createMockFetch({
      // 2 failed flushes (with maxRetries: 1 each), then success, then enough
      // failures to verify counter was reset
      responses: [500, 500, 200, 500, 500, 500],
    });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    sdk.track("b");
    await sdk.flush();
    sdk.track("c");
    await sdk.flush(); // success → resets

    expect(calls.length).toBe(3);

    // after success, fail two more times — circuit should NOT open yet
    sdk.track("d");
    await sdk.flush();
    sdk.track("e");
    await sdk.flush();
    sdk.track("f");
    await sdk.flush();

    // 6 total calls, all attempted (no early-blocked flushes)
    expect(calls.length).toBe(6);
  });
});
