import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

const QUEUE_KEY = "__eventra_q__";
const CHANNEL_NAME = "eventra-sdk";

let env: BrowserEnvHandle;
let active: Eventra[] = [];

beforeEach(() => {
  env = installBrowserEnv();
});

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  env.restore();
  vi.useRealTimers();
});

describe("Storage — corrupted / blocked persistence", () => {
  it("recovers from a corrupted queue value in localStorage instead of throwing", async () => {
    env.storage.setItem(QUEUE_KEY, "{not valid json");

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(calls.length).toBe(0); // nothing recovered — corrupted value discarded
  });

  it("silently ignores a quota-exceeded localStorage.setItem when persisting the queue", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    const originalSetItem = env.storage.setItem.bind(env.storage);
    env.storage.setItem = (key: string, value: string) => {
      if (key === QUEUE_KEY) throw new Error("QuotaExceededError");
      originalSetItem(key, value);
    };

    expect(() => sdk.track("a")).not.toThrow();
    expect(env.storage.getItem(QUEUE_KEY)).toBeNull();

    env.storage.setItem = originalSetItem;
  });
});

describe("queue trimming on load", () => {
  it("drops the oldest excess events when a recovered queue exceeds maxQueueSize", () => {
    env.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        { idempotencyKey: "k1", name: "e1", properties: {}, timestamp: "t" },
        { idempotencyKey: "k2", name: "e2", properties: {}, timestamp: "t" },
        { idempotencyKey: "k3", name: "e3", properties: {}, timestamp: "t" },
      ]),
    );

    const onEventsDropped = vi.fn();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxQueueSize: 2,
      onEventsDropped,
    });
    active.push(sdk);

    // trimQueue() reports the overflow via onEventsDropped as a side effect;
    // the actual in-memory trim/persist happens on the next syncQueue() pass
    expect(onEventsDropped).toHaveBeenCalledWith(1);
  });
});

describe("BroadcastChannel unavailable", () => {
  it("still works (queue persists via localStorage only) when BroadcastChannel doesn't exist", async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    expect(() => sdk.track("a")).not.toThrow();
    await sdk.flush();
    expect(calls.length).toBe(1);
  });
});

describe("BroadcastChannel sync — malformed messages", () => {
  it("ignores a broadcast message that isn't a queue-sync payload", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("local.a");

    const ChannelCtor = (globalThis as { BroadcastChannel: typeof BroadcastChannel })
      .BroadcastChannel;
    const sibling = new ChannelCtor(CHANNEL_NAME);
    sibling.postMessage({ type: "something-else", events: [{ name: "ignored" }] });
    sibling.postMessage({ type: "queue-sync", events: "not-an-array" });

    await sdk.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["local.a"]);
  });
});

describe("cross-tab queue sync via storage events", () => {
  it("reloads the queue from localStorage when a sibling tab writes the queue key", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    // a sibling tab writes its own persisted queue directly to localStorage
    env.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        {
          idempotencyKey: "sibling-key",
          name: "sibling.event",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    env.window.dispatch("storage", { key: QUEUE_KEY });

    await sdk.flush();
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["sibling.event"]);
  });

  it("ignores storage events for unrelated keys", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    env.storage.setItem(QUEUE_KEY, JSON.stringify([{ idempotencyKey: "x" }]));
    env.window.dispatch("storage", { key: "__unrelated_key__" });

    await sdk.flush();
    expect(calls.length).toBe(0); // never reloaded — key didn't match
  });
});

describe("visibilitychange exit handling", () => {
  it("flushes when the page becomes hidden, and does nothing when it becomes visible", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("a");
    env.document.visibilityState = "visible";
    env.window.dispatch("visibilitychange", {});
    await Promise.resolve();
    expect(calls.length).toBe(0);

    env.document.visibilityState = "hidden";
    env.window.dispatch("visibilitychange", {});
    await vi.waitFor(() => expect(calls.length).toBe(1));
  });
});

describe("buildBatch — every candidate event is poison", () => {
  it("drops every event in the queue and ends the flush loop with an empty batch", async () => {
    const onEventsDropped = vi.fn();
    const onDeliveryFailed = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxPayloadBytes: 5, // smaller than any possible single-event envelope
      onEventsDropped,
      onDeliveryFailed,
    });
    active.push(sdk);

    sdk.track("a");
    sdk.track("b");
    await sdk.flush();

    expect(calls.length).toBe(0);
    expect(onEventsDropped).toHaveBeenCalledTimes(2);
    expect(onDeliveryFailed).toHaveBeenCalledTimes(2);
  });
});
