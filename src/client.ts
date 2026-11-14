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
// The most the queue may take in localStorage, in characters of JSON (browsers count the quota of about
// 5M per site in characters). The storage is shared with the host app, whose own writes must keep working:
// past this, only the newest events are written, the rest stay in the in-memory queue.
const PERSISTED_QUEUE_MAX_CHARS = 1_000_000;
// the most a keepalive request may carry: Chrome and Firefox refuse more than 64 KiB
const KEEPALIVE_MAX_BYTES = 60_000;
// Keys of events already delivered, remembered so a stale copy in
// localStorage or from another tab cannot put them back in the queue.
const DELIVERED_KEYS_MAX = 10_000;
// In the default `independent` mode every tab holds every tab's events (so the events of a tab that closes
// are not lost). An event another open tab just announced is left to that tab this long: it sends within
// its flush interval and tells the others it was delivered. Sent by everyone at once, each event went out
// once per open tab. Events read from storage (an earlier page, a closed tab) are sent at once, as before.
const LIVE_TAB_GRACE_MS = 15_000;
const LIVE_TAB_KEYS_MAX = 10_000;

let activeInstances = 0;

// ================= RUNTIME =================
type Runtime = "browser" | "node" | "edge" | "serverless" | "unknown";

function detectRuntime(): Runtime {
  const g = globalThis as typeof globalThis & {
    EdgeRuntime?: unknown;
    process?: { env?: Record<string, string>; versions?: { node?: string } };
  };

  if (g.EdgeRuntime) return "edge";
  if (hasBrowserEvents()) return "browser";
  if (g.process?.env?.AWS_LAMBDA_FUNCTION_NAME) return "serverless";
  if (g.process?.versions?.node) return "node";

  return "unknown";
}

/**
 * A global `window` alone does not make a browser: React Native defines `window` without `addEventListener`,
 * and Deno 1.x has `window` without `document`. The browser mode needs both event targets.
 */
function hasBrowserEvents(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window !== null &&
      typeof window.addEventListener === "function" &&
      typeof document !== "undefined" &&
      document !== null &&
      typeof document.addEventListener === "function"
    );
  } catch {
    return false;
  }
}

