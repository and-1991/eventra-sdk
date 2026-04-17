import { TrackerOptions, TrackEvent, SdkInfo } from "./types";

// RUNTIME DETECTION
type Runtime = "browser" | "node" | "edge" | "serverless" | "unknown";

function detectRuntime(): Runtime {
  const g = globalThis as any;

  if (typeof window !== "undefined") return "browser";
  if (g.EdgeRuntime) return "edge";
  if (g.process?.env?.AWS_LAMBDA_FUNCTION_NAME) return "serverless";
  if (g.process?.versions?.node) return "node";

  return "unknown";
}

// HELPERS
function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function getFetch(): typeof fetch {
  if (typeof fetch !== "undefined") return fetch.bind(globalThis);
  throw new Error("fetch not available");
}

// SAFE STORAGE (browser only)
class Storage {
  private enabled = false;

  constructor() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("__t", "1");
        localStorage.removeItem("__t");
        this.enabled = true;
      }
    } catch {}
  }

  get(key: string): any {
    if (!this.enabled) return null;
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  set(key: string, value: any) {
    if (!this.enabled) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
}

// LEADER ELECTION (browser)
class Leader {
  private channel?: BroadcastChannel;
  private isLeader = true;

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("eventra");

      this.channel.onmessage = (e) => {
        if (e.data === "leader") {
          this.isLeader = false;
        }
      };

      this.channel.postMessage("leader");
    }
  }

  canSend() {
    return this.isLeader;
  }
}

// SDK
export class Eventra {
  private apiKey: string;
  private endpoint: string;
  private runtime: Runtime;
  private fetch = getFetch();

  private queue: TrackEvent[] = [];
  private inFlight = false;
  private destroyed = false;

  private maxBatch = 50;
  private maxQueue = 10000;
  private flushInterval = 2000;
  private retries = 3;
  private retryDelay = 300;

  private timer?: any;

  private storage = new Storage();
  private leader = new Leader();

  private failureCount = 0;
  private circuitOpenUntil = 0;

  private sdkInfo: SdkInfo;

  constructor(options: TrackerOptions) {
    if (!options.apiKey) throw new Error("apiKey required");

    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "";

    if (!this.endpoint) throw new Error("endpoint required");

    this.runtime = detectRuntime();

    this.maxBatch = options.maxBatchSize ?? this.maxBatch;
    this.maxQueue = options.maxQueueSize ?? this.maxQueue;
    this.flushInterval = options.flushInterval ?? this.flushInterval;

    this.sdkInfo = {
      name: "@eventra_dev/eventra-sdk",
      version: "ultra",
      runtime: this.runtime,
    };

    if (this.runtime === "browser") {
      const saved = this.storage.get("__eventra_q__");
      if (saved) this.queue = saved;

      this.startTimer();
      this.setupBrowserExit();
    }
  }

  // PUBLIC
  track(name: string, options?: any) {
    if (this.destroyed) return;

    const event: TrackEvent = {
      idempotencyKey: uuid(),
      name,
      userId: options?.userId,
      properties: options?.properties ?? {},
      timestamp: new Date().toISOString(),
    };

    // server environments → instant send
    if (this.runtime !== "browser") {
      void this.send([event]);
      return;
    }

    // browser → queue
    if (this.queue.length >= this.maxQueue) return;

    this.queue.push(event);
    this.persist();

    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    }
  }

  async flush() {
    if (this.inFlight || this.destroyed) return;
    if (!this.queue.length) return;

    if (!this.leader.canSend()) return;

    if (Date.now() < this.circuitOpenUntil) return;

    this.inFlight = true;

    const batch = this.queue.splice(0, this.maxBatch);
    this.persist();

    try {
      await this.send(batch);

      this.failureCount = 0;
    } catch {
      this.queue = [...batch, ...this.queue];
      this.persist();

      this.failureCount++;

      if (this.failureCount >= 5) {
        this.circuitOpenUntil = Date.now() + 5000;
      }
    } finally {
      this.inFlight = false;
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
  }

  // SEND (CORE)
  private async send(events: TrackEvent[]) {
    const payload = JSON.stringify({
      sentAt: new Date().toISOString(),
      sdk: this.sdkInfo,
      events,
    });

    // sendBeacon fast path
    if (
      this.runtime === "browser" &&
      typeof navigator !== "undefined" &&
      navigator.sendBeacon &&
      payload.length < 60000 &&
      document.visibilityState === "hidden"
    ) {
      navigator.sendBeacon(this.endpoint, payload);
      return;
    }

    let attempt = 0;

    while (attempt <= this.retries) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const res = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
          },
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.status >= 400 && res.status < 500) return;

        if (!res.ok) throw new Error();

        return;
      } catch {
        attempt++;

        if (attempt > this.retries) throw new Error();

        await sleep(this.retryDelay * 2 ** attempt);
      }
    }
  }

  // BROWSER
  private startTimer() {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  private setupBrowserExit() {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void this.flush();
      }
    });
  }

  private persist() {
    if (this.runtime !== "browser") return;
    this.storage.set("__eventra_q__", this.queue);
  }
}
