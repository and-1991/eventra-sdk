import { TrackerOptions, TrackEvent, SdkInfo, TrackOptions } from "./types";
import {
  Diagnostics,
  DiagnosticsReport,
  FailedReason,
  MemoryStore,
  SharedStore,
} from "./diagnostics";

declare const __SDK_VERSION__: string | undefined;
declare const __EVENTRA_ENDPOINT__: string | undefined;

const SDK_NAME = "@eventra_dev/eventra-sdk";
// `__EVENTRA_ENDPOINT__`/`__SDK_VERSION__` are build-time constants substituted
// by the bundler (see tsup/vitest `define`). Under this package's test config
// (vitest.config.ts) they're always statically defined to a truthy string, so
// the `|| default` fallback below can't be exercised by any test — it only
// matters for a build that omits the define entirely.
/* v8 ignore next 3 */
const DEFAULT_ENDPOINT =
  (typeof __EVENTRA_ENDPOINT__ !== "undefined" && __EVENTRA_ENDPOINT__) ||
  "https://api.eventra.dev/api/v1/ingest/batch";
/* v8 ignore next 2 */
const SDK_VERSION =
  (typeof __SDK_VERSION__ !== "undefined" && __SDK_VERSION__) || "0.0.0-dev";

const LEADER_KEY = "__eventra_leader__";
const LEADER_TTL_MS = 4000;
const QUEUE_KEY = "__eventra_q__";
const DIAGNOSTICS_KEY = "__eventra_d__";
const CHANNEL_NAME = "eventra-sdk";

const MAX_EVENT_NAME = 64;
const MAX_USER_ID = 120;
const MAX_PROPERTIES_JSON_BYTES = 32_000;
const MAX_PROPERTIES_DEPTH = 8;
const DEFAULT_MAX_PAYLOAD_BYTES = 60_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 5000;
const CIRCUIT_COOLDOWN_MAX_MS = 60_000;
const RETRY_AFTER_MAX_MS = 30_000;
// How long a burst of track() calls is coalesced into one localStorage write.
// A crash inside this window (not a normal tab close: pagehide, hidden and
// shutdown() write immediately) can lose the events tracked in it.
const PERSIST_DEBOUNCE_MS = 50;
// A queued event kept in localStorage longer than this is dropped when it is
// loaded again. The server only remembers idempotency keys for 30 days, so an
// event that was delivered during pagehide (whose response is never seen) and
// is re-sent by a visitor who returns after a long time could otherwise be
// accepted a second time.
const PERSISTED_EVENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
// Keys of events already delivered, remembered so a stale copy in
// localStorage or from another tab cannot put them back in the queue.
const DELIVERED_KEYS_MAX = 10_000;

let activeInstances = 0;

// ================= RUNTIME =================
type Runtime = "browser" | "node" | "edge" | "serverless" | "unknown";

function detectRuntime(): Runtime {
  const g = globalThis as typeof globalThis & {
    EdgeRuntime?: unknown;
    process?: { env?: Record<string, string>; versions?: { node?: string } };
  };

  if (typeof window !== "undefined" && !g.EdgeRuntime) return "browser";
  if (g.EdgeRuntime) return "edge";
  if (g.process?.env?.AWS_LAMBDA_FUNCTION_NAME) return "serverless";
  if (g.process?.versions?.node) return "node";

  return "unknown";
}

// ================= HELPERS =================
function uuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error("Eventra: crypto API unavailable — cannot generate idempotencyKey");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Never throws — `track()` is called fire-and-forget from arbitrary call sites,
 * so a malformed name must degrade gracefully instead of crashing the caller.
 * Returns `null` for an empty name (event should be dropped); otherwise trims
 * and truncates to `MAX_EVENT_NAME`, matching the documented behavior.
 */
function normalizeEventName(name: string): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_EVENT_NAME ? trimmed.slice(0, MAX_EVENT_NAME) : trimmed;
}

// `attempt` is the 0-based index of the attempt that just failed, so the first
// retry waits about `base`, the second about `base * 2`, and so on.
function backoffMs(attempt: number, base: number): number {
  const exp = Math.min(DEFAULT_MAX_RETRY_DELAY_MS, base * 2 ** attempt);
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return jitter;
}

