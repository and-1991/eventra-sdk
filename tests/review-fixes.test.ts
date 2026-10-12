import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { Diagnostics, MemoryStore } from "../src/diagnostics";
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

const QUEUE_KEY = "__eventra_q__";
const DAY = 24 * 60 * 60 * 1000;

function make(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof Eventra>[0]> = {},
) {
  const sdk = new Eventra({
    apiKey: "k",
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
    ...extra,
  });
  active.push(sdk);
  return sdk;
}

function stored(name: string, ageMs: number, key: string, timestamp?: string) {
  return {
    idempotencyKey: key,
    name,
    properties: {},
    timestamp: timestamp ?? new Date(Date.now() - ageMs).toISOString(),
  };
}

function queueNames(sdk: Eventra): string[] {
  return (sdk as unknown as { queue: Array<{ name: string }> }).queue.map((e) => e.name);
}

function headerFetch(
  responses: Array<{ status: number; headers?: Record<string, string> }>,
) {
  const calls: number[] = [];
  let cursor = 0;
  const fetchImpl = (async () => {
    calls.push(Date.now());
    const r = responses[Math.min(cursor++, responses.length - 1)];
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("persisted events have a maximum age (14 days)", () => {
  beforeEach(() => {
    env = installBrowserEnv();
  });

  const okFetch = headerFetch([{ status: 200 }]).fetchImpl;

  it("drops events older than 14 days when the queue is loaded, keeps recent and unreadable ones", () => {
    env!.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([
        stored("old", 15 * DAY, "00000000-0000-4000-8000-000000000001"),
        stored("recent", 13 * DAY, "00000000-0000-4000-8000-000000000002"),
        stored("unreadable", 0, "00000000-0000-4000-8000-000000000003", "not a date"),
      ]),
    );

    const sdk = make(okFetch);

    expect(queueNames(sdk).sort()).toEqual(["recent", "unreadable"]);

    // storage is rewritten without the dropped event, so it never comes back
    env!.window.dispatch("pagehide", {});
    const names = JSON.parse(env!.storage.getItem(QUEUE_KEY) as string).map(
      (e: { name: string }) => e.name,
    );
    expect(names.sort()).toEqual(["recent", "unreadable"]);
  });

  it("does not rewrite storage when nothing expired", () => {
    env!.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([stored("fresh", DAY, "00000000-0000-4000-8000-000000000004")]),
    );
    const setSpy = vi.spyOn(env!.storage, "setItem");

    const sdk = make(okFetch);
    env!.window.dispatch("pagehide", {});

    expect(queueNames(sdk)).toEqual(["fresh"]);
    expect(setSpy).not.toHaveBeenCalledWith(QUEUE_KEY, expect.anything());
  });

  it("ignores expired events that another tab wrote (storage event and persist merge)", () => {
    const sdk = make(okFetch);
    sdk.track("mine");

    env!.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([stored("stale", 30 * DAY, "00000000-0000-4000-8000-000000000005")]),
    );
    env!.window.dispatch("storage", { key: QUEUE_KEY });
    expect(queueNames(sdk)).toEqual(["mine"]);

    env!.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([stored("stale2", 30 * DAY, "00000000-0000-4000-8000-000000000006")]),
    );
    env!.window.dispatch("pagehide", {});
    const names = JSON.parse(env!.storage.getItem(QUEUE_KEY) as string).map(
      (e: { name: string }) => e.name,
    );
    expect(names).toEqual(["mine"]);
  });
});

describe("Retry-After also delays the next flush", () => {
  it("skips flushes until the delay is over, then sends and clears it", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([
      { status: 429, headers: { "retry-after": "10" } },
      { status: 200 },
    ]);
    const sdk = make(fetchImpl, { maxRetries: 1 });

    sdk.track("a");
    await sdk.flush(); // 429, Retry-After: 10 s
    expect(calls).toHaveLength(1);

    await sdk.flush(); // still inside the delay: nothing is sent
    await vi.advanceTimersByTimeAsync(9000);
    await sdk.flush();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1500);
    await sdk.flush(); // delay over
    expect(calls).toHaveLength(2);

    sdk.track("b");
    await sdk.flush(); // success cleared the delay
    expect(calls).toHaveLength(3);
  });

  it("is ignored by shutdown(), which makes one last attempt", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([
      { status: 429, headers: { "retry-after": "20" } },
      { status: 200 },
    ]);
    const sdk = make(fetchImpl, { maxRetries: 1 });

    sdk.track("a");
    await sdk.flush();
    expect(calls).toHaveLength(1);

    await sdk.shutdown();
    expect(calls).toHaveLength(2);
  });
});

