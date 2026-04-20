<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra SDK

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
  endpoint: "https://api.eventra.dev/ingest",
});

tracker.track("checkout.completed", {
  userId: "user_123",
});
```

That's it.

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
- flush on tab close

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
  endpoint: "CUSTOM_ENDPOINT",
  flushInterval: 2000,
  maxBatchSize: 50,
  maxQueueSize: 10000,
  maxRetries: 3,
});
```

---

##  Options

| option        | description                   |
| ------------- | ----------------------------- |
| apiKey        | Project API key               |
| endpoint      | Event ingestion endpoint      |
| flushInterval | Flush interval (ms)           |
| maxBatchSize  | Events per batch              |
| maxQueueSize  | Max buffer size               |
| maxRetries    | Retry attempts                |

---

## Manual Flush

```ts
await tracker.flush();
```

---

## Cleanup

```ts
tracker.destroy();
```

Stops timers, removes listeners, and clears internal state.

---

## Reliability Features

Eventra SDK includes:

- Idempotency (stable event IDs during retries)
- Retry with exponential backoff 
- Circuit breaker (prevents overload)
- Queue-based delivery (all runtimes)
- Queue persistence (browser)
- sendBeacon optimization (browser exit)

---

## Event Format

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": {
    "name": "@eventra_dev/eventra-sdk",
    "version": "1.0.0",
    "runtime": "browser"
  },
  "events": [
    {
      "idempotencyKey": "uuid",
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