// one encoder, created on first use (the global is still checked on every call)
let textEncoder: TextEncoder | undefined;

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    textEncoder ??= new TextEncoder();
    return textEncoder.encode(value).length;
  }
  const g = globalThis as { Buffer?: { byteLength: (s: string, enc: string) => number } };
  if (g.Buffer) {
    return g.Buffer.byteLength(value, "utf8");
  }
  return value.length;
}

function mergeQueues(...queues: TrackEvent[][]): TrackEvent[] {
  const seen = new Set<string>();
  const out: TrackEvent[] = [];

  for (const q of queues) {
    for (const e of q) {
      if (seen.has(e.idempotencyKey)) continue;
      seen.add(e.idempotencyKey);
      out.push(e);
    }
  }

  return out;
}

function validateProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  // Nothing to walk or measure for an empty object (the common case).
  let hasKeys = false;
  for (const _ in properties) {
    hasKeys = true;
    break;
  }
  if (!hasKeys) return properties;

  const depth = (obj: unknown, level: number): void => {
    if (level > MAX_PROPERTIES_DEPTH) {
      throw new Error(`Eventra: properties exceed max depth (${MAX_PROPERTIES_DEPTH})`);
    }
    if (obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) depth(item, level + 1);
      return;
    }
    for (const value of Object.values(obj as Record<string, unknown>)) {
      depth(value, level + 1);
    }
  };

  depth(properties, 0);

  const json = JSON.stringify(properties);
  if (utf8ByteLength(json) > MAX_PROPERTIES_JSON_BYTES) {
    throw new Error(
      `Eventra: properties exceed max size (${MAX_PROPERTIES_JSON_BYTES} bytes)`,
    );
  }

  return properties;
}

// Seconds ("120") or an HTTP date; anything else (or a past date) is ignored.
// Capped so one odd header cannot park the queue for a long time.
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - Date.now();
  }
  if (!(ms > 0)) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

type PreparedBatch = {
  events: TrackEvent[];
  // counters that travel with this batch (optional envelope metadata)
  diagnostics?: DiagnosticsReport;
  // each event serialized exactly once, joined into the payload by send()
  json: string[];
  bytes: number;
};

class RetryableDeliveryError extends Error {
  constructor(
    message = "retryable delivery error",
    readonly retryAfterMs?: number,
    readonly reason: FailedReason = "server_error",
  ) {
    super(message);
    this.name = "RetryableDeliveryError";
  }
}

// ================= STORAGE =================
class Storage {
  private enabled = false;

  constructor() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("__t", "1");
        localStorage.removeItem("__t");
        this.enabled = true;
      }
    } catch {
      /* private mode / blocked storage */
    }
  }

  get(key: string): unknown {
    if (!this.enabled) return null;
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown) {
    if (!this.enabled) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded */
    }
  }

  // Not currently called anywhere in the client — kept for API symmetry with
  // get()/set() on this internal class. No real call site exists to exercise
  // it, and Storage isn't part of the public surface, so a direct call here
  // would only be a reflection-hack test, not real usage.
  /* v8 ignore start */
  remove(key: string) {
    if (!this.enabled) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  /* v8 ignore stop */
}

// ================= LEADER =================
class Leader {
  private tabId = uuidV4();
  private isLeader = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private election?: ReturnType<typeof setInterval>;
  private onStorage?: (e: StorageEvent) => void;

  constructor(private onLeadershipChange?: (isLeader: boolean) => void) {
    if (typeof localStorage === "undefined") {
      this.isLeader = true;
      return;
    }

    this.tick();

    this.election = setInterval(() => this.tick(), LEADER_TTL_MS / 2);

    // Leader is only ever constructed from Eventra's constructor when
    // `this.runtime === "browser"`, and detectRuntime() only returns
    // "browser" when `window` is defined — so by the time this code runs
    // (having already passed the localStorage check above), window is
    // guaranteed to be defined too.
    /* v8 ignore else */
    if (typeof window !== "undefined") {
      this.onStorage = (e: StorageEvent) => {
        if (e.key === LEADER_KEY) this.tick();
      };
      window.addEventListener("storage", this.onStorage);
    }
  }