describe("shutdown() has a total time budget", () => {
  it("gives up quickly on a rate-limited server instead of sleeping through Retry-After", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([
      { status: 429, headers: { "retry-after": "30" } },
    ]);
    const sdk = make(fetchImpl, { maxRetries: 3, shutdownTimeoutMs: 1000 });

    sdk.track("a");
    const started = Date.now();
    let done = false;
    const p = sdk.shutdown().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(done).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(1000);
    // no second attempt was started: the 30 s wait does not fit in the budget
    expect(calls).toHaveLength(1);
  });

  it("returns at the budget even when the server never answers (default 10 s)", async () => {
    vi.useFakeTimers();
    const fetchImpl = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const sdk = make(fetchImpl);

    sdk.track("a");
    let done = false;
    const p = sdk.shutdown().then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(9900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
  });

  it("shortens the per-request timeout to what is left of the budget", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const sdk = make(fetchImpl, { maxRetries: 1, shutdownTimeoutMs: 2000 });

    sdk.track("a");
    const p = sdk.shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    // the normal timeout is 5 s; the request was aborted at the 2 s budget
    expect(aborted).toBe(true);
  });

  it("a zero budget does not wait at all", async () => {
    vi.useFakeTimers();
    const fetchImpl = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const sdk = make(fetchImpl, { shutdownTimeoutMs: 0 });

    sdk.track("a");
    const p = sdk.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await p; // resolves although the request never answers
    expect(queueNames(sdk)).toEqual(["a"]);
  });

  it("still retries normally inside the budget", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = headerFetch([{ status: 500 }, { status: 200 }]);
    const sdk = make(fetchImpl, { retryBaseDelayMs: 10, shutdownTimeoutMs: 5000 });

    sdk.track("a");
    const p = sdk.shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(calls).toHaveLength(2);
  });
});

describe("diagnostics units", () => {
  it("lists circuit_open by reason only, never in the failed or dropped totals", () => {
    const d = new Diagnostics(new MemoryStore(), "k", () => "id-1");

    d.record("circuit_open");
    expect(d.claim(0, "1.0.0")).toBeNull(); // nothing countable on its own

    d.record("server_error");
    d.record("circuit_open");
    const report = d.claim(3, "1.0.0");

    expect(report?.failedTotal).toBe(1);
    expect(report?.droppedTotal).toBe(0);
    expect(report?.byReason).toMatchObject({ server_error: 1, circuit_open: 2 });
  });
});

describe("exitOnSignal with a minimal process-like object", () => {
  it("re-raises nothing when the runtime has no kill, pid or listenerCount", async () => {
    const original = globalThis.process;
    const handlers = new Map<string, () => void>();
    const fake = {
      env: {},
      versions: { node: "22.0.0" },
      on: () => undefined,
      once: (event: string, fn: () => void) => handlers.set(event, fn),
    };
    Object.defineProperty(globalThis, "process", { value: fake, configurable: true });

    try {
      const fetchImpl = (async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        fetchImpl,
        exitOnSignal: true,
      });
      sdk.track("a");

      handlers.get("SIGTERM")!();
      await new Promise((r) => setTimeout(r, 20));
      // reaching this point without a throw is the assertion: no kill/pid
      expect(handlers.has("SIGTERM")).toBe(true);
      sdk.destroy();
    } finally {
      Object.defineProperty(globalThis, "process", { value: original, configurable: true });
    }
  });

  it("does not re-raise when other listeners exist and kill is available but pid is missing", async () => {
    const original = globalThis.process;
    const handlers = new Map<string, () => void>();
    const kill = vi.fn();
    const fake = {
      env: {},
      versions: { node: "22.0.0" },
      on: () => undefined,
      once: (event: string, fn: () => void) => handlers.set(event, fn),
      off: () => undefined,
      listenerCount: () => 0,
      kill,
    };
    Object.defineProperty(globalThis, "process", { value: fake, configurable: true });

    try {
      const fetchImpl = (async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        fetchImpl,
        exitOnSignal: true,
      });
      sdk.track("a");
      handlers.get("SIGINT")!();
      await new Promise((r) => setTimeout(r, 20));
      expect(kill).not.toHaveBeenCalled(); // no pid, so no kill
      sdk.destroy();
    } finally {
      Object.defineProperty(globalThis, "process", { value: original, configurable: true });
    }
  });
});
