import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
});

function makeSdk(extra: Partial<ConstructorParameters<typeof Eventra>[0]> = {}) {
  const { fetchImpl, calls } = createMockFetch({ responses: [200] });
  const sdk = new Eventra({
    apiKey: "test-key",
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
    ...extra,
  });
  active.push(sdk);
  return { sdk, calls };
}

describe("track() validation", () => {
  it("drops an empty event name via onEventsDropped instead of throwing", () => {
    const onEventsDropped = vi.fn();
    const { sdk, calls } = makeSdk({ onEventsDropped });
    expect(() => sdk.track("")).not.toThrow();
    expect(() => sdk.track("   ")).not.toThrow();
    expect(onEventsDropped).toHaveBeenCalledTimes(2);
    expect(onEventsDropped).toHaveBeenCalledWith(1);
    expect(calls.length).toBe(0);
  });

  it("drops a nullish event name (a plain-JS caller ignoring the TS signature) without throwing", () => {
    const onEventsDropped = vi.fn();
    const { sdk, calls } = makeSdk({ onEventsDropped });
    expect(() => sdk.track(undefined as unknown as string)).not.toThrow();
    expect(() => sdk.track(null as unknown as string)).not.toThrow();
    expect(onEventsDropped).toHaveBeenCalledTimes(2);
    expect(onEventsDropped).toHaveBeenCalledWith(1);
    expect(calls.length).toBe(0);
  });

  it("truncates name longer than 64 chars instead of throwing", async () => {
    const { sdk, calls } = makeSdk();
    expect(() => sdk.track("a".repeat(65))).not.toThrow();
    await sdk.flush();
    expect(calls[0].body.events[0].name).toBe("a".repeat(64));
  });

  it("trims surrounding whitespace before length check", async () => {
    const { sdk, calls } = makeSdk();
    sdk.track("   user.signup   ");
    await sdk.flush();
    expect(calls[0].body.events[0].name).toBe("user.signup");
  });

  it("truncates userId to 120 chars", async () => {
    const { sdk, calls } = makeSdk();
    sdk.track("evt", { userId: "u".repeat(200) });
    await sdk.flush();
    expect((calls[0].body.events[0].userId as string).length).toBe(120);
  });

  it("drops properties deeper than 8 levels via onEventsDropped instead of throwing", () => {
    const onEventsDropped = vi.fn();
    const { sdk, calls } = makeSdk({ onEventsDropped });
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i++) {
      cursor.child = {} as Record<string, unknown>;
      cursor = cursor.child as Record<string, unknown>;
    }
    expect(() => sdk.track("evt", { properties: deep })).not.toThrow();
    expect(onEventsDropped).toHaveBeenCalledWith(1);
    expect(calls.length).toBe(0);
  });

  it("drops properties larger than 32 KB via onEventsDropped instead of throwing", () => {
    const onEventsDropped = vi.fn();
    const { sdk, calls } = makeSdk({ onEventsDropped });
    const huge = { blob: "x".repeat(40_000) };
    expect(() => sdk.track("evt", { properties: huge })).not.toThrow();
    expect(onEventsDropped).toHaveBeenCalledWith(1);
    expect(calls.length).toBe(0);
  });

  it("assigns a unique idempotencyKey per event", async () => {
    const { sdk, calls } = makeSdk();
    sdk.track("a");
    sdk.track("b");
    sdk.track("c");
    await sdk.flush();
    const keys = calls[0].body.events.map((e) => e.idempotencyKey as string);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) {
      expect(k).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("requires apiKey", () => {
    expect(() => new Eventra({ apiKey: "" } as never)).toThrow(/apiKey required/);
  });

  it("requires fetch (no global, no fetchImpl)", () => {
    const original = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      expect(
        () => new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false }),
      ).toThrow(/fetch not available/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it("ignores track() after destroy/shutdown", async () => {
    const { sdk, calls } = makeSdk();
    sdk.track("first");
    await sdk.shutdown();
    sdk.track("second");
    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["first"]);
  });
});
