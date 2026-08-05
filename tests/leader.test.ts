import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

const LEADER_KEY = "__eventra_leader__";

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

function leaderTabId(sdk: Eventra): string {
  return (sdk as unknown as { leader: { tabId: string } }).leader.tabId;
}

describe("leader election — degraded environments", () => {
  it("becomes leader immediately when localStorage is unavailable in a browser-like env", async () => {
    // e.g. a restricted webview / cross-origin iframe with window but no storage access
    (globalThis as { localStorage?: unknown }).localStorage = undefined;

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
    expect(calls.length).toBe(1); // never blocked — always considered leader

    // destroy() must be a no-op for election/heartbeat/lease cleanup, not throw
    expect(() => sdk.destroy()).not.toThrow();
  });

  it("never persists to a missing localStorage but still delivers events", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;

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
    expect(calls.length).toBe(1);
  });
});

describe("leader election — lifecycle races", () => {
  it("renews its lease on a later tick while still holding it", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const before = JSON.parse(env.storage.getItem(LEADER_KEY) as string);

    // a later tick (triggered by a same-key storage event, as a sibling tab's
    // heartbeat would produce) re-verifies + renews the still-valid lease
    env.window.dispatch("storage", { key: LEADER_KEY });

    const after = JSON.parse(env.storage.getItem(LEADER_KEY) as string);
    expect(after.tabId).toBe(before.tabId);
    expect(after.ts).toBeGreaterThanOrEqual(before.ts);
  });

  it("steps down when another tab overwrites the lease", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });

    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const myTabId = leaderTabId(sdk);
    expect(JSON.parse(env.storage.getItem(LEADER_KEY) as string).tabId).toBe(myTabId);

    // a sibling tab grabs the lease
    env.storage.setItem(
      LEADER_KEY,
      JSON.stringify({ tabId: "sibling-tab", ts: Date.now() }),
    );
    env.window.dispatch("storage", { key: LEADER_KEY });

    // leadership lost — flush is now blocked
    sdk.track("blocked-now");
    await sdk.flush();
    expect(calls.length).toBe(0);
  });

  it("leaves a foreign lease alone on destroy() when it wins the race after leadership was already granted locally", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    // sibling tab overwrites the lease, but no tick has run locally yet —
    // this tab's in-memory isLeader flag is still (stale) true
    env.storage.setItem(
      LEADER_KEY,
      JSON.stringify({ tabId: "sibling-tab", ts: Date.now() }),
    );

    expect(() => sdk.destroy()).not.toThrow();
    // destroy() must not clobber the sibling's now-current lease
    expect(env.storage.getItem(LEADER_KEY)).toContain("sibling-tab");
  });

  it("destroy() tolerates the lease already being gone from storage", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    env.storage.removeItem(LEADER_KEY); // someone else already cleared it

    expect(() => sdk.destroy()).not.toThrow();
  });

  it("treats a missing lease as lost leadership on a later tick", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    env.storage.removeItem(LEADER_KEY);
    env.window.dispatch("storage", { key: LEADER_KEY });

    const { calls } = createMockFetch({ responses: [200] });
    sdk.track("a");
    await sdk.flush();
    expect(calls.length).toBe(0);
  });

  it("treats a corrupted lease value as lost leadership (JSON.parse failure)", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    env.storage.setItem(LEADER_KEY, "{not-json");
    env.window.dispatch("storage", { key: LEADER_KEY });

    sdk.track("a");
    await sdk.flush();
    expect(calls.length).toBe(0);
  });

  it("re-acquires leadership once its own fresh lease reappears after a foreign write", async () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);
    const myTabId = leaderTabId(sdk);

    // a sibling tab briefly grabs the lease...
    env.storage.setItem(
      LEADER_KEY,
      JSON.stringify({ tabId: "sibling-tab", ts: Date.now() }),
    );
    env.window.dispatch("storage", { key: LEADER_KEY });
    sdk.track("blocked");
    await sdk.flush();
    expect(calls.length).toBe(0);

    // ...then this tab's own last heartbeat write lands (out-of-order delivery)
    env.storage.setItem(LEADER_KEY, JSON.stringify({ tabId: myTabId, ts: Date.now() }));
    env.window.dispatch("storage", { key: LEADER_KEY });

    await sdk.flush();
    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["blocked"]);
  });

  it("acquires an expired lease left behind by a crashed tab", async () => {
    env.storage.setItem(
      LEADER_KEY,
      JSON.stringify({ tabId: "long-gone-tab", ts: Date.now() - 10_000 }),
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
    expect(calls.length).toBe(1);
  });

  it("treats a lease with an unparseable timestamp defensively (acquire-on-error)", async () => {
    // localStorage.getItem succeeding but JSON.parse throwing mid-tryAcquire
    env.storage.setItem(LEADER_KEY, "not json at all {");

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
    expect(calls.length).toBe(1);
  });

  it("ignores unrelated storage events (different key)", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const before = env.storage.getItem(LEADER_KEY);
    env.window.dispatch("storage", { key: "__something_else__" });
    expect(env.storage.getItem(LEADER_KEY)).toBe(before);
  });

  it("periodic re-election tick fires from the interval timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const before = JSON.parse(env.storage.getItem(LEADER_KEY) as string);
    await vi.advanceTimersByTimeAsync(2100); // LEADER_TTL_MS / 2 + margin
    const after = JSON.parse(env.storage.getItem(LEADER_KEY) as string);
    expect(after.ts).toBeGreaterThan(before.ts);
  });

  it("heartbeat interval keeps renewing the lease while leader", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const before = JSON.parse(env.storage.getItem(LEADER_KEY) as string);
    await vi.advanceTimersByTimeAsync(2100);
    const after = JSON.parse(env.storage.getItem(LEADER_KEY) as string);
    expect(after.ts).toBeGreaterThan(before.ts);
    expect(after.tabId).toBe(before.tabId);
  });

  it("silently drops a lease write when localStorage.setItem throws (renew failure)", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      multiTabMode: "leader",
    });
    active.push(sdk);

    const originalSetItem = env.storage.setItem.bind(env.storage);
    env.storage.setItem = (key: string, value: string) => {
      if (key === LEADER_KEY) throw new Error("blocked");
      originalSetItem(key, value);
    };

    // triggers another tick -> renew() -> localStorage.setItem throws -> caught
    expect(() => env.window.dispatch("storage", { key: LEADER_KEY })).not.toThrow();

    env.storage.setItem = originalSetItem;
  });
});
