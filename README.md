# Feature Tracker SDK

A lightweight TypeScript SDK for tracking feature usage across browser and Node runtimes.

Designed for batching, resilience, and near-zero performance overhead.

---

## Install

```bash
pnpm add @feature-tracker/sdk
```

---

## Quick Start (Browser)

```ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: 'YOUR_API_KEY',
});

tracker.track('checkout.completed', {
  userId: 'user_123',
});
```

---

## Quick Start (Node / NestJS)

```ts
const tracker = new FeatureTracker({
  apiKey: process.env.FEATURE_API_KEY,
  endpoint: 'https://your-domain.com/api/ingest/batch',
});
```

---

## Defaults

- flushInterval: 2000ms
- maxBatchSize: 50
- maxRetries: 3
- maxQueueSize: 10,000

---

## Best Practices

✔ Use stable feature names  
✔ Always send userId when available  
✔ Track behavior — not UI noise

Bad:

```
button_clicked
```

Good:

```
invoice.created
checkout.completed
team.invited
```

---

## Runtime Support

- Browser (sendBeacon optimized)
- Node.js
- Bun
- Deno (fetch-based)

---

## Design Principles

- Minimal allocations
- Batch-first transport
- Retry safety
- No heavy dependencies
- Runtime auto-detection

Complexity belongs on the server.