  private tick() {
    const was = this.isLeader;

    if (this.isLeader) {
      if (!this.verifyLease()) {
        this.isLeader = false;
      } else {
        this.renew();
      }
    } else {
      this.isLeader = this.tryAcquire();
      if (this.isLeader) {
        // This branch is only reached when isLeader was just flipped from
        // false to true. Whenever a tick() ends with isLeader false, the
        // check below (`!this.isLeader && this.heartbeat`) always clears
        // `heartbeat` back to undefined in that same tick — so on entry
        // here it can never already be set.
        /* v8 ignore else */
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.renew(), LEADER_TTL_MS / 2);
        }
      }
    }

    if (!this.isLeader && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    if (was !== this.isLeader) {
      this.onLeadershipChange?.(this.isLeader);
    }
  }

  private tryAcquire(): boolean {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(LEADER_KEY);
      if (!raw) {
        this.renew();
        return true;
      }
      const parsed = JSON.parse(raw) as { ts: number; tabId: string };
      if (now - parsed.ts > LEADER_TTL_MS) {
        this.renew();
        return true;
      }
      if (parsed.tabId === this.tabId) {
        this.renew();
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  private verifyLease(): boolean {
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { ts: number; tabId: string };
      return (
        parsed.tabId === this.tabId && Date.now() - parsed.ts <= LEADER_TTL_MS
      );
    } catch {
      return false;
    }
  }

  private renew() {
    try {
      localStorage.setItem(
        LEADER_KEY,
        JSON.stringify({ ts: Date.now(), tabId: this.tabId }),
      );
    } catch {
      /* ignore */
    }
  }

  canSend() {
    return this.isLeader;
  }

  destroy() {
    if (this.election) clearInterval(this.election);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.onStorage && typeof window !== "undefined") {
      window.removeEventListener("storage", this.onStorage);
    }
    if (this.isLeader && typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(LEADER_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { tabId: string };
          if (parsed.tabId === this.tabId) {
            localStorage.removeItem(LEADER_KEY);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
}

// ================= SDK =================
export class Eventra {
  private apiKey: string;
  private endpoint: string;
  private runtime: Runtime;
  private fetch: typeof fetch;

  private queue: TrackEvent[] = [];
  private sending: TrackEvent[] | null = null;
  private inFlight = false;
  private destroyed = false;
  private shuttingDown = false;

  private maxBatch: number;
  private maxQueue: number;
  private maxPayloadBytes: number;
  private flushInterval: number;
  private retries: number;
  private retryDelay: number;
  private persistQueue: boolean;
  private diagnosticsEnabled: boolean;
  private diagnostics: Diagnostics;

  private timer?: ReturnType<typeof setInterval>;

  private storage = new Storage();
  private leader: Leader | null = null;
  private channel?: BroadcastChannel;
  private onStorageQueue?: (e: StorageEvent) => void;

  private failureCount = 0;
  private circuitOpenUntil = 0;
  private circuitHalfOpen = false;
  // consecutive times the circuit opened without a success in between; drives
  // the exponential cooldown
  private circuitOpenCount = 0;

  private flushPromise: Promise<void> | null = null;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistDirty = false;
  private deliveredKeys = new Set<string>();
  // a 429/5xx Retry-After that outlives the last attempt also delays the next
  // flush (timer, size trigger, manual); shutdown() ignores it
  private nextFlushAt = 0;
  // 0 = no limit; set by shutdown() so retries and sleeps cannot overrun it
  private shutdownDeadline = 0;

  private sdkInfo: SdkInfo;
  private options: TrackerOptions;

  private exitHandlers: Array<() => void> = [];

  constructor(options: TrackerOptions) {
    if (!options.apiKey) throw new Error("Eventra: apiKey required");

    activeInstances++;
    if (activeInstances > 1 && typeof console !== "undefined") {
      console.warn(
        "Eventra: multiple SDK instances detected — duplicate timers and sends are possible",
      );
    }

    this.options = options;
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.runtime = detectRuntime();

    this.fetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetch) {
      throw new Error("Eventra: fetch not available — provide fetchImpl");
    }

    this.maxBatch = options.maxBatchSize ?? 50;
    this.maxQueue = options.maxQueueSize ?? 10000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.flushInterval = options.flushInterval ?? 2000;
    this.retries = options.maxRetries ?? 3;
    this.retryDelay = options.retryBaseDelayMs ?? 300;
    // Queued events may carry userId/properties — default on for durability
    // across reloads, but let privacy-sensitive integrators opt out of ever
    // writing that data to localStorage.
    this.persistQueue = options.persistQueue ?? true;

    // Counters of what could not be delivered travel with the next successful
    // batch; numbers only, never event content. Off with `diagnostics: false`.
    this.diagnosticsEnabled = options.diagnostics !== false;
    const shared = this.runtime === "browser" && this.persistQueue;
    this.diagnostics = new Diagnostics(
      shared ? new SharedStore(this.storage) : new MemoryStore(),
      DIAGNOSTICS_KEY,
      uuidV4,
      shared ? () => this.scheduleDiagnosticsSync() : undefined,
    );

    this.sdkInfo = {
      name: SDK_NAME,
      version: SDK_VERSION,
      runtime: this.runtime,
    };

    if (this.runtime === "browser") {
      if (this.persistQueue) {
        this.loadAndMergeQueue();
      }
      this.setupQueueSync();
    }

    if (this.runtime === "browser" && options.multiTabMode === "leader") {
      this.leader = new Leader((isLeader) => {
        if (isLeader) void this.flush();
      });
    }

    if (!options.disableTimer) {
      this.startTimer();
    }

    if (this.runtime === "browser") {
      this.setupBrowserExit();
    }

    if (options.autoFlushOnExit !== false && this.runtime !== "browser") {
      this.setupProcessExit();
    }
  }

  track(name: string, options?: TrackOptions) {
    if (this.destroyed || this.shuttingDown) return;

    const eventName = normalizeEventName(name);
    if (eventName === null) {
      this.recordDiagnostic("invalid_event");
      this.options.onEventsDropped?.(1);
      return;
    }

    let properties: Record<string, unknown>;
    try {
      properties = validateProperties(options?.properties ?? {});
    } catch {
      // Oversized/too-deep properties can't be safely truncated — drop the
      // event instead of throwing out of a fire-and-forget call site.
      this.recordDiagnostic("invalid_event");
      this.options.onEventsDropped?.(1);
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.recordDiagnostic("queue_full");
      this.options.onEventsDropped?.(1);
      return;
    }

    const event: TrackEvent = {
      idempotencyKey: uuidV4(),
      name: eventName,
      userId: truncate(options?.userId, MAX_USER_ID),
      properties,
      timestamp: new Date().toISOString(),
    };

    this.queue.push(event);

    if (this.runtime === "browser") {
      this.schedulePersist();
      this.broadcast({ type: "queue-add", events: [event] });
    }

    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    }

    if (this.runtime === "serverless") {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    return this.flushNow(false);
  }

  // `force` skips only the Retry-After delay (the last chance at shutdown);
  // the circuit breaker still applies
  private async flushNow(force: boolean): Promise<void> {
    if (this.inFlight || this.destroyed) return;
    if (!this.queue.length && !this.sending?.length) return;
    if (!force && Date.now() < this.nextFlushAt) return;

    if (this.leader && !this.leader.canSend()) return;

    const now = Date.now();
    if (now < this.circuitOpenUntil) return;

    if (this.circuitOpenUntil > 0 && now >= this.circuitOpenUntil) {
      this.circuitHalfOpen = true;
      this.circuitOpenUntil = 0;
    }

    this.inFlight = true;

    const run = this.runFlush();
    this.flushPromise = run;

    try {
      await run;
    } finally {
      this.flushPromise = null;
    }
  }

  private async runFlush(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const report = this.diagnosticsEnabled
          ? this.diagnostics.claim(this.queue.length, SDK_VERSION)
          : null;
        const batch = this.buildBatch(report);
        if (!batch.events.length) break;

        this.sending = batch.events;

        try {
          const accepted = await this.send(batch);
          // acknowledged only by a 2xx for the batch that carried the report
          if (accepted && batch.diagnostics) {
            this.diagnostics.ack(batch.diagnostics.reportId);
          }
          this.removeDelivered(batch.events);
          this.nextFlushAt = 0;
          this.failureCount = 0;
          this.circuitHalfOpen = false;
          this.circuitOpenCount = 0;
        } catch (err) {
          if (err instanceof RetryableDeliveryError) {
            this.recordDiagnostic(err.reason);
            if (err.retryAfterMs) {
              this.nextFlushAt = Date.now() + err.retryAfterMs;
            }
            this.failureCount++;
            if (this.circuitHalfOpen || this.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
              this.recordDiagnostic("circuit_open");
              // Exponential cooldown, capped. A failed half-open probe counts
              // as another opening, so an outage is probed less and less often.
              const cooldown = Math.min(
                CIRCUIT_COOLDOWN_MAX_MS,
                CIRCUIT_COOLDOWN_MS * 2 ** this.circuitOpenCount,
              );
              this.circuitOpenCount++;
              this.circuitOpenUntil =
                Date.now() + Math.max(cooldown, err.retryAfterMs ?? 0);
              this.circuitHalfOpen = false;
            }
            break;
          }
          break;
        } finally {
          this.sending = null;
        }

        // Reachable only after a *successful* send() (the catch above always
        // `break`s immediately whenever circuitOpenUntil is set to a future
        // value). flush() already returned early at the top if
        // `now < circuitOpenUntil`, so by the time execution gets here
        // circuitOpenUntil can only be <= that earlier `now` — never in the
        // future. Defense-in-depth against a future refactor reordering the
        // checks above, not currently reachable.
        /* v8 ignore next */
        if (this.circuitOpenUntil > Date.now()) break;
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Flush pending events, then tear down timers and listeners. Gives up after
   * `shutdownTimeoutMs` (default 10 s) so a dead or rate-limited server cannot
   * hold a SIGTERM shutdown past a typical grace period.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const budget = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.shutdownDeadline = Date.now() + Math.max(0, budget);

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<void>((resolve) => {
      budgetTimer = setTimeout(resolve, Math.max(0, budget));
      (budgetTimer as { unref?: () => void }).unref?.();
    });

    try {
      await Promise.race([this.flushEverything(), outOfTime]);
    } finally {
      clearTimeout(budgetTimer);
      this.destroy();
    }
  }

  private async flushEverything(): Promise<void> {
    // A flush may already be running (timer, size trigger): flush() would
    // return immediately and destroy() would drop what is still queued, so
    // let it finish and then send whatever is left.
    if (this.flushPromise) {
      await this.flushPromise;
    }
    await this.flushNow(true);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    activeInstances = Math.max(0, activeInstances - 1);

    if (this.timer) clearInterval(this.timer);

    // write any pending queue state before the listeners go away
    this.persistNow();

    this.leader?.destroy();

    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }

    if (this.onStorageQueue && typeof window !== "undefined") {
      window.removeEventListener("storage", this.onStorageQueue);
    }

    for (const off of this.exitHandlers) {
      off();
    }
  }

  private buildBatch(report: DiagnosticsReport | null): PreparedBatch {
    const events: TrackEvent[] = [];
    const json: string[] = [];
    const sentAt = new Date().toISOString();
    // size of the envelope with no events, `[]` included; every event then adds
    // its own bytes plus one comma between neighbours (equal to stringifying the
    // whole envelope, without redoing it for every candidate)
    const envelopeBytes = (withReport: boolean) =>
      utf8ByteLength(
        JSON.stringify({
          sentAt,
          sdk: this.sdkInfo,
          ...(withReport && report ? { diagnostics: report } : {}),
          events: [],
        }),
      );
    let withReport = report !== null;
    let bytes = envelopeBytes(withReport);
    let index = 0;

    while (index < this.queue.length && events.length < this.maxBatch) {
      const event = this.queue[index];
      const eventJson = JSON.stringify(event);
      const total = bytes + utf8ByteLength(eventJson) + (events.length ? 1 : 0);

      if (total > this.maxPayloadBytes) {
        if (events.length === 0) {
          if (withReport) {
            // the report itself may be what does not fit: send this batch
            // without it (it stays pending) before judging the event
            withReport = false;
            bytes = envelopeBytes(false);
            continue;
          }
          // removed from this.queue, so `index` now points at the next event;
          // the following event may be small enough to carry the report
          this.dropPoisonEvent(event);
          withReport = report !== null;
          bytes = envelopeBytes(withReport);
          continue;
        }
        break;
      }

      events.push(event);
      json.push(eventJson);
      bytes = total;
      index++;
    }

    return {
      events,
      json,
      bytes,
      diagnostics: withReport && report ? report : undefined,
    };
  }

  private dropPoisonEvent(event: TrackEvent) {
    this.recordDiagnostic("too_large");
    this.removeDelivered([event]);
    this.options.onEventsDropped?.(1);
    this.options.onDeliveryFailed?.({ status: 413, events: [event] });
  }

  private removeDelivered(batch: TrackEvent[]) {
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    this.queue = this.queue.filter((e) => !keys.has(e.idempotencyKey));

    if (this.runtime === "browser") {
      this.rememberDelivered(keys);
      this.schedulePersist();
      this.broadcast({ type: "delivered", keys: [...keys] });
    }
  }

  // Resolves true only when the server answered 2xx for a payload that
  // carried the diagnostics report (the only case that acknowledges it).
  private async send(batch: PreparedBatch): Promise<boolean> {
    const { events } = batch;
    let carriesDiagnostics = batch.diagnostics !== undefined;
    // same shape and key order as JSON.stringify({ sentAt, sdk, events }), with
    // every event serialized once, in buildBatch()
    const buildPayload = (withDiagnostics: boolean) => {
      const head = JSON.stringify({
        sentAt: new Date().toISOString(),
        sdk: this.sdkInfo,
        ...(withDiagnostics && batch.diagnostics
          ? { diagnostics: batch.diagnostics }
          : {}),
      });
      return `${head.slice(0, -1)},"events":[${batch.json.join(",")}]}`;
    };
    let payload = buildPayload(carriesDiagnostics);

    const payloadBytes = batch.bytes;
    /* v8 ignore start */
    // buildBatch() only ever returns a batch whose size already fits within
    // maxPayloadBytes, and nothing mutates `events` or maxPayloadBytes between
    // that check and this one, so this re-check can't trip in practice.
    // Defense-in-depth, not dead logic to be deleted.
    if (payloadBytes > this.maxPayloadBytes) {
      this.dropPoisonEvents(events);
      return false;
    }
    /* v8 ignore stop */

    const useKeepalive =
      this.runtime === "browser" &&
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      payloadBytes <= this.maxPayloadBytes;

    // A half-open breaker lets exactly one request through as a probe: no
    // retries while we don't know yet whether the endpoint is back.
    const maxAttempts = this.circuitHalfOpen ? 1 : Math.max(1, this.retries);
    // a server that rejects the unknown `diagnostics` field answers 400/422;
    // the batch is then sent once more without it
    let strippedDiagnostics = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const attemptTimeoutMs =
        this.shutdownDeadline > 0
          ? Math.max(1, Math.min(FETCH_TIMEOUT_MS, this.shutdownDeadline - Date.now()))
          : FETCH_TIMEOUT_MS;
      const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);

      try {
        const res = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: payload,
          signal: controller.signal,
          keepalive: useKeepalive,
        });

        if (res.status === 429 || res.status >= 500) {
          throw new RetryableDeliveryError(
            "retryable delivery error",
            parseRetryAfterMs(res.headers?.get?.("retry-after")),
            res.status === 429 ? "rate_limited" : "server_error",
          );
        }

        if (res.status >= 400 && res.status < 500) {
          if (carriesDiagnostics && (res.status === 400 || res.status === 422)) {
            // maybe an older server that does not know the field: events must
            // not be lost over it, so try again without it (not a new attempt)
            carriesDiagnostics = false;
            strippedDiagnostics = true;
            payload = buildPayload(false);
            attempt--;
            continue;
          }
          this.recordDiagnostic("rejected", events.length);
          this.options.onDeliveryFailed?.({ status: res.status, events });
          this.removeDelivered(events);
          return false;
        }

        if (!res.ok) {
          throw new RetryableDeliveryError();
        }

        if (strippedDiagnostics) {
          // accepted only once the field was left out: this server does not
          // take it, so stop sending it (the counters are kept, not reported)
          this.diagnosticsEnabled = false;
          return false;
        }

        return carriesDiagnostics;
      } catch (err) {
        const isLast = attempt >= maxAttempts - 1;
        const retryAfter =
          err instanceof RetryableDeliveryError ? err.retryAfterMs : undefined;
        const wait = Math.max(backoffMs(attempt, this.retryDelay), retryAfter ?? 0);
        // during shutdown there is no time left for another sleep + attempt
        const outOfBudget =
          this.shutdownDeadline > 0 && Date.now() + wait >= this.shutdownDeadline;

        if (isLast || outOfBudget) {
          throw err instanceof RetryableDeliveryError
            ? err
            : new RetryableDeliveryError("retryable delivery error", undefined, "network");
        }

        await sleep(wait);
      } finally {
        clearTimeout(timeout);
      }
    }

    // unreachable: the last attempt either returns or throws
    /* v8 ignore next */
    return false;
  }

  // Only caller is the defensive re-check in send() above, which is itself
  // unreachable in practice (see comment there) — see the same file's
  // ignore rationale. Kept for when that check trips defensively.
  /* v8 ignore start */
  private dropPoisonEvents(events: TrackEvent[]) {
    for (const event of events) {
      this.dropPoisonEvent(event);
    }
  }
  /* v8 ignore stop */

  private recordDiagnostic(reason: Parameters<Diagnostics["record"]>[0], n = 1) {
    if (this.diagnosticsEnabled) this.diagnostics.record(reason, n);
  }

  // counters reach localStorage on the same debounce as the queue
  private scheduleDiagnosticsSync() {
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private loadAndMergeQueue() {
    const remote = this.storage.get(QUEUE_KEY);
    if (Array.isArray(remote)) {
      const fresh = this.withoutExpired(remote as TrackEvent[]);
      // rewrite storage without what was dropped, so it does not come back
      if (fresh.length !== remote.length) this.persistDirty = true;
      this.queue = mergeQueues(this.queue, this.withoutDelivered(fresh));
    }
    this.queue = this.trimQueue();
  }

  // events whose timestamp is unreadable are kept: their age cannot be judged
  private withoutExpired(events: TrackEvent[]): TrackEvent[] {
    const oldest = Date.now() - PERSISTED_EVENT_MAX_AGE_MS;
    return events.filter((e) => {
      const at = Date.parse(e?.timestamp);
      return Number.isNaN(at) || at >= oldest;
    });
  }

  private withoutDelivered(events: TrackEvent[]): TrackEvent[] {
    if (!this.deliveredKeys.size) return events;
    return events.filter((e) => !this.deliveredKeys.has(e.idempotencyKey));
  }

  private rememberDelivered(keys: Iterable<string>) {
    for (const key of keys) this.deliveredKeys.add(key);
    // Set iterates in insertion order, so this drops the oldest keys first
    for (const key of this.deliveredKeys) {
      if (this.deliveredKeys.size <= DELIVERED_KEYS_MAX) break;
      this.deliveredKeys.delete(key);
    }
  }

  // Burst of track() calls = one write. Reading, merging and rewriting the
  // whole queue on every call made each call cost O(queue size).
  private schedulePersist() {
    if (!this.persistQueue) return;
    this.persistDirty = true;
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  // Immediate write of the pending state (pagehide, tab hidden, destroy).
  // Merges what other tabs wrote first, so concurrent tabs never overwrite
  // each other's events; delivered events are filtered out so they stay gone.
  private persistNow() {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    // counters first: they are written even when the queue itself is not dirty
    this.diagnostics.sync();
    if (!this.persistQueue || !this.persistDirty) return;
    this.persistDirty = false;

    const remote = this.storage.get(QUEUE_KEY);
    const merged = mergeQueues(
      Array.isArray(remote)
        ? this.withoutDelivered(this.withoutExpired(remote as TrackEvent[]))
        : [],
      this.queue,
    );
    this.queue = this.trimQueue(merged);
    this.storage.set(QUEUE_KEY, this.queue);
  }

  private trimQueue(queue: TrackEvent[] = this.queue): TrackEvent[] {
    if (queue.length <= this.maxQueue) return queue;
    const dropped = queue.length - this.maxQueue;
    this.recordDiagnostic("queue_full", dropped);
    this.options.onEventsDropped?.(dropped);
    return queue.slice(-this.maxQueue);
  }

  // Sends only what changed (a new event, or the keys just delivered) instead
  // of structured-cloning the whole queue on every call.
  private broadcast(message: unknown) {
    try {
      this.channel?.postMessage(message);
    } catch {
      /* ignore */
    }
  }

  private setupQueueSync() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (e: MessageEvent) => {
        const data = e.data;

        if (data?.type === "delivered" && Array.isArray(data.keys)) {
          const keys = new Set<string>(data.keys as string[]);
          this.rememberDelivered(keys);
          this.queue = this.queue.filter((ev) => !keys.has(ev.idempotencyKey));
          return;
        }

        // "queue-add" is the delta a tab sends for one new event; "queue-sync"
        // carries a whole queue and is still accepted from older SDK versions
        if (
          (data?.type !== "queue-add" && data?.type !== "queue-sync") ||
          !Array.isArray(data.events)
        ) {
          return;
        }
        this.queue = mergeQueues(this.queue, this.withoutDelivered(data.events as TrackEvent[]));
        this.queue = this.trimQueue();
      };
    }

    if (this.persistQueue && typeof window !== "undefined") {
      this.onStorageQueue = (e: StorageEvent) => {
        if (e.key !== QUEUE_KEY) return;
        this.loadAndMergeQueue();
      };
      window.addEventListener("storage", this.onStorageQueue);
    }
  }

  private startTimer() {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
    // a library timer must not keep a Node process alive on its own
    (this.timer as { unref?: () => void }).unref?.();
  }

  private setupBrowserExit() {
    const handler = () => {
      if (document.visibilityState === "hidden") {
        this.persistNow();
        void this.flush();
      }
    };

    const pageHide = () => {
      this.persistNow();
      void this.flush();
    };

    // `visibilitychange` only ever fires on `document`, never on `window` —
    // `pagehide` is the opposite, a `window`-only event.
    document.addEventListener("visibilitychange", handler);
    window.addEventListener("pagehide", pageHide);

    this.exitHandlers.push(() => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("pagehide", pageHide);
    });
  }

  private setupProcessExit() {
    type Proc = {
      pid?: number;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      once: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      listenerCount?: (event: string) => number;
      kill?: (pid: number, signal: string) => void;
    };
    const proc = (globalThis as { process?: Proc }).process;
    if (!proc?.on) return;

    // Flush the queue and nothing else: the app owns its own shutdown. We do
    // NOT re-raise the signal by default, because apps that use
    // `process.once` or NestJS shutdown hooks have already removed their
    // listener by now and a re-raise would kill them in the middle of their
    // graceful shutdown. Note that registering any handler cancels Node's
    // default "exit on SIGINT/SIGTERM": if the SDK is the only handler, the
    // app has to exit itself, or set `exitOnSignal: true`, which re-raises the
    // signal after the flush when nobody else is listening.
    const exitOnSignal = this.options.exitOnSignal === true;
    const onSignal = (signal: string) => () => {
      void this.shutdown().finally(() => {
        if (!exitOnSignal) return;
        proc.off?.(signal, handlers[signal]);
        const othersListening = (proc.listenerCount?.(signal) ?? 0) > 0;
        if (!othersListening && proc.kill && proc.pid !== undefined) {
          proc.kill(proc.pid, signal);
        }
      });
    };
    const handlers: Record<string, () => void> = {
      SIGINT: onSignal("SIGINT"),
      SIGTERM: onSignal("SIGTERM"),
    };

    // A script that tracks something and then simply ends: the (unref'd) timer
    // no longer keeps it alive, so deliver what is queued before it exits. Runs
    // once; the pending fetch keeps the loop alive until it settles.
    const onBeforeExit = () => {
      if (this.queue.length) void this.flush();
    };

    proc.once("SIGINT", handlers.SIGINT);
    proc.once("SIGTERM", handlers.SIGTERM);
    proc.once("beforeExit", onBeforeExit);

    this.exitHandlers.push(() => {
      proc.off?.("SIGINT", handlers.SIGINT);
      proc.off?.("SIGTERM", handlers.SIGTERM);
      proc.off?.("beforeExit", onBeforeExit);
    });
  }
}
