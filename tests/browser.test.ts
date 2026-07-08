import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

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

describe("browser mode", () => {
  it("detects 'browser' runtime when window is present", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);
    expect((sdk as unknown as { runtime: string }).runtime).toBe("browser");
  });

  it("persists the queue to localStorage on track()", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("user.signup");
    sdk.track("page.viewed");

    const raw = env.storage.getItem("__eventra_q__");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.map((e: { name: string }) => e.name)).toEqual([
      "user.signup",
      "page.viewed",
    ]);
  });

  it("recovers queued events from localStorage on a fresh instance", async () => {
    // pre-populate a queue from a previous session
    env.storage.setItem(
      "__eventra_q__",
      JSON.stringify([
        {
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          name: "old.event",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    await sdk.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["old.event"]);
  });

  it("merges remote events via BroadcastChannel sync (idempotency-deduplicated)", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });

    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("local.a");

    // simulate sibling tab broadcasting its queue
    const ChannelCtor = (globalThis as { BroadcastChannel: typeof BroadcastChannel })
      .BroadcastChannel;
    const sibling = new ChannelCtor("eventra-sdk");
    const dupeKey = "22222222-2222-4222-8222-222222222222";
    sibling.postMessage({
      type: "queue-sync",
      events: [
        {
          idempotencyKey: dupeKey,
          name: "remote.b",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    // also re-broadcast the same event — should not duplicate
    sibling.postMessage({
      type: "queue-sync",
      events: [
        {
          idempotencyKey: dupeKey,
          name: "remote.b",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await sdk.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name).sort()).toEqual([
      "local.a",
      "remote.b",
    ]);
  });

  it("uses fetch keepalive when the page is hidden", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("late.event");
    env.document.visibilityState = "hidden";
    await sdk.flush();

    expect(calls.length).toBe(1);
    expect(calls[0].keepalive).toBe(true);
  });

  it("triggers a flush on pagehide", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);

    sdk.track("about.to.leave");
    env.window.dispatch("pagehide", {});
    await vi.waitFor(() => expect(calls.length).toBe(1));
  });

  it("persistQueue: false never writes the event queue to localStorage", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [500] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxRetries: 1,
      persistQueue: false,
    });
    active.push(sdk);

    sdk.track("user.signup", { userId: "user_123", properties: { plan: "pro" } });
    await sdk.flush(); // delivery fails (500) — event stays queued in memory

    expect(env.storage.getItem("__eventra_q__")).toBeNull();
    expect(calls.length).toBe(1);
  });

  it("persistQueue: false does not recover a queue left by a previous session", async () => {
    env.storage.setItem(
      "__eventra_q__",
      JSON.stringify([
        {
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
          name: "old.event",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      persistQueue: false,
    });
    active.push(sdk);

    await sdk.flush();
    expect(calls.length).toBe(0); // nothing queued — old.event was never loaded
  });

  it("persistQueue: false still dedupes live via BroadcastChannel", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      persistQueue: false,
    });
    active.push(sdk);

    sdk.track("local.a");

    const ChannelCtor = (globalThis as { BroadcastChannel: typeof BroadcastChannel })
      .BroadcastChannel;
    const sibling = new ChannelCtor("eventra-sdk");
    sibling.postMessage({
      type: "queue-sync",
      events: [
        {
          idempotencyKey: "22222222-2222-4222-8222-222222222222",
          name: "remote.b",
          properties: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await sdk.flush();
    expect(env.storage.getItem("__eventra_q__")).toBeNull();
    expect(calls[0]?.body.events.map((e) => e.name).sort()).toEqual([
      "local.a",
      "remote.b",
    ]);
  });

  it("acquires leadership when multiTabMode = 'leader'", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    // a single instance becomes leader immediately
    const lease = env.storage.getItem("__eventra_leader__");
    expect(lease).toBeTruthy();
  });

  it("blocks flush in 'leader' mode when another tab owns the lease", async () => {
    // pre-occupy the lease with a fresh ts and a different tabId
    env.storage.setItem(
      "__eventra_leader__",
      JSON.stringify({ tabId: "other-tab", ts: Date.now() }),
    );

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    sdk.track("a");
    await sdk.flush();
    expect(calls.length).toBe(0);
  });
});
