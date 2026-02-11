import { TrackerOptions, TrackPayload } from "./types";

interface BatchedEvent {
  name: string;
  payload: TrackPayload;
}

export class FeatureTracker {
  private apiKey: string;
  private endpoint: string;
  private queue: BatchedEvent[] = [];
  private flushInterval: number;
  private maxBatchSize: number;
  private timer: ReturnType<typeof setInterval>;

  constructor(options: TrackerOptions) {
    this.apiKey = options.apiKey;
    this.endpoint =
      options.endpoint ?? "http://localhost:3000/ingest/batch";

    this.flushInterval = 5000; // 5s
    this.maxBatchSize = 10;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  track(name: string, payload: TrackPayload = {}) {
    this.queue.push({ name, payload });

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  async flush() {
    if (this.queue.length === 0) return;

    const events = this.queue.splice(0, this.queue.length);

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ events }),
      });
    } catch (err) {
      // не теряем события, если запрос упал
      this.queue.unshift(...events);
    }
  }

  destroy() {
    clearInterval(this.timer);
    void this.flush();
  }
}




