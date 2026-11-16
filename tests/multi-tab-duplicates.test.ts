import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

// S10 of AUDIT-2026-11-10: in the default `independent` mode every open tab sent the events the other
// tabs had just announced, so each event went out about once per open tab.

let env: BrowserEnvHandle;
const active: Eventra[] = [];

beforeEach(() => {
  env = installBrowserEnv();
});

afterEach(() => {
  for (const sdk of active.splice(0)) sdk.destroy();
  env.restore();
  vi.restoreAllMocks();
});

function tab(extra: Record<string, unknown> = {}) {
  const mock = createMockFetch({ responses: [200] });
  const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl: mock.fetchImpl, ...extra });
  active.push(sdk);
  return { sdk, calls: mock.calls };
}

function announce(events: Array<{ idempotencyKey: string; name: string }>) {
  const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;
  const other = new Channel("eventra-sdk:ee0c38ea");
  other.postMessage({ type: "queue-add", events: events.map((e) => ({ ...e, properties: {}, timestamp: new Date().toISOString() })) });
  other.close();
}

const sentNames = (calls: ReturnType<typeof tab>["calls"]) => calls.flatMap((c) => c.body.events.map((e) => e.name));

describe("events another open tab announced", () => {
  it("are left to that tab for 15 s, while this tab's own events go out", async () => {
    const { sdk, calls } = tab();
    sdk.track("mine");
    announce([{ idempotencyKey: "other-1", name: "theirs" }]);

    await sdk.flush();

    expect(sentNames(calls)).toEqual(["mine"]);
  });

  it("are sent by this tab once the 15 s have passed (the other tab closed or cannot reach the server)", async () => {
    const { sdk, calls } = tab();
    announce([{ idempotencyKey: "other-1", name: "theirs" }]);

    await sdk.flush();
    expect(calls).toHaveLength(0);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await sdk.flush();

    expect(sentNames(calls)).toEqual(["theirs"]);
  });

  it("are dropped here once the other tab says they were delivered", async () => {
    const { sdk, calls } = tab();
    announce([{ idempotencyKey: "other-1", name: "theirs" }]);
    const Channel = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;
    const other = new Channel("eventra-sdk:ee0c38ea");
    other.postMessage({ type: "delivered", keys: ["other-1"] });
    other.close();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await sdk.flush();

    expect(calls).toHaveLength(0);
  });

  it("are sent at once by the leader in leader mode, which sends for every tab", async () => {
    const { sdk, calls } = tab({ multiTabMode: "leader" });
    announce([{ idempotencyKey: "other-1", name: "theirs" }]);

    await sdk.flush();

    expect(sentNames(calls)).toEqual(["theirs"]);
  });

  it("are not counted as dropped by this tab when merging overflows the queue (their tab counts them)", async () => {
    const dropped = vi.fn();
    const { sdk } = tab({ maxQueueSize: 2, onEventsDropped: dropped });
    sdk.track("mine");

    // three events in a queue of two: the oldest, this tab's own, goes and is reported here
    announce([
      { idempotencyKey: "o1", name: "t1" },
      { idempotencyKey: "o2", name: "t2" },
    ]);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenLastCalledWith(1);

    // now the oldest is the other tab's: trimmed, but not reported by this tab
    announce([{ idempotencyKey: "o3", name: "t3" }]);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect((sdk as unknown as { queue: Array<{ name: string }> }).queue.map((e) => e.name)).toEqual(["t2", "t3"]);
  });
});

describe("the record of announced events", () => {
  it("keeps at most 10,000 keys, dropping the oldest", () => {
    const { sdk } = tab({ maxQueueSize: 10 });
    announce(Array.from({ length: 10_001 }, (_, i) => ({ idempotencyKey: `k${i}`, name: "n" })));

    const live = (sdk as unknown as { liveTabEvents: Map<string, number> }).liveTabEvents;
    expect(live.size).toBe(10_000);
    expect(live.has("k0")).toBe(false);
    expect(live.has("k10000")).toBe(true);
  });
});

describe("events read from storage", () => {
  it("are sent at once: they come from an earlier page or a closed tab", async () => {
    env.storage.setItem(
      "__eventra_q__ee0c38ea",
      JSON.stringify([{ idempotencyKey: "stored-1", name: "from.earlier.page", properties: {}, timestamp: new Date().toISOString() }]),
    );
    const { sdk, calls } = tab();

    await sdk.flush();

    expect(sentNames(calls)).toEqual(["from.earlier.page"]);
  });
});
