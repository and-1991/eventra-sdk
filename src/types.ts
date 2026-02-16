
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
}

export interface TrackEvent {
  name: string;
  userId?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}
