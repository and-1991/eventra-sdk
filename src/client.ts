import { TrackerOptions, TrackEvent, SdkInfo } from "./types";

// ================= RUNTIME =================
type Runtime = "browser" | "node" | "edge" | "serverless" | "unknown";

function detectRuntime(): Runtime {
  const g = globalThis as any;

  if (typeof window !== "undefined") return "browser";
  if (g.EdgeRuntime) return "edge";
  if (g.process?.env?.AWS_LAMBDA_FUNCTION_NAME) return "serverless";
  if (g.process?.versions?.node) return "node";

  return "unknown";
}

// ================= HELPERS =================
function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

// ================= LEADER =================
class Leader {
  private channel?: BroadcastChannel;
  private isLeader = true;

  constructor(enabled: boolean) {
    if (!enabled) return;

    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("eventra");

      this.channel.onmessage = (e) => {
        if (e.data === "leader") this.isLeader = false;
      };

      this.channel.postMessage("leader");
    }
  }

  canSend() {
    return this.isLeader;
  }

  destroy() {
    this.channel?.close();
  }
}

// ================= SDK =================
export class Eventra {
  private apiKey: string;
  private endpoint: string;
  private runtime: Runtime;
  private fetch: typeof fetch;

  private queue: TrackEvent[] = [];
  private inFlight = false;
  private destroyed = false;

  private maxBatch: number;
  private maxQueue: number;
  private flushInterval: number;
  private retries: number;
  private retryDelay: number;

  private timer?: any;

  private storage = new Storage();
  private leader: Leader | null = null;

  private failureCount = 0;
  private circuitOpenUntil = 0;

  private sdkInfo: SdkInfo;
  private options: TrackerOptions;

  private exitHandlers: Array<() => void> = [];

  constructor(options: TrackerOptions) {
    if (!options.apiKey) throw new Error("apiKey required");
    if (!options.endpoint) throw new Error("endpoint required");

    this.options = options;
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.runtime = detectRuntime();

    this.fetch = options.fetchImpl ?? globalThis.fetch;
    if (!this.fetch) {
      throw new Error("fetch not available — provide fetchImpl");
    }

    this.maxBatch = options.maxBatchSize ?? 50;
    this.maxQueue = options.maxQueueSize ?? 10000;
    this.flushInterval = options.flushInterval ?? 2000;
    this.retries = options.maxRetries ?? 3;
    this.retryDelay = options.retryBaseDelayMs ?? 300;

    this.sdkInfo = {
      name: "@eventra_dev/eventra-sdk",
      version: "1.0.0",
      runtime: this.runtime,
    };

    // restore browser queue
    if (this.runtime === "browser") {
      const saved = this.storage.get("__eventra_q__");
      if (Array.isArray(saved)) this.queue = saved;
    }

    // leader (browser only)
    if (this.runtime === "browser" && options.multiTabMode === "leader") {
      this.leader = new Leader(true);
    }

    // timer
    if (!options.disableTimer) {
      this.startTimer();
    }

    // browser exit
    if (this.runtime === "browser") {
      this.setupBrowserExit();
    }

    // node / serverless exit
    if (options.autoFlushOnExit !== false && this.runtime !== "browser") {
      this.setupProcessExit();
    }
  }

  // ================= PUBLIC =================
  track(name: string, options?: any) {
    if (this.destroyed) return;

    if (this.queue.length >= this.maxQueue) {
      this.options.onEventsDropped?.(1);
      return;
    }

    const event: TrackEvent = {
      idempotencyKey: uuid(),
      name,
      userId: options?.userId,
      properties: options?.properties ?? {},
      timestamp: new Date().toISOString(),
    };

    this.queue.push(event);

    if (this.runtime === "browser") {
      this.persist();
    }

    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    }

    if (this.runtime === "serverless") {
      void this.flush();
    }
  }

  async flush() {
    if (this.inFlight || this.destroyed) return;
    if (!this.queue.length) return;

    if (this.leader && !this.leader.canSend()) return;
    if (Date.now() < this.circuitOpenUntil) return;

    this.inFlight = true;

    const batch = this.queue.splice(0, this.maxBatch);

    if (this.runtime === "browser") {
      this.persist();
    }

    try {
      await this.send(batch);
      this.failureCount = 0;
    } catch {
      // возвращаем батч назад (без dedupe — это задача backend)
      this.queue = [...batch, ...this.queue];

      if (this.runtime === "browser") {
        this.persist();
      }

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

    this.leader?.destroy();

    // remove process listeners
    for (const off of this.exitHandlers) {
      off();
    }
  }

  // ================= SEND =================
  private async send(events: TrackEvent[]) {
    const payload = JSON.stringify({
      sentAt: new Date().toISOString(),
      sdk: this.sdkInfo,
      events,
    });

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

  // ================= INTERNAL =================
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

    window.addEventListener("visibilitychange", handler);

    this.exitHandlers.push(() => {
      window.removeEventListener("visibilitychange", handler);
    });
  }

  private setupProcessExit() {

    const g = globalThis as any;

    const flushSafe = async () => {
      try {
        await this.flush();
      } catch {}
    };

    const beforeExit = () => {
      void flushSafe();
    };

    const sigint = async () => {
      await flushSafe();
      g.exit();
    };

    g?.on?.("beforeExit", beforeExit);
    g?.on?.("SIGINT", sigint);

    this.exitHandlers.push(() => {
      g?.off?.("beforeExit", beforeExit);
      g?.off?.("SIGINT", sigint);
    });
  }

  private persist() {
    if (this.runtime !== "browser") return;
    this.storage.set("__eventra_q__", this.queue);
  }
}
