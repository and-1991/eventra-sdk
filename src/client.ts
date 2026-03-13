import {
  TrackerOptions,
  TrackEvent,
  SdkInfo,
} from "./types";

/* ---------------- Constants ---------------- */


declare const __SDK_VERSION__: string;
declare const __EVENTRA_ENDPOINT__: string | undefined;

const SDK_VERSION = __SDK_VERSION__;

const DEFAULTS = {
  endpoint: __EVENTRA_ENDPOINT__ ?? "",
  flushInterval: 2000,
  maxBatchSize: 50,
  maxQueueSize: 10_000,
  maxRetries: 3,
  retryBaseDelay: 300,
};

/* ---------------- Helpers ---------------- */

function getGlobalFetch(): typeof fetch | undefined {
  if (typeof fetch !== "undefined") {
    return fetch.bind(globalThis);
  }
  return undefined;
}

function generateUUIDv4(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  // ultra-rare fallback
  const rnd = Math.random().toString(16).slice(2);
  const ts = Date.now().toString(16);
  return `${ts}-${rnd}`;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- Leader Election (minimal) ---------------- */

const LEADER_KEY = "__eventra_sdk_leader__";
const LEADER_TTL = 4000;

function tryBecomeLeader(): boolean {
  if (!isBrowser()) return true;

  try {
    const now = Date.now();
    const raw = localStorage.getItem(LEADER_KEY);

    if (!raw) {
      localStorage.setItem(
        LEADER_KEY,
        JSON.stringify({ ts: now })
      );
      return true;
    }

    const parsed = JSON.parse(raw) as { ts: number };

    if (now - parsed.ts > LEADER_TTL) {
      localStorage.setItem(
        LEADER_KEY,
        JSON.stringify({ ts: now })
      );
      return true;
    }

    return false;
  } catch {
    return true; // fail-open
  }
}

/* ============================================================ */

export class Eventra {
  private apiKey: string;
  private endpoint: string;
  private flushInterval: number;
  private maxBatchSize: number;
  private maxQueueSize: number;
  private maxRetries: number;
  private retryBaseDelay: number;
  private multiTabMode: "independent" | "leader";

  private fetchImpl?: typeof fetch;
  private queue: TrackEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private destroyed = false;
  private droppedEvents = 0;

  private sdkInfo: SdkInfo;

  constructor(options: TrackerOptions) {
    if (!options.apiKey) {
      throw new Error("Eventra: apiKey is required");
    }

    this.apiKey = options.apiKey;

    this.endpoint = options.endpoint ?? DEFAULTS.endpoint ?? "";
    if (!this.endpoint) {
      throw new Error("Eventra: endpoint is not configured");
    }

    this.flushInterval =
      options.flushInterval ?? DEFAULTS.flushInterval;

    this.maxBatchSize =
      options.maxBatchSize ?? DEFAULTS.maxBatchSize;

    this.maxQueueSize =
      options.maxQueueSize ?? DEFAULTS.maxQueueSize;

    this.maxRetries =
      options.maxRetries ?? DEFAULTS.maxRetries;

    this.retryBaseDelay =
      options.retryBaseDelayMs ?? DEFAULTS.retryBaseDelay;

    this.multiTabMode =
      options.multiTabMode ?? "independent";

    this.fetchImpl =
      options.fetchImpl ?? getGlobalFetch();

    if (!this.fetchImpl) {
      throw new Error(
        "Eventra: fetch is not available. Provide fetchImpl."
      );
    }

    this.sdkInfo = {
      name: "@eventra_dev/eventra-sdk",
      version: SDK_VERSION,
      runtime: this.detectRuntime(),
    };

    if (!options.disableTimer) {
      this.startTimer();
    }

    if (options.autoFlushOnExit !== false) {
      this.setupExitHandlers();
    }

    this.onEventsDropped = options.onEventsDropped;
  }

  private onEventsDropped?: (count: number) => void;

  /* ---------------- Public API ---------------- */

  track(
    name: string,
    options?: {
      userId?: string;
      properties?: Record<string, unknown>;
    }
  ) {
    if (this.destroyed) return;

    if (this.queue.length >= this.maxQueueSize) {
      this.droppedEvents++;
      this.onEventsDropped?.(this.droppedEvents);
      return;
    }

    this.queue.push({
      idempotencyKey: generateUUIDv4(),
      name,
      userId: options?.userId,
      properties: options?.properties ?? {},
      timestamp: new Date().toISOString(),
    });

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.destroyed) return;
    if (this.inFlight) return;
    if (this.queue.length === 0) return;

    if (
      this.multiTabMode === "leader" &&
      !tryBecomeLeader()
    ) {
      return;
    }

    this.inFlight = true;

    const batch = this.queue.splice(0, this.queue.length);

    try {
      await this.send(batch);
    } catch {
      this.queue.unshift(...batch);
    } finally {
      this.inFlight = false;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------- Transport ---------------- */

  private trySendBeacon(payload: string): boolean {
    if (!isBrowser()) return false;

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], {
          type: "application/json",
        });
        return navigator.sendBeacon(this.endpoint, blob);
      }
    } catch {
      // ignore
    }

    return false;
  }

  private async send(events: TrackEvent[]) {
    const payload = JSON.stringify({
      sentAt: new Date().toISOString(),
      sdk: this.sdkInfo,
      events,
    });

    // beacon fast-path (browser only)
    if (
      isBrowser() &&
      payload.length < 60_000 &&
      document.visibilityState === "hidden"
    ) {
      if (this.trySendBeacon(payload)) return;
    }

    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl!(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: payload,
        });

        // ❗ DO NOT retry client errors
        if (res.status >= 400 && res.status < 500) {
          if (res.status === 401 || res.status === 403) {
            console.error("Eventra: Invalid API key");
          }
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        return;
      } catch (err) {
        attempt++;

        if (attempt > this.maxRetries) {
          throw err;
        }

        const jitter = 0.5 + Math.random(); // 0.5–1.5
        const delay =
          this.retryBaseDelay *
          2 ** (attempt - 1) *
          jitter;

        await sleep(delay);
      }
    }
  }

  /* ---------------- Runtime ---------------- */

  private detectRuntime(): string {
    if (typeof window !== "undefined") return "browser";

    const g = globalThis as Record<string, unknown>;

    if (g["Deno"]) return "deno";
    if (g["Bun"]) return "bun";

    const maybeProcess = g["process"] as
      | { versions?: { node?: string } }
      | undefined;

    if (maybeProcess?.versions?.node) return "node";

    return "unknown";
  }

  /* ---------------- Timer ---------------- */

  private startTimer() {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  /* ---------------- Exit handling ---------------- */

  private setupExitHandlers() {
    // browser
    if (typeof window !== "undefined") {
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          void this.flush();
        }
      });
    }

    // node
    const g = globalThis as Record<string, unknown>;

    const maybeProcess = g["process"] as
      | { once?: (event: string, cb: () => void) => void }
      | undefined;

    if (typeof maybeProcess?.once === "function") {
      const shutdown = async () => {
        try {
          await this.flush();
        } catch {}
      };

      maybeProcess.once("SIGINT", shutdown);
      maybeProcess.once("SIGTERM", shutdown);
      maybeProcess.once("beforeExit", shutdown);
    }
  }
}

export * from "./types";
