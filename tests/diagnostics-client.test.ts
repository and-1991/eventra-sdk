import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

let active: Eventra[] = [];
let env: BrowserEnvHandle | null = null;

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  env?.restore();
  env = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Body = {
  sdk: unknown;
  diagnostics?: {
    reportId: string;
    since: string;
    droppedTotal: number;
    failedTotal: number;
    byReason: Record<string, number>;
    queued: number;
    sdkVersion: string;
  };
  events: Array<{ name: string }>;
};

// fetch double: a response per call (number = status, "network" = rejects)
function scripted(responses: Array<number | "network">) {
  const calls: Body[] = [];
  let cursor = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Body);
    const r = responses[Math.min(cursor++, responses.length - 1)];
    if (r === "network") throw new TypeError("network");
    return {
      status: r,
      ok: r >= 200 && r < 300,
      headers: { get: () => null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}


// every distinct report that reached the server, summed (a report that was sent
// again after a failure is one report)
function reported(calls: Body[]) {
  const seen = new Map<string, NonNullable<Body["diagnostics"]>>();
  for (const c of calls) {
    if (c.diagnostics) seen.set(c.diagnostics.reportId, c.diagnostics);
  }
  const byReason: Record<string, number> = {};
  let dropped = 0;
  let failed = 0;
  for (const d of seen.values()) {
    dropped += d.droppedTotal;
    failed += d.failedTotal;
    for (const [k, v] of Object.entries(d.byReason)) byReason[k] = (byReason[k] ?? 0) + v;
  }
  return { byReason, dropped, failed, reports: seen.size };
}

function make(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof Eventra>[0]> = {},
) {
  const sdk = new Eventra({
    apiKey: "k",
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    ...extra,
  });
  active.push(sdk);
  return sdk;
}

describe("diagnostics in the batch envelope", () => {
  it("sends nothing extra when nothing went wrong", async () => {
    const { fetchImpl, calls } = scripted([200]);
    const sdk = make(fetchImpl);
    sdk.track("a");
    await sdk.flush();
    expect(calls[0].diagnostics).toBeUndefined();
    expect(Object.keys(calls[0])).toEqual(["sentAt", "sdk", "events"]);
  });

  it("reports a failed delivery with the next successful batch, once", async () => {
    const { fetchImpl, calls } = scripted(["network", 200, 200]);
    const sdk = make(fetchImpl);

    sdk.track("a");
    await sdk.flush(); // blocked: fails, the event stays queued
    expect(calls).toHaveLength(1);
    expect(calls[0].diagnostics).toBeUndefined();

    await sdk.flush(); // gets through, carries the counter
    const d = calls[1].diagnostics!;
    expect(d.failedTotal).toBe(1);
    expect(d.droppedTotal).toBe(0);
    expect(d.byReason).toEqual({ network: 1 });
    expect(d.sdkVersion).toBe("test");
    expect(d.queued).toBe(1);
    expect(d.reportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(calls[1])).toEqual(["sentAt", "sdk", "diagnostics", "events"]);

    // acknowledged by the 2xx: the next batch carries nothing
    sdk.track("b");
    await sdk.flush();
    expect(calls[2].diagnostics).toBeUndefined();
  });

  it("never carries event names, user ids or properties", async () => {
    const { fetchImpl, calls } = scripted(["network", 200]);
    const sdk = make(fetchImpl);
    sdk.track("secret_event", { userId: "user-42", properties: { email: "a@b.c" } });
    await sdk.flush();
    await sdk.flush();
    const json = JSON.stringify(calls[1].diagnostics);
    expect(json).not.toContain("secret_event");
    expect(json).not.toContain("user-42");
    expect(json).not.toContain("a@b.c");
  });

  it("keeps the same report id when the batch that carried it failed, and counts the new failure separately", async () => {
    const { fetchImpl, calls } = scripted(["network", 500, 200, 200]);
    const sdk = make(fetchImpl);

    sdk.track("a");
    await sdk.flush(); // 1: network, no report yet
    await sdk.flush(); // 2: carries report A, answered 500
    await sdk.flush(); // 3: carries report A again, 200
    const a1 = calls[1].diagnostics!;
    const a2 = calls[2].diagnostics!;
    expect(a2.reportId).toBe(a1.reportId);
    expect(a2.failedTotal).toBe(1);
    expect(a2.byReason).toEqual({ network: 1 });

    // the 500 that happened while report A was pending is in the next report
    sdk.track("b");
    await sdk.flush();
    const b = calls[3].diagnostics!;
    expect(b.reportId).not.toBe(a1.reportId);
    expect(b.byReason).toEqual({ server_error: 1 });
  });

  it("is off with diagnostics: false", async () => {
    const { fetchImpl, calls } = scripted(["network", 200]);
    const sdk = make(fetchImpl, { diagnostics: false });
    sdk.track("a");
    await sdk.flush();
    await sdk.flush();
    expect(calls[1].diagnostics).toBeUndefined();
  });

  it("counts every drop and failure reason", async () => {
    const { fetchImpl, calls } = scripted([429, 500, "network", 200, 200]);
    const sdk = make(fetchImpl, { maxQueueSize: 3 });

    sdk.track("");
    sdk.track("x", { properties: { deep: nested(20) } });
    sdk.track("1");
    sdk.track("2");
    sdk.track("3");
    sdk.track("4"); // queue full

    await sdk.flush(); // 429
    await sdk.flush(); // 500
    await sdk.flush(); // network
    await sdk.flush(); // 200: delivers and acknowledges the first report
    sdk.track("z");
    await sdk.flush(); // 200: the failures counted meanwhile

    const total = reported(calls);
    expect(total.byReason).toEqual({
      invalid_event: 2,
      queue_full: 1,
      rate_limited: 1,
      server_error: 1,
      network: 1,
    });
    expect(total.dropped).toBe(3);
    expect(total.failed).toBe(3);
    expect(total.reports).toBe(2);
  });

  it("counts an event rejected with 4xx and an oversized event", async () => {
    const { fetchImpl, calls } = scripted([422, 200, 200]);
    const sdk = make(fetchImpl, { maxPayloadBytes: 700 });

    sdk.track("a");
    sdk.track("b");
    await sdk.flush(); // 422: both events rejected
    sdk.track("big", { properties: { blob: "x".repeat(800) } });
    sdk.track("ok");
    await sdk.flush(); // the oversized one is dropped, the small one carries the report
    sdk.track("z");
    await sdk.flush();

    expect(calls[1].events.map((e) => e.name)).toEqual(["ok"]);
    expect(calls[1].diagnostics!.byReason).toEqual({ rejected: 2 });

    const total = reported(calls);
    expect(total.byReason).toEqual({ rejected: 2, too_large: 1 });
    expect(total.dropped).toBe(3);
    expect(total.failed).toBe(0);
  });

  it("sends a batch without the report when the report alone would not fit, and keeps it pending", async () => {
    const { fetchImpl, calls } = scripted(["network", 200, 200]);
    // roomy enough for an event, too small for event + report
    const sdk = make(fetchImpl, { maxPayloadBytes: 300 });
    sdk.track("a");
    await sdk.flush(); // network: a counter exists
    await sdk.flush(); // the event is sent, the report does not fit
    expect(calls[1].events.map((e) => e.name)).toEqual(["a"]);
    expect(calls[1].diagnostics).toBeUndefined();
  });

  it("counts the circuit breaker opening", async () => {
    vi.useFakeTimers();
    let up = false;
    const calls: Body[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Body);
      return {
        status: up ? 200 : 500,
        ok: up,
        headers: { get: () => null },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const sdk = make(fetchImpl);

    sdk.track("a");
    for (let i = 0; i < 5; i++) await sdk.flush(); // the fifth opens the breaker
    up = true;
    await vi.advanceTimersByTimeAsync(6000); // cooldown over
    await sdk.flush(); // delivered
    sdk.track("b");
    await sdk.flush(); // the rest of the counters

    const total = reported(calls);
    // circuit_open is only a detail of failures already counted: listed by
    // reason, never added to the failed total (failed = failed send attempts)
    expect(total.byReason.circuit_open).toBe(1);
    expect(total.byReason.server_error).toBe(5);
    expect(total.failed).toBe(5);
  });
});

describe("older servers that reject the unknown field", () => {
  it("resends the batch without diagnostics, delivers the events and stops sending the field", async () => {
    // 1: network failure (creates a counter), 2: 400 because of the field,
    // 3: the same batch without the field, accepted
    const { fetchImpl, calls } = scripted(["network", 400, 200, 200]);
    const sdk = make(fetchImpl);

    sdk.track("a");
    await sdk.flush();
    await sdk.flush();

    expect(calls[1].diagnostics).toBeDefined();
    expect(calls[2].diagnostics).toBeUndefined();
    expect(calls[2].events.map((e) => e.name)).toEqual(["a"]);

    // the event was delivered (queue empty) and the field is not sent again
    sdk.track("b");
    sdk.track("c");
    await sdk.flush();
    expect(calls[3].diagnostics).toBeUndefined();
  });

  it("does not turn diagnostics off over a real validation error", async () => {
    // 400 both with and without the field: the events really are invalid
    const { fetchImpl, calls } = scripted(["network", 400, 400, 200, 200]);
    const rejected = vi.fn();
    const sdk = make(fetchImpl, { onDeliveryFailed: rejected });

    sdk.track("a");
    await sdk.flush(); // network
    await sdk.flush(); // 400 with the field, 400 without: dropped
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(calls[1].diagnostics).toBeDefined();
    expect(calls[2].diagnostics).toBeUndefined();

    sdk.track("b");
    await sdk.flush(); // the first report is still pending and is sent again
    expect(calls[3].diagnostics).toBeDefined();
    sdk.track("c");
    await sdk.flush(); // and the rejection is reported after it
    expect(calls[4].diagnostics!.byReason).toEqual({ rejected: 1 });
  });

  it("a 422 is treated the same way", async () => {
    const { fetchImpl, calls } = scripted(["network", 422, 200]);
    const sdk = make(fetchImpl);
    sdk.track("a");
    await sdk.flush();
    await sdk.flush();
    expect(calls[2].diagnostics).toBeUndefined();
    expect(calls[2].events).toHaveLength(1);
  });
});

describe("diagnostics in the browser", () => {
  beforeEach(() => {
    env = installBrowserEnv();
  });

  it("survives a reload and is reported exactly once", async () => {
    const first = scripted(["network"]);
    const sdk1 = make(first.fetchImpl);
    sdk1.track("a");
    await sdk1.flush(); // fails: counter recorded
    sdk1.destroy(); // pagehide equivalent: counters written to localStorage

    expect(env!.storage.getItem("__eventra_d__")).not.toBeNull();

    const second = scripted([200, 200]);
    const sdk2 = make(second.fetchImpl);
    await sdk2.flush(); // restored queue + restored counters
    const d = second.calls[0].diagnostics!;
    expect(d.byReason).toEqual({ network: 1 });

    sdk2.track("b");
    await sdk2.flush();
    expect(second.calls[1].diagnostics).toBeUndefined();

    const stored = JSON.parse(env!.storage.getItem("__eventra_d__")!);
    expect(stored.pending).toBeUndefined();
    expect(stored.counts.dropped + stored.counts.failed).toBe(0);
  });

  it("writes the counters on the same debounce as the queue", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = scripted(["network"]);
    const sdk = make(fetchImpl);
    sdk.track("a");
    await sdk.flush();
    expect(env!.storage.getItem("__eventra_d__")).toBeNull();
    await vi.advanceTimersByTimeAsync(60);
    const stored = JSON.parse(env!.storage.getItem("__eventra_d__")!);
    expect(stored.counts.failed).toBe(1);
  });

  it("schedules its own write when the queue has nothing to write", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = scripted(["network", "network"]);
    const sdk = make(fetchImpl);
    sdk.track("a");
    await vi.advanceTimersByTimeAsync(60); // the queue is written, no timer left
    await sdk.flush(); // fails: only a counter changes
    expect(env!.storage.getItem("__eventra_d__")).toBeNull();
    await vi.advanceTimersByTimeAsync(60);
    const stored = JSON.parse(env!.storage.getItem("__eventra_d__")!);
    expect(stored.counts.failed).toBe(1);
  });

  it("two tabs never report the same counters twice", async () => {
    const failing = scripted(["network"]);
    const tabA = make(failing.fetchImpl);
    tabA.track("a");
    await tabA.flush();
    tabA.destroy();

    const okA = scripted([200]);
    const okB = scripted([200]);
    const a = make(okA.fetchImpl);
    const b = make(okB.fetchImpl);
    await a.flush();
    await b.flush();

    const sent = [...okA.calls, ...okB.calls]
      .map((c) => c.diagnostics)
      .filter(Boolean);
    // both may carry the pending report, but with the same id (the server
    // counts a report id once), and never two different reports
    expect(new Set(sent.map((d) => d!.reportId)).size).toBeLessThanOrEqual(1);
  });

  it("keeps the counters in memory only with persistQueue: false", async () => {
    const { fetchImpl, calls } = scripted(["network", 200]);
    const sdk = make(fetchImpl, { persistQueue: false });
    sdk.track("a");
    await sdk.flush();
    sdk.destroy();
    expect(env!.storage.getItem("__eventra_d__")).toBeNull();

    const sdk2 = make(scripted([200]).fetchImpl, { persistQueue: false });
    await sdk2.flush();
    expect(calls).toHaveLength(1);
  });
});

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}
