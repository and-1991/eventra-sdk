# Feature Tracker SDK

A lightweight TypeScript SDK for tracking feature usage with **near-zero runtime overhead**.

Designed for batching, resilience, and minimal allocations.

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

## Built For

- batching
- retries
- offline buffering
- low GC pressure
- O(1) tracking cost

---

## Defaults

- flushInterval: 2000ms
- maxBatchSize: 100

---

## Best Practices

✔ Use stable feature names  
✔ Always send a userId when possible  
✔ Track behavior — not UI clicks

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

## Philosophy

Zero-friction analytics.

No heavy config.  
No runtime drag.

Just tracking.
