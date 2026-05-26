import { afterEach, describe, expect, it } from "vitest";
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
  it("rejects empty event name", () => {
    const { sdk } = makeSdk();
    expect(() => sdk.track("")).toThrow(/event name is required/);
    expect(() => sdk.track("   ")).toThrow(/event name is required/);
  });

  it("rejects name longer than 64 chars", () => {
    const { sdk } = makeSdk();
    expect(() => sdk.track("a".repeat(65))).toThrow(/exceeds max length/);
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

  it("rejects properties deeper than 8 levels", () => {
    const { sdk } = makeSdk();
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i++) {
      cursor.child = {} as Record<string, unknown>;
      cursor = cursor.child as Record<string, unknown>;
    }
    expect(() => sdk.track("evt", { properties: deep })).toThrow(/max depth/);
  });

  it("rejects properties larger than 32 KB", () => {
    const { sdk } = makeSdk();
    const huge = { blob: "x".repeat(40_000) };
    expect(() => sdk.track("evt", { properties: huge })).toThrow(/max size/);
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
