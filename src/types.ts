export interface TrackOptions {
  /** A string; a number is written out as text. Cut to 120 characters. */
  userId?: string | number;
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

  /**
   * Report delivery problems to Eventra (default `true`): how many events the
   * SDK dropped or failed to deliver, by reason, sent as numbers only with the
   * next successful batch (never event names, user ids or properties, never
   * billed). A client that is fully blocked cannot report until a later batch
   * gets through. Set to `false` to send nothing extra.
   */
  diagnostics?: boolean;

  /**
   * Node only. On SIGINT/SIGTERM the SDK flushes its queue (bounded by
   * `shutdownTimeoutMs`). By default (`true`), when no other listener for the
   * signal exists, it then re-raises the signal so the process ends as Node
   * would end it without the SDK; when the app has its own listener the SDK
   * only flushes and the app owns its shutdown. Set `false` to only flush and
   * never re-raise: then, if the SDK is the only handler, the app must exit
   * itself (a signal listener cancels Node's default "exit on signal").
   */
  exitOnSignal?: boolean;

  /**
   * Total time `shutdown()` may spend flushing (default 10000 ms). When a
   * server is down or rate limiting, shutdown gives up after this instead of
   * waiting for every retry and `Retry-After` delay.
   */
  shutdownTimeoutMs?: number;

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
