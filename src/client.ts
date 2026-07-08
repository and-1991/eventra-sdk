import { TrackerOptions, TrackEvent, SdkInfo, TrackOptions } from "./types";

declare const __SDK_VERSION__: string | undefined;
declare const __EVENTRA_ENDPOINT__: string | undefined;

const SDK_NAME = "@eventra_dev/eventra-sdk";
const DEFAULT_ENDPOINT =
  (typeof __EVENTRA_ENDPOINT__ !== "undefined" && __EVENTRA_ENDPOINT__) ||
  "https://api.eventra.dev/api/v1/ingest/batch";
const SDK_VERSION =
  (typeof __SDK_VERSION__ !== "undefined" && __SDK_VERSION__) || "0.0.0-dev";

const LEADER_KEY = "__eventra_leader__";
const LEADER_TTL_MS = 4000;
const QUEUE_KEY = "__eventra_q__";
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
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_EVENT_NAME ? trimmed.slice(0, MAX_EVENT_NAME) : trimmed;
}

function backoffMs(attempt: number, base: number): number {
  const exp = Math.min(DEFAULT_MAX_RETRY_DELAY_MS, base * 2 ** attempt);
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return jitter;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
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

function estimateEnvelopeBytes(
  events: TrackEvent[],
  sdk: SdkInfo,
  sentAt: string,
): number {
  return utf8ByteLength(
    JSON.stringify({
      sentAt,
      sdk,
      events,
    }),
  );
}

class RetryableDeliveryError extends Error {
  constructor(message = "retryable delivery error") {
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

  remove(key: string) {
    if (!this.enabled) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
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

  private timer?: ReturnType<typeof setInterval>;

  private storage = new Storage();
  private leader: Leader | null = null;
  private channel?: BroadcastChannel;
  private onStorageQueue?: (e: StorageEvent) => void;

  private failureCount = 0;
  private circuitOpenUntil = 0;
  private circuitHalfOpen = false;

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

    this.fetch = options.fetchImpl ?? globalThis.fetch;
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
      this.options.onEventsDropped?.(1);
      return;
    }

    let properties: Record<string, unknown>;
    try {
      properties = validateProperties(options?.properties ?? {});
    } catch {
      // Oversized/too-deep properties can't be safely truncated — drop the
      // event instead of throwing out of a fire-and-forget call site.
      this.options.onEventsDropped?.(1);
      return;
    }

    if (this.queue.length >= this.maxQueue) {
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
      this.syncQueue();
    }

    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    }

    if (this.runtime === "serverless") {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.inFlight || this.destroyed) return;
    if (!this.queue.length && !this.sending?.length) return;

    if (this.leader && !this.leader.canSend()) return;

    const now = Date.now();
    if (now < this.circuitOpenUntil) return;

    if (this.circuitOpenUntil > 0 && now >= this.circuitOpenUntil) {
      this.circuitHalfOpen = true;
      this.circuitOpenUntil = 0;
    }

    this.inFlight = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.buildBatch();
        if (!batch.length) break;

        this.sending = batch;

        try {
          await this.send(batch);
          this.removeDelivered(batch);
          this.failureCount = 0;
          this.circuitHalfOpen = false;
        } catch (err) {
          if (err instanceof RetryableDeliveryError) {
            this.failureCount++;
            if (this.circuitHalfOpen || this.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
              this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
              this.circuitHalfOpen = false;
            }
            break;
          }
          break;
        } finally {
          this.sending = null;
        }

        if (this.circuitOpenUntil > Date.now()) break;
      }

      if (this.runtime === "browser") {
        this.syncQueue();
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Flush pending events, then tear down timers and listeners */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await this.flush();
    } finally {
      this.destroy();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    activeInstances = Math.max(0, activeInstances - 1);

    if (this.timer) clearInterval(this.timer);

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

  private buildBatch(): TrackEvent[] {
    const batch: TrackEvent[] = [];
    const sentAt = new Date().toISOString();
    let index = 0;

    while (index < this.queue.length && batch.length < this.maxBatch) {
      const event = this.queue[index];
      const candidate = [...batch, event];
      const bytes = estimateEnvelopeBytes(candidate, this.sdkInfo, sentAt);

      if (bytes > this.maxPayloadBytes) {
        if (batch.length === 0) {
          const poisonKey = event.idempotencyKey;
          this.dropPoisonEvent(event);
          if (this.queue[index]?.idempotencyKey === poisonKey) {
            index++;
          }
          continue;
        }
        break;
      }

      batch.push(event);
      index++;
    }

    return batch;
  }

  private dropPoisonEvent(event: TrackEvent) {
    this.removeDelivered([event]);
    this.options.onEventsDropped?.(1);
    this.options.onDeliveryFailed?.({ status: 413, events: [event] });

    if (this.runtime === "browser") {
      this.syncQueue();
    }
  }

  private removeDelivered(batch: TrackEvent[]) {
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    this.queue = this.queue.filter((e) => !keys.has(e.idempotencyKey));
  }

  private async send(events: TrackEvent[]) {
    let payload: string;
    try {
      payload = JSON.stringify({
        sentAt: new Date().toISOString(),
        sdk: this.sdkInfo,
        events,
      });
    } catch {
      this.options.onDeliveryFailed?.({ status: 0, events });
      this.removeDelivered(events);
      return;
    }

    const payloadBytes = utf8ByteLength(payload);
    if (payloadBytes > this.maxPayloadBytes) {
      this.dropPoisonEvents(events);
      return;
    }

    const useKeepalive =
      this.runtime === "browser" &&
      typeof document !== "undefined" &&
      document.visibilityState === "hidden" &&
      payloadBytes <= this.maxPayloadBytes;

    const maxAttempts = Math.max(1, this.retries);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

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
          throw new RetryableDeliveryError();
        }

        if (res.status >= 400 && res.status < 500) {
          this.options.onDeliveryFailed?.({ status: res.status, events });
          this.removeDelivered(events);
          return;
        }

        if (!res.ok) {
          throw new RetryableDeliveryError();
        }

        return;
      } catch (err) {
        const isLast = attempt >= maxAttempts - 1;

        if (isLast) {
          throw err instanceof RetryableDeliveryError
            ? err
            : new RetryableDeliveryError();
        }

        await sleep(backoffMs(attempt + 1, this.retryDelay));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private dropPoisonEvents(events: TrackEvent[]) {
    for (const event of events) {
      this.dropPoisonEvent(event);
    }
  }

  private loadAndMergeQueue() {
    const remote = this.storage.get(QUEUE_KEY);
    if (Array.isArray(remote)) {
      this.queue = mergeQueues(this.queue, remote as TrackEvent[]);
    }
    this.trimQueue();
  }

  private syncQueue() {
    if (this.persistQueue) {
      const remote = this.storage.get(QUEUE_KEY);
      const merged = mergeQueues(
        Array.isArray(remote) ? (remote as TrackEvent[]) : [],
        this.queue,
      );
      this.queue = this.trimQueue(merged);
      this.storage.set(QUEUE_KEY, this.queue);
    } else {
      this.queue = this.trimQueue();
    }
    this.broadcastQueue();
  }

  private trimQueue(queue: TrackEvent[] = this.queue): TrackEvent[] {
    if (queue.length <= this.maxQueue) return queue;
    const dropped = queue.length - this.maxQueue;
    this.options.onEventsDropped?.(dropped);
    return queue.slice(-this.maxQueue);
  }

  private broadcastQueue() {
    try {
      this.channel?.postMessage({
        type: "queue-sync",
        events: this.queue,
      });
    } catch {
      /* ignore */
    }
  }

  private setupQueueSync() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (e: MessageEvent) => {
        if (e.data?.type !== "queue-sync" || !Array.isArray(e.data.events)) return;
        this.queue = mergeQueues(this.queue, e.data.events as TrackEvent[]);
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
  }

  private setupBrowserExit() {
    const handler = () => {
      if (document.visibilityState === "hidden") {
        void this.flush();
      }
    };

    const pageHide = () => {
      void this.flush();
    };

    window.addEventListener("visibilitychange", handler);
    window.addEventListener("pagehide", pageHide);

    this.exitHandlers.push(() => {
      window.removeEventListener("visibilitychange", handler);
      window.removeEventListener("pagehide", pageHide);
    });
  }

  private setupProcessExit() {
    const proc = (
      globalThis as {
        process?: {
          on: (event: string, listener: (...args: unknown[]) => void) => void;
          once: (event: string, listener: (...args: unknown[]) => void) => void;
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
      }
    ).process;
    if (!proc?.on) return;

    const onSignal = () => {
      void this.shutdown();
    };

    proc.once("SIGINT", onSignal);
    proc.once("SIGTERM", onSignal);

    this.exitHandlers.push(() => {
      proc.off?.("SIGINT", onSignal);
      proc.off?.("SIGTERM", onSignal);
    });
  }
}