/** Adds a listener and returns how to remove it; a target without the API is skipped instead of throwing. */
function listen(target: unknown, type: string, listener: (e: never) => void): () => void {
  const t = target as {
    addEventListener?: (type: string, listener: unknown) => void;
    removeEventListener?: (type: string, listener: unknown) => void;
  } | null | undefined;
  try {
    // only called for the targets the browser runtime was detected by, so this is a last guard
    /* v8 ignore next */
    if (!t || typeof t.addEventListener !== "function") return () => undefined;
    t.addEventListener(type, listener);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      t.removeEventListener?.(type, listener);
    } catch {
      /* nothing to remove */
    }
  };
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

  // No Web Crypto (Node 18 without the global, odd runtimes): `track()` must
  // never throw, so fall back to a random v4-shaped id. The key only has to be
  // unique per event for server-side dedup, it is not a secret.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  let t = Date.now();
  for (let i = 0; i < 6; i++) {
    bytes[i] ^= t & 0xff;
    t = Math.floor(t / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MAX_TIMER_MS = 2_147_483_647;
// delivery attempts per batch: a billion would be a way to never give up, not a setting
const MAX_RETRIES = 20;
// the ingest API refuses a batch of more than 500 events with 400, which would drop the whole batch
const MAX_BATCH_SIZE = 500;

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function warnOption(name: string, value: unknown, fallback: unknown): void {
  if (typeof console !== "undefined") {
    console.warn(`Eventra: option "${name}" is invalid (${String(value)}), using ${String(fallback)}`);
  }
}

/**
 * A numeric option that must be a finite number of at least `min` (and at most `max`). Anything else
 * (NaN, a string, a negative number, Infinity) used to be accepted and silently stop delivery; it now
 * falls back to the default with one warning.
 */
function numberOption(name: string, value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  warnOption(name, value, fallback);
  return fallback;
}

/**
 * Runs a callback of the integrator. It must never break the SDK: a throw, or a rejected promise from an
 * async callback, is swallowed (the SDK keeps working and the batch is not retried because of it).
 */
function callSafely<A extends unknown[]>(callback: ((...args: A) => unknown) | undefined, ...args: A): void {
  if (!callback) return;
  try {
    const result = callback(...args);
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* an integrator's callback must not break delivery */
  }
}

/**
 * Rejects when `signal` aborts (it is fresh, not aborted yet) even if `fetch` itself ignores it: a custom `fetchImpl` that does not honour the
 * signal would otherwise hold the SDK forever, since the request deadline works only through the signal.
 */
function raceAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("Eventra: request timed out"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Only the status and headers are used: close the body so the connection is not held by a large unread reply. */
function discardBody(res: Response): void {
  try {
    const closing = res.body?.cancel?.();
    if (closing && typeof closing.catch === "function") closing.catch(() => undefined);
  } catch {
    /* a reply without a readable body is fine */
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// A cut must not leave half of a character outside the basic plane (an emoji, say): the server drops a lone
// surrogate, so the name or id it stores would differ from what was sent.
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = value.charCodeAt(max - 1) >= 0xd800 && value.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return value.slice(0, end);
}

/** A user id is a string; a number is written out, anything else (null, an object) means no user id. */
function normalizeUserId(value: unknown, max: number): string | undefined {
  if (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))) return cut(String(value), max);
  if (typeof value !== "string") return undefined;
  return cut(value, max);
}

/**
 * Never throws — `track()` is called fire-and-forget from arbitrary call sites,
 * so a malformed name must degrade gracefully instead of crashing the caller.
 * Returns `null` for an empty name (event should be dropped); otherwise trims
 * and truncates to `MAX_EVENT_NAME`, matching the documented behavior.
 */
// What the server removes from a name before storing it: NUL, CR, LF and half of a surrogate pair. Removed here
// first, so a name made only of those is dropped on its own instead of reaching the server empty, where it fails the
// whole batch with a 400. A loop, not a regex: lookbehind would be a syntax error in Safari before 16.4.
function stripUnsafeForName(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 0x0a || code === 0x0d) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}

function normalizeEventName(name: string): string | null {
  if (typeof name !== "string") return null;
  const trimmed = stripUnsafeForName(name).trim();
  if (!trimmed) return null;
  // trimmed again after the cut: the CLI catalog holds the name the same way, so a name cut in the middle of a
  // space is the same event in both
  return cut(trimmed, MAX_EVENT_NAME).trimEnd();
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

function isStoredEvent(e: unknown): e is TrackEvent {
  if (e === null || typeof e !== "object") return false;
  const ev = e as Partial<TrackEvent>;
  return (
    typeof ev.idempotencyKey === "string" &&
    ev.idempotencyKey.length > 0 &&
    ev.idempotencyKey.length <= 100 &&
    typeof ev.name === "string" &&
    ev.name.length > 0 &&
    ev.name.length <= MAX_EVENT_NAME &&
    typeof ev.timestamp === "string" &&
    (ev.userId === undefined || (typeof ev.userId === "string" && ev.userId.length <= MAX_USER_ID)) &&
    (ev.properties === undefined || (ev.properties !== null && typeof ev.properties === "object" && !Array.isArray(ev.properties)))
  );
}

function mergeQueues(...queues: TrackEvent[][]): TrackEvent[] {
  const seen = new Set<string>();
  const out: TrackEvent[] = [];

  for (const q of queues) {
    for (const e of q) {
      // storage and other tabs are untrusted input: skip anything that is not
      // an event instead of throwing out of the constructor
      if (!isStoredEvent(e)) continue;
      if (seen.has(e.idempotencyKey)) continue;
      seen.add(e.idempotencyKey);
      // an event whose time cannot be read is kept (its age cannot be judged), but it is not sent as it is: the
      // server would refuse it, and a 4xx drops the whole batch it is in
      out.push(Number.isNaN(Date.parse(e.timestamp)) ? { ...e, timestamp: new Date().toISOString() } : e);
    }
  }

  return out;
}

/** The newest events of the queue that fit in PERSISTED_QUEUE_MAX_CHARS, as a JSON array in queue order. */
function persistedQueueJson(queue: TrackEvent[]): string {
  const parts: string[] = [];
  let chars = 2; // the brackets
  for (let i = queue.length - 1; i >= 0; i--) {
    let json: string;
    try {
      json = JSON.stringify(queue[i]);
    } catch {
      continue;
    }
    const next = chars + json.length + (parts.length ? 1 : 0);
    if (next > PERSISTED_QUEUE_MAX_CHARS) break;
    parts.push(json);
    chars = next;
  }
  return `[${parts.reverse().join(",")}]`;
}

// The depth walk visits shared references again for each path, so a fan-out of shared objects would take
// time that grows with fanout^depth; past this many visits the properties are too large anyway.
const MAX_PROPERTIES_NODES = 50_000;

function validateProperties(
  properties: unknown,
): Record<string, unknown> {
  // Properties are an object of values: a number, a string, a list or null is not (it used to pass through as is).
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    // a Date, a Map, a Set, a RegExp: objects, but not a bag of named values
    Object.prototype.toString.call(properties) !== "[object Object]"
  ) {
    throw new Error("Eventra: properties must be an object");
  }
  // Own keys are listed once per object with Object.keys (what JSON.stringify sends). Listing the keys of an
  // object costs time for each of them whatever is used (V8 builds the whole list even for a `for...in` that
  // stops at once), so a huge object is listed only once and refused right after: past the node budget it could
  // never fit in MAX_PROPERTIES_JSON_BYTES anyway.
  const topKeys = Object.keys(properties as object);
  // Nothing to walk or measure for an empty object (the common case), but it is still copied: the caller
  // keeps its own object and may fill it in later.
  if (topKeys.length === 0) return {};

  let visited = 0;
  const depth = (obj: unknown, level: number, keys?: string[]): void => {
    if (level > MAX_PROPERTIES_DEPTH) {
      throw new Error(`Eventra: properties exceed max depth (${MAX_PROPERTIES_DEPTH})`);
    }
    if (++visited > MAX_PROPERTIES_NODES) {
      throw new Error("Eventra: properties are too large to check");
    }
    if (obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      if (visited + obj.length > MAX_PROPERTIES_NODES) {
        throw new Error("Eventra: properties are too large to check");
      }
      for (const item of obj) depth(item, level + 1);
      return;
    }
    const own = keys ?? Object.keys(obj);
    if (visited + own.length > MAX_PROPERTIES_NODES) {
      throw new Error("Eventra: properties are too large to check");
    }
    for (const key of own) depth((obj as Record<string, unknown>)[key], level + 1);
  };

  depth(properties, 0, topKeys);

  const json = JSON.stringify(properties);
  if (json === undefined || utf8ByteLength(json) > MAX_PROPERTIES_JSON_BYTES) {
    throw new Error(
      `Eventra: properties exceed max size (${MAX_PROPERTIES_JSON_BYTES} bytes)`,
    );
  }

  // Snapshot: the caller keeps its own object and may change it (even make it
  // circular) before the event is sent. What was validated is what is sent.
  const copy: unknown = JSON.parse(json);
  // an object with a toJSON() can serialize to something that is not an object
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
    throw new Error("Eventra: properties must be an object");
  }
  return copy as Record<string, unknown>;
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

// the SDK was destroyed between two attempts: stop retrying, the batch is neither failed nor delivered
class DeliveryStopped extends Error {
  constructor() {
    super("delivery stopped by destroy()");
    this.name = "DeliveryStopped";
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

  // localStorage works here (not in Node, a blocked or private-mode browser)
  get isEnabled(): boolean {
    return this.enabled;
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
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      // only the diagnostics counters are written here, plain numbers and strings
      /* v8 ignore next */
      return;
    }
    this.setRaw(key, json);
  }

  setRaw(key: string, json: string) {
    if (!this.enabled) return;
    try {
      localStorage.setItem(key, json);
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
/** Whether `localStorage` can be used at all: in a sandboxed iframe even looking at it throws a SecurityError. */
function storageAvailable(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch {
    return false;
  }
}

class Leader {
  private tabId = uuidV4();
  private isLeader = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private election?: ReturnType<typeof setInterval>;
  private offStorage?: () => void;

  constructor(private onLeadershipChange?: (isLeader: boolean) => void) {
    if (!storageAvailable()) {
      this.isLeader = true;
      return;
    }

    this.tick();

    this.election = setInterval(() => this.tick(), LEADER_TTL_MS / 2);

    // Leader is only constructed in the browser runtime, so `window` exists; listen() still never throws
    /* v8 ignore next */
    this.offStorage = listen(typeof window !== "undefined" ? window : undefined, "storage", (e: StorageEvent) => {
      if (e.key === LEADER_KEY) this.tick();
    });
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
    this.offStorage?.();
    if (this.isLeader && storageAvailable()) {
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
// The key is sent with every batch, so a plain http endpoint exposes it on the
// network. Not an error (an internal http collector is a legitimate setup);
// loopback is exempt.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function warnIfInsecureEndpoint(endpoint: string): void {
  if (typeof console === "undefined") return;
  try {
    const url = new URL(endpoint);
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      console.warn(
        "Eventra: endpoint uses plain http, the API key is sent unencrypted - use https",
      );
    }
  } catch {
    /* a relative or malformed endpoint is left for fetch to reject */
  }
}

// fetch with `redirect: "error"` rejects with a TypeError whose cause says so
// (undici: "unexpected redirect"). A browser only reports "Failed to fetch", so
// there a redirect cannot be told from any other network failure.
function isRedirectError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if (/redirect/i.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export class Eventra {
  private apiKey: string;
  private endpoint: string;
  private runtime: Runtime;
  private fetch: typeof fetch;

  private queue: TrackEvent[] = [];
  private sending: TrackEvent[] | null = null;
  // events other open tabs announced on the channel, by key, and until when they are theirs to send
  private liveTabEvents = new Map<string, number>();
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
  private offStorageQueue?: () => void;

  private failureCount = 0;
  private warnedRedirect = false;
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
  private shutdownBudget = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  private shutdownPromise?: Promise<void>;
  // the page is being left (`pagehide`)
  private leaving = false;

  private sdkInfo: SdkInfo;
  private options: TrackerOptions;

  private exitHandlers: Array<() => void> = [];

  constructor(options: TrackerOptions) {
    if (!options || typeof options !== "object" || typeof options.apiKey !== "string" || !options.apiKey) {
      throw new Error("Eventra: apiKey required - new Eventra({ apiKey: \"...\" })");
    }
    // the key travels in an HTTP header: a character outside Latin-1 makes every request fail, and nothing says why
    if (/[^\u0020-\u00ff]/.test(options.apiKey)) {
      throw new Error("Eventra: apiKey has characters that cannot be sent in a header - copy it again from the dashboard");
    }
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") {
      throw new Error("Eventra: fetchImpl must be a function");
    }

    activeInstances++;
    if (activeInstances > 1 && typeof console !== "undefined") {
      console.warn(
        "Eventra: multiple SDK instances detected - duplicate timers and sends are possible",
      );
    }

    try {
      this.options = options;
      this.apiKey = options.apiKey;
      if (options.endpoint !== undefined && (typeof options.endpoint !== "string" || !options.endpoint.trim())) {
        warnOption("endpoint", options.endpoint, DEFAULT_ENDPOINT);
      }
      this.endpoint =
        typeof options.endpoint === "string" && options.endpoint.trim() ? options.endpoint.trim() : DEFAULT_ENDPOINT;
      if (this.endpoint !== DEFAULT_ENDPOINT && !isUrl(this.endpoint)) {
        warnOption("endpoint", this.endpoint, DEFAULT_ENDPOINT);
        this.endpoint = DEFAULT_ENDPOINT;
      }
      if (options.multiTabMode !== undefined && options.multiTabMode !== "independent" && options.multiTabMode !== "leader") {
        warnOption("multiTabMode", options.multiTabMode, "independent");
      }
      if (options.diagnostics !== undefined && typeof options.diagnostics !== "boolean") {
        warnOption("diagnostics", options.diagnostics, "true");
      }
      for (const name of ["maxBatchSize", "maxQueueSize"] as const) {
        const value = options[name];
        if (typeof value === "number" && Number.isFinite(value) && value >= 1 && !Number.isInteger(value)) {
          warnOption(name, value, Math.floor(value));
        }
      }
      this.runtime = detectRuntime();
      warnIfInsecureEndpoint(this.endpoint);

      this.fetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
      if (!this.fetch) {
        throw new Error("Eventra: fetch not available - provide fetchImpl");
      }

      if (typeof options.maxBatchSize === "number" && options.maxBatchSize > MAX_BATCH_SIZE && Number.isFinite(options.maxBatchSize)) {
        warnOption("maxBatchSize", options.maxBatchSize, MAX_BATCH_SIZE);
      }
      this.maxBatch = Math.min(MAX_BATCH_SIZE, Math.floor(numberOption("maxBatchSize", options.maxBatchSize, 50, 1)));
      this.maxQueue = Math.floor(numberOption("maxQueueSize", options.maxQueueSize, 10000, 1));
      this.maxPayloadBytes = numberOption("maxPayloadBytes", options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 1);
      this.flushInterval = numberOption("flushInterval", options.flushInterval, 2000, 1, MAX_TIMER_MS);
      this.retries = numberOption("maxRetries", options.maxRetries, 3, 0, MAX_RETRIES);
      this.retryDelay = numberOption("retryBaseDelayMs", options.retryBaseDelayMs, 300, 0);
      this.shutdownBudget = numberOption("shutdownTimeoutMs", options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 0);
      // Queued events may carry userId/properties - default on for durability
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
          if (isLeader) void this.flushNow(false);
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

      // the key must not show in `console.log(tracker)`, `util.inspect` or `JSON.stringify(tracker)`
      Object.defineProperty(this, "apiKey", { enumerable: false });
      Object.defineProperty(this, "options", { enumerable: false });
    } catch (error) {
      // a constructor that fails must leave nothing behind: not a counted instance, not an open channel,
      // not a timer or a listener (a BroadcastChannel keeps a Node process alive for good)
      this.destroyed = true;
      activeInstances = Math.max(0, activeInstances - 1);
      for (const undo of [
        () => clearInterval(this.timer),
        () => this.leader?.destroy(),
        () => this.channel?.close(),
        () => this.exitHandlers.forEach((undoHandler) => undoHandler()),
      ]) {
        try {
          undo();
        } catch {
          /* nothing more to undo */
        }
      }
      throw error;
    }
  }

  track(name: string, options?: TrackOptions) {
    // `track()` is called fire-and-forget from anywhere: nothing it meets (a userId getter that throws, a
    // crypto that throws) may come out of it
    try {
      this.trackEvent(name, options);
    } catch {
      this.recordDiagnostic("invalid_event");
      callSafely(this.options.onEventsDropped, 1);
    }
  }

  private trackEvent(name: string, options?: TrackOptions) {
    if (this.destroyed || this.shuttingDown) return;

    const eventName = normalizeEventName(name);
    if (eventName === null) {
      this.recordDiagnostic("invalid_event");
      callSafely(this.options.onEventsDropped, 1);
      return;
    }

    let properties: Record<string, unknown>;
    try {
      properties = validateProperties(options?.properties ?? {});
    } catch {
      // Oversized/too-deep properties can't be safely truncated — drop the
      // event instead of throwing out of a fire-and-forget call site.
      this.recordDiagnostic("invalid_event");
      callSafely(this.options.onEventsDropped, 1);
      return;
    }

    if (this.queue.length >= this.maxQueue) {
      this.recordDiagnostic("queue_full");
      callSafely(this.options.onEventsDropped, 1);
      return;
    }

    const event: TrackEvent = {
      idempotencyKey: uuidV4(),
      name: eventName,
      userId: normalizeUserId(options?.userId, MAX_USER_ID),
      properties,
      timestamp: new Date().toISOString(),
    };

    this.queue.push(event);

    if (this.runtime === "browser") {
      this.schedulePersist();
      this.broadcast({ type: "queue-add", events: [event] });
    }

    // fire-and-forget triggers start a flush when none is running; one that is running picks the new event up
    // itself (a flush() of the app, by contrast, waits for it and then sends what is left)
    if (this.queue.length >= this.maxBatch) {
      void this.flushNow(false);
    }

    if (this.runtime === "serverless") {
      void this.flushNow(false);
    }
  }

  async flush(): Promise<void> {
    // A flush already running (timer, size trigger, serverless auto-flush) must
    // be awaited, otherwise `await flush()` resolves while events are in flight
    // and a serverless handler can freeze before they are delivered.
    if (this.flushPromise) await this.flushPromise.catch(() => undefined);
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
      while (this.queue.length > 0 && !this.destroyed) {
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
  shutdown(): Promise<void> {
    // a second call (the app's own, after a signal handler started it) waits for the first instead of
    // returning at once, so `await shutdown()` followed by `process.exit()` does not lose the queue
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.shuttingDown = true;

    const budget = this.shutdownBudget;
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

    // Without storage the queue goes with this instance (Node, where a saved queue is never read back,
    // `persistQueue: false`, or a browser that refuses localStorage): say how many events that is, as
    // for every other drop. A batch still in flight is not counted, its request may yet arrive.
    // (shutdown() with the circuit breaker open used to drop them without a word.)
    const kept = this.runtime === "browser" && this.persistQueue && this.storage.isEnabled;
    if (!kept) {
      const inFlight = new Set(this.sending ?? []);
      const lost = this.queue.filter((event) => !inFlight.has(event)).length;
      if (lost > 0) callSafely(this.options.onEventsDropped, lost);
    }

    this.leader?.destroy();

    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        /* a channel that cannot be closed must not skip the rest of the teardown */
      }
      this.channel = undefined;
    }

    this.offStorageQueue?.();

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
      if (this.leftToItsTab(event)) {
        index++;
        continue;
      }
      let eventJson: string;
      try {
        eventJson = JSON.stringify(event);
      } catch {
        // cannot be serialized, so it can never be sent: drop it, do not let it
        // wedge the queue
        this.dropPoisonEvent(event);
        continue;
      }
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
    callSafely(this.options.onEventsDropped, 1);
    callSafely(this.options.onDeliveryFailed, { status: 413, events: [event] });
  }

  private removeDelivered(batch: TrackEvent[]) {
    const keys = new Set(batch.map((e) => e.idempotencyKey));
    // a delivered batch is nearly always the start of the queue: cut it off instead of testing every event
    // (filtering each batch made draining a large queue quadratic: 300,000 events blocked the loop for minutes)
    const head = batch.length <= this.queue.length && batch.every((event, index) => this.queue[index] === event);
    this.queue = head ? this.queue.slice(batch.length) : this.queue.filter((e) => !keys.has(e.idempotencyKey));

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
      (document.visibilityState === "hidden" || this.leaving) &&
      // browsers refuse a keepalive body above 64 KiB (the whole request fails), whatever maxPayloadBytes allows
      payloadBytes <= Math.min(this.maxPayloadBytes, KEEPALIVE_MAX_BYTES);

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
        const res = await raceAbort(
          this.fetch(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.apiKey,
            },
            body: payload,
            signal: controller.signal,
            keepalive: useKeepalive,
            // never follow a redirect: x-api-key is a custom header, so fetch
            // would forward it to wherever a compromised or misconfigured
            // endpoint points
            redirect: "error",
          }),
          controller.signal,
        );
        discardBody(res);

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
          // a copy: a callback that empties the array it is given must not empty the batch the SDK is working on
          callSafely(this.options.onDeliveryFailed, { status: res.status, events: [...events] });
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
        if (!this.warnedRedirect && isRedirectError(err) && typeof console !== "undefined") {
          this.warnedRedirect = true;
          console.warn(
            "Eventra: the endpoint answered with a redirect. It is not followed, so the API key is not forwarded, and events stay queued - check the endpoint URL (for example http instead of https)",
          );
        }
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
        // destroy() during the wait: no more attempts (they used to go on after it)
        if (this.destroyed) throw new DeliveryStopped();
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
    return events.filter((e) => !this.deliveredKeys.has(e?.idempotencyKey));
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
    this.storage.setRaw(QUEUE_KEY, persistedQueueJson(this.queue));
  }

  private trimQueue(queue: TrackEvent[] = this.queue): TrackEvent[] {
    if (queue.length <= this.maxQueue) return queue;
    const removed = queue.slice(0, queue.length - this.maxQueue);
    // every open tab holds every tab's events and trims the same ones: an event another open tab announced
    // is that tab's to count, so a dropped event is reported once, not once per open tab
    const dropped = removed.filter((e) => !this.liveTabEvents.has(e?.idempotencyKey)).length;
    if (dropped > 0) {
      this.recordDiagnostic("queue_full", dropped);
      callSafely(this.options.onEventsDropped, dropped);
    }
    return queue.slice(-this.maxQueue);
  }

  // events another open tab just announced on the channel, with the time until which that tab sends them
  private rememberLiveTabEvents(events: TrackEvent[]) {
    const until = Date.now() + LIVE_TAB_GRACE_MS;
    for (const event of events) {
      const key = event?.idempotencyKey;
      if (typeof key === "string" && !this.liveTabEvents.has(key)) this.liveTabEvents.set(key, until);
    }
    // Map iterates in insertion order: the oldest keys go first
    for (const key of this.liveTabEvents.keys()) {
      if (this.liveTabEvents.size <= LIVE_TAB_KEYS_MAX) break;
      this.liveTabEvents.delete(key);
    }
  }

  // In `independent` mode, an event another open tab announced less than LIVE_TAB_GRACE_MS ago is that
  // tab's to send. After that (the tab was closed, or it cannot reach the server either) anyone sends it.
  // The leader in `leader` mode sends everything, so it never waits.
  private leftToItsTab(event: TrackEvent): boolean {
    if (this.leader) return false;
    const until = this.liveTabEvents.get(event?.idempotencyKey);
    return until !== undefined && Date.now() < until;
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
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
      } catch {
        // a browser or a sandbox that refuses the channel: tabs just do not share events
        this.channel = undefined;
      }
    }
    if (this.channel) {
      this.channel.onmessage = (e: MessageEvent) => {
        const data = e.data;

        if (data?.type === "delivered" && Array.isArray(data.keys)) {
          const keys = new Set<string>(data.keys as string[]);
          this.rememberDelivered(keys);
          for (const key of keys) this.liveTabEvents.delete(key);
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
        const announced = this.withoutDelivered(data.events as TrackEvent[]);
        this.rememberLiveTabEvents(announced);
        this.queue = mergeQueues(this.queue, announced);
        this.queue = this.trimQueue();
      };
    }

    if (this.persistQueue && typeof window !== "undefined") {
      this.offStorageQueue = listen(window, "storage", (e: StorageEvent) => {
        if (e.key !== QUEUE_KEY) return;
        this.loadAndMergeQueue();
      });
    }
  }

  private startTimer() {
    this.timer = setInterval(() => {
      void this.flushNow(false);
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
      // `pagehide` can fire while the page still counts as visible (a navigation, a closed tab): the request
      // must outlive the page all the same
      this.leaving = true;
      this.persistNow();
      if (this.inFlight) {
        // flush() would wait for the request in flight, which the browser cancels on unload, so the keepalive
        // send would never start
        this.sendOnLeave();
      } else {
        void this.flush();
      }
    };

    // a page restored from the back/forward cache is not being left any more: later sends are normal requests
    const pageShow = () => {
      this.leaving = false;
    };

    // `visibilitychange` only ever fires on `document`, never on `window` -
    // `pagehide` and `pageshow` are the opposite, `window`-only events.
    const offs = [
      listen(document, "visibilitychange", handler),
      listen(window, "pagehide", pageHide),
      listen(window, "pageshow", pageShow),
    ];

    this.exitHandlers.push(() => offs.forEach((off) => off()));
  }

  /**
   * The page is being left while a request is in flight: send what is queued at once with keepalive, without
   * waiting for that request. The events of the batch in flight go along too (after the others, as far as the
   * keepalive size allows), since the browser cancels that request on unload; if it did arrive, the server
   * drops the copies by their idempotencyKey. The queue is not changed unless the reply is seen.
   */
  private sendOnLeave() {
    // a tab that lost leadership while its request was in flight leaves the sending to the new leader
    if (this.leader && !this.leader.canSend()) return;

    // `sending` is set whenever a flush is in flight and the page can see it
    /* v8 ignore next */
    const inFlightKeys = new Set((this.sending ?? []).map((e) => e.idempotencyKey));
    const candidates = [
      ...this.queue.filter((e) => !inFlightKeys.has(e.idempotencyKey)),
      ...this.queue.filter((e) => inFlightKeys.has(e.idempotencyKey)),
    ];

    const limit = Math.min(this.maxPayloadBytes, KEEPALIVE_MAX_BYTES);
    const sentAt = new Date().toISOString();
    let bytes = utf8ByteLength(JSON.stringify({ sentAt, sdk: this.sdkInfo, events: [] }));
    const events: TrackEvent[] = [];
    const json: string[] = [];
    for (const event of candidates) {
      // the server's limit per batch; the keepalive size limit is normally reached first
      /* v8 ignore next */
      if (events.length >= MAX_BATCH_SIZE) break;
      let eventJson: string;
      try {
        eventJson = JSON.stringify(event);
      } catch {
        continue;
      }
      const total = bytes + utf8ByteLength(eventJson) + (events.length ? 1 : 0);
      // a smaller event further on may still fit
      if (total > limit) continue;
      events.push(event);
      json.push(eventJson);
      bytes = total;
    }
    if (!events.length) return;

    const head = JSON.stringify({ sentAt, sdk: this.sdkInfo });
    const body = `${head.slice(0, -1)},"events":[${json.join(",")}]}`;
    try {
      const request = this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body,
        keepalive: true,
        redirect: "error",
      });
      Promise.resolve(request).then(
        (res) => {
          discardBody(res);
          // seen only when the page stays (a bfcache restore): what was accepted is not sent again
          if (res.ok && !this.destroyed) this.removeDelivered(events);
        },
        () => undefined,
      );
    } catch {
      /* the events stay queued (and in localStorage) for the next visit */
    }
  }

  private setupProcessExit() {
    type Proc = {
      pid?: number;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      once: (event: string, listener: (...args: unknown[]) => void) => void;
      prependOnceListener?: (event: string, listener: (...args: unknown[]) => void) => void;
      exit?: (code?: number) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      listenerCount?: (event: string) => number;
      kill?: (pid: number, signal: string) => void;
    };
    const proc = (globalThis as { process?: Proc }).process;
    if (!proc?.on) return;

    // Registering any handler cancels Node's default "exit on SIGINT/SIGTERM". So by default the SDK behaves
    // like that default: when nobody else listens to the signal, it flushes (bounded by shutdownTimeoutMs) and
    // then re-raises the signal so the process ends as it would have without the SDK. When the app has its own
    // listener, the SDK only flushes and the app owns its shutdown. Whether others listen is decided when the
    // signal arrives, not after the flush: an app that uses `process.once` or NestJS shutdown hooks removes its
    // listener while it shuts down, and a re-raise then would cut that shutdown off. The SDK's own listener is
    // put first, so at that moment every other listener is still registered. `exitOnSignal: false` turns the
    // re-raise off (flush only).
    const exitOnSignal = this.options.exitOnSignal !== false;
    const onSignal = (signal: string) => () => {
      // a once-listener has removed itself already when emitted; removing it here too makes the count below
      // everyone else whichever way this handler was called
      proc.off?.(signal, handlers[signal]);
      const othersAtSignal = (proc.listenerCount?.(signal) ?? 0) > 0;
      void this.shutdown().finally(() => {
        if (!exitOnSignal || othersAtSignal) return;
        const othersListening = (proc.listenerCount?.(signal) ?? 0) > 0;
        if (othersListening) return;
        if (proc.pid === 1 && proc.exit) {
          // PID 1 (a container without an init) ignores a signal it has no handler for, so a re-raise would do
          // nothing: exit with the code the signal would have given
          proc.exit(128 + (signal === "SIGINT" ? 2 : 15));
          return;
        }
        if (proc.kill && proc.pid !== undefined) {
          proc.kill(proc.pid, signal);
        }
      });
    };
    // first in line, so the check above still sees every other listener (see the note above)
    const listenFirst = (event: string, listener: () => void) =>
      typeof proc.prependOnceListener === "function"
        ? proc.prependOnceListener(event, listener)
        : proc.once(event, listener);
    const handlers: Record<string, () => void> = {
      SIGINT: onSignal("SIGINT"),
      SIGTERM: onSignal("SIGTERM"),
    };

    // A script that tracks something and then simply ends: the (unref'd) timer
    // no longer keeps it alive, so deliver what is queued before it exits. The
    // pending fetch keeps the loop alive until it settles.
    const listenAgain = () => {
      if (!this.destroyed) proc.once("beforeExit", onBeforeExit);
    };
    const onBeforeExit = () => {
      if (!this.queue.length) {
        // `beforeExit` fires each time the loop drains, and a script can track more events after this
        // one: keep listening
        listenAgain();
        return;
      }
      // The process is ending: bound the flush like shutdown() does, so a hanging server or a long
      // Retry-After cannot keep it alive for a minute. The deadline is lifted again afterwards in case
      // the app schedules more work after the loop drained.
      const own = this.shutdownDeadline === 0;
      if (own) this.shutdownDeadline = Date.now() + this.shutdownBudget;
      void this.flush().finally(() => {
        // the limit stays while events are still queued: a flush the timer starts later must not run without it
        // and hold the process while the server keeps failing
        if (own && !this.shuttingDown && !this.queue.length) this.shutdownDeadline = 0;
        // Only after a flush that delivered everything. When events are still queued the server is not
        // taking them: trying again on every drain would keep the process alive for as long as it fails.
        if (!this.queue.length) listenAgain();
      });
    };

    listenFirst("SIGINT", handlers.SIGINT);
    listenFirst("SIGTERM", handlers.SIGTERM);
    proc.once("beforeExit", onBeforeExit);

    this.exitHandlers.push(() => {
      proc.off?.("SIGINT", handlers.SIGINT);
      proc.off?.("SIGTERM", handlers.SIGTERM);
      proc.off?.("beforeExit", onBeforeExit);
    });
  }
}
