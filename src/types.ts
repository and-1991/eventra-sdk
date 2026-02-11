export interface TrackerOptions {
  apiKey: string;
  endpoint?: string;
}

export interface TrackPayload {
  userId?: string;
  [key: string]: unknown;
}
