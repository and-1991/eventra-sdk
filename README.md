# Feature Tracker SDK

A lightweight TypeScript SDK for tracking feature usage with near-zero runtime overhead.

Built for batching, resilience, and minimal allocations.

---

## Install

```
pnpm add @feature-tracker/sdk
```

---

## Quick Start

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

## Design Goals

* minimal CPU overhead
* low GC pressure
* batch-first transport
* retry safety
* offline tolerance

Tracking should never degrade application performance.

---

## Defaults

* flushInterval: 2000ms
* maxBatchSize: 100

Optimized for real production traffic patterns.

---

## Best Practices

✔ Use stable feature names
✔ Always send a userId when available
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

## Future Direction

* edge runtime support
* serverless-friendly transport
* adaptive batching
* compression
* automatic backpressure

The SDK will remain intentionally small — complexity belongs on the server.
