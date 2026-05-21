<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra SDK

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@eventra_dev/eventra-sdk)]()

Production-grade analytics SDK for tracking **feature usage, product behavior, and backend activity**.

Eventra helps you:

- Track feature adoption 
- Detect unused features 
- Understand user behavior 
- Monitor backend usage 
- Analyze product growth

---

## Why Eventra

Eventra SDK is:

- Lightweight (~minimal overhead)
- Runtime-aware (Browser, Node, Edge, Serverless)
- Resilient (batching + retry + circuit breaker)
- Durable (browser persistence)
- Consistent (same delivery model across all environments)
- TypeScript-first

---

## Installation

```bash
npm i @eventra_dev/eventra-sdk
```

```bash
pnpm add @eventra_dev/eventra-sdk
```

```bash
yarn add @eventra_dev/eventra-sdk
```

---

## Quick Start

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

tracker.track("checkout.completed", {
  userId: "user_123",
});
```

That's it.

By default, events are sent to `https://api.eventra.dev/api/v1/ingest/batch`.

The SDK automatically handles:

- batching 
- retries 
- queueing 
- flushing 
- runtime adaptation

---

## Runtime Behavior

Eventra SDK adapts automatically:

| Environment | Behavior                               |
| ----------- | -------------------------------------- |
| Browser     | batching + persistence + retry         |
| Node.js     | batching + retry                       |
| Serverless  | immediate flush + retry                |
| Edge        | lightweight batching                   |
| Workers     | batching                               |

No config needed.

---

## Event Properties

You can attach any JSON data:

```ts
tracker.track("checkout.completed", {
  userId: "user_123",
  properties: {
    plan: "pro",
    price: 29,
    currency: "USD"
  }
});
```

Minimal:

```ts
tracker.track("app.loaded");
```

Event names are trimmed to 64 characters, `userId` to 120 (API limits).

---

## Common Examples

### Feature Usage

```ts
tracker.track("feature.used", {
  userId: "user_123",
  properties: {
    feature: "dashboard"
  }
});
```

---

### Page View

```ts
tracker.track("page.viewed", {
  properties: {
    path: window.location.pathname
  }
});
```

---

### API Usage

```ts
tracker.track("api.request", {
  properties: {
    endpoint: "/checkout",
    method: "POST",
    status: 200
  }
});
```

---

### Error Tracking

```ts
tracker.track("error.occurred", {
  properties: {
    message: "Payment failed",
    code: "PAYMENT_ERROR"
  }
});
```

---

## Where You Can Use It

- Browser apps
- React / Next.js 
- Node.js backends 
- NestJS services 
- Express APIs 
- Edge runtimes 
- Serverless (AWS / Vercel)
- Bun / Deno

---

## Usage by Environment

### Browser

```ts
const tracker = new Eventra({
  apiKey: "...",
});

tracker.track("page.viewed");
```

- batching  
- retry  
- persistence (localStorage)  
- flush on tab close (`fetch` with `keepalive`)

Optional — single sender across tabs:

```ts
const tracker = new Eventra({
  apiKey: "...",
  multiTabMode: "leader",
});
```

---

### Node.js

```ts
const tracker = new Eventra({
  apiKey: "...",
});

tracker.track("invoice.created");
```

- batching  
- retry  
- auto flush (interval)  
- graceful shutdown support

---

### Serverless (IMPORTANT)

```ts
export default async function handler(req, res) {
  const tracker = new Eventra({
    apiKey: "...",
  });

  tracker.track("function.called");

  await tracker.flush();

  res.status(200).end();
}
```

- immediate flush
- retry
- optimized for short-lived environments

---

## Configuration

```ts
const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
  flushInterval: 2000,
  maxBatchSize: 50,
  maxQueueSize: 10000,
  maxRetries: 3,
  retryBaseDelayMs: 300,
  maxPayloadBytes: 60000,
  onEventsDropped: (count) => {
    console.warn(`Dropped ${count} event(s) — queue full`);
  },
  onDeliveryFailed: ({ status, events }) => {
    console.error(`Ingest rejected batch (${status})`, events.length);
  },
});
```

`endpoint` is optional — omit it to use the production ingest URL.

For self-hosted or local development:

```ts
const tracker = new Eventra({
  apiKey: "...",
  endpoint: "...",
});
```

---

##  Options

| option | description |
| ------------- | --------------------------- |
| apiKey | Project API key (required) |
| endpoint | Ingest batch URL |
| flushInterval | Flush interval (ms) |
| maxBatchSize | Events per batch |
| maxQueueSize | Max buffer size |
| maxRetries | Total delivery attempts per batch (default: 3) |
| retryBaseDelayMs | Base delay for exponential backoff (ms) |
| maxPayloadBytes | Max serialized batch size (default: 60000) |
| fetchImpl | Custom `fetch` (Node without native fetch, tests) |
| autoFlushOnExit | Flush on process exit (Node / serverless, default: `true`) |
| disableTimer | Disable periodic flush timer |
| onEventsDropped | Callback when queue is full |
| onDeliveryFailed | Callback on permanent ingest errors (4xx except 429) |
| multiTabMode | `"independent"` (default) or `"leader"` (browser only) |

---

## Manual Flush

```ts
await tracker.flush();
```

---

## Shutdown

Graceful shutdown — flush first, then cleanup:

```ts
await tracker.shutdown();
```

For Node / serverless, prefer explicit shutdown over relying on process signals:

```ts
await tracker.flush();
await tracker.shutdown();
```

`destroy()` stops timers and listeners immediately without flushing.

---

## Reliability Features

Eventra SDK includes:

- Idempotency (UUID v4 per event, stable across retries)
- Retry with exponential backoff + jitter (capped)
- Circuit breaker with half-open recovery
- Queue-based delivery (all runtimes)
- Safe dequeue (events removed only after successful ingest)
- Queue persistence (browser) with merge + cross-tab sync
- Multi-tab leader election with re-election
- `fetch` + `keepalive` on tab close (with `x-api-key`, size-checked)
- `pagehide` + `visibilitychange` flush hooks
- Property validation at `track()` (depth + size)
- Payload byte limits per batch
- Permanent error handling via `onDeliveryFailed` (401, 422, etc.)
- Automatic requeue on network errors and 429 / 5xx

---

## Event Format

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": {
    "name": "@eventra_dev/eventra-sdk",
    "version": "1.1.3",
    "runtime": "browser"
  },
  "events": [
    {
      "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
      "name": "user_signup",
      "userId": "user_123",
      "timestamp": "2026-03-12T10:00:00Z",
      "properties": {}
    }
  ]
}
```

---

## Docs

https://eventra.dev/docs

---

## License

MIT
