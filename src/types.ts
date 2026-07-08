export interface TrackOptions {
  userId?: string;
  properties?: Record<string, unknown>;
}

export interface TrackerOptions {
  apiKey: string;
  /** Defaults to production ingest URL when omitted */
  endpoint?: string;
  flushInterval?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  /** Total delivery attempts per batch (default 3) */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Max serialized batch payload in bytes (default 60000) */
  maxPayloadBytes?: number;
  fetchImpl?: typeof fetch;
  autoFlushOnExit?: boolean;
  disableTimer?: boolean;

  /**
   * Persist the pending queue to `localStorage` in the browser so it survives
   * reloads/tab closes (default `true`). Queued events can include `userId`
   * and custom `properties`, which end up unencrypted in `localStorage` while
   * this is on. Set to `false` to keep the queue in memory only — events are
   * lost if the page is closed before they're delivered.
   */
  persistQueue?: boolean;

  /** Called when events are dropped due to queue overflow */
  onEventsDropped?: (count: number) => void;

  /** Called when the server rejects events (4xx except 429) */
  onDeliveryFailed?: (info: {
    status: number;
    events: TrackEvent[];
  }) => void;

  /** Multi-tab mode (browser only) */
  multiTabMode?: "independent" | "leader";
}

export interface TrackEvent {
  idempotencyKey: string;
  name: string;
  userId?: string;
  properties?: Record<string, unknown>;
  timestamp: string;
}

export interface SdkInfo {
  name: string;
  version: string;
  runtime: string;
}
