import { TrackerOptions, TrackEvent } from "./types";

const DEFAULT_ENDPOINT = "http://localhost:4000/api/ingest/batch";
const DEFAULT_FLUSH_INTERVAL = 2000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 300;

export class FeatureTracker {
  private apiKey: string;
  private endpoint: string;
  private flushInterval: number;
  private maxBatchSize: number;
  private maxQueueSize: number;
  private maxRetries: number;
  private retryBaseDelay: number;

  private fetchImpl?: typeof fetch;
  private queue: TrackEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private destroyed = false;

  constructor(options: TrackerOptions) {
    if (!options.apiKey) {
      throw new Error("FeatureTracker: apiKey is required");
    }

    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.flushInterval =
      options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.maxBatchSize =
      options.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    this.maxQueueSize =
      options.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.maxRetries =
      options.maxRetries ?? DEFAULT_RETRIES;
    this.retryBaseDelay =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_DELAY;

    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch !== "undefined"
        ? fetch.bind(globalThis)
        : undefined);

    if (!this.fetchImpl) {
      throw new Error(
        "FeatureTracker: fetch is not available. Provide fetchImpl."
      );
    }

    if (!options.disableTimer) {
      this.startTimer();
    }

    if (options.autoFlushOnExit !== false) {
      this.setupExitHandlers();
    }
  }

  /* ---------------- Public API ---------------- */

  track(
    name: string,
    options?: {
      userId?: string;
      properties?: Record<string, unknown>;
    }
  ) {
    if (this.destroyed) return;
    if (this.queue.length >= this.maxQueueSize) return;

    this.queue.push({
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

    this.inFlight = true;

    const batch = this.queue.splice(0, this.queue.length);

    try {
      await this.send(batch);
    } catch {
      // если ошибка — возвращаем события в очередь
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

  private async send(events: TrackEvent[]) {
    const payload = {
      sentAt: new Date().toISOString(),
      sdk: {
        name: "feature-tracker-js",
        version: "1.0.0",
        runtime: this.detectRuntime(),
      },
      events,
    };

    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl!(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey, // ВАЖНО: header обязателен
          },
          body: JSON.stringify(payload),
        });

        if (res.status === 401 || res.status === 403) {
          console.error("FeatureTracker: Invalid API key");
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

        const delay =
          this.retryBaseDelay * 2 ** (attempt - 1);

        await new Promise((r) =>
          setTimeout(r, delay)
        );
      }
    }
  }

  /* ---------------- Runtime ---------------- */

  private detectRuntime(): string {
    if (typeof window !== "undefined") {
      return "browser";
    }

    const g = globalThis as Record<string, unknown>;

    if (g["Deno"]) return "deno";
    if (g["Bun"]) return "bun";

    const maybeProcess = g["process"] as
      | { versions?: { node?: string } }
      | undefined;

    if (maybeProcess?.versions?.node) {
      return "node";
    }

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
    // Browser flush on tab hide
    if (typeof window !== "undefined") {
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          void this.flush();
        }
      });
    }

    // Node graceful shutdown (без @types/node)
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
