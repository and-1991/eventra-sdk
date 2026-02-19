export interface TrackerOptions {
  apiKey: string;
  endpoint?: string;
  flushInterval?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  autoFlushOnExit?: boolean;
  disableTimer?: boolean;

  /** Called when events are dropped due to queue overflow */
  onEventsDropped?: (count: number) => void;

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
