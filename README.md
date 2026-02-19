# Feature Tracker SDK

Production-grade TypeScript SDK for tracking feature usage across browser, server, and edge runtimes.

Designed for **deterministic ingestion**, batching efficiency, and near-zero overhead.

---

## ✨ What’s New (Hardening)

This SDK is aligned with the Feature Tracker ingestion guarantees:

* ✅ UUID v4 idempotency keys (client-generated)
* ✅ Safe retry policy (network + 5xx only)
* ✅ Exponential backoff with jitter
* ✅ sendBeacon on tab hide (browser)
* ✅ Multi-runtime support (Browser / Node / Bun / Deno)
* ✅ Optional multi-tab leader mode
* ✅ Queue overflow telemetry
* ✅ Zero dependencies

---

## 📦 Install

```bash
pnpm add @feature-tracker/sdk
```

---

## 🧭 Runtime Requirements

**Minimum supported environments:**

* Node.js **18+**
* Modern browsers (2022+)
* Bun (latest)
* Deno (latest)
* Edge runtimes (Vercel / Cloudflare)

The SDK relies on:

* global `fetch`
* `crypto.randomUUID`

---

# 🚀 Quick Start

## Browser

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

## Node / NestJS

```ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: process.env.FEATURE_API_KEY!,
  endpoint: 'https://your-domain.com/api/ingest/batch',
});

tracker.track('invoice.created', {
  userId: 'user_123',
});
```

---

# ⚙️ Configuration

## Defaults

| Option           | Default |
| ---------------- | ------- |
| flushInterval    | 2000 ms |
| maxBatchSize     | 50      |
| maxRetries       | 3       |
| maxQueueSize     | 10,000  |
| retryBaseDelayMs | 300     |

---

## Full Options

```ts
type TrackerOptions = {
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

  // Advanced
  multiTabMode?: "independent" | "leader";
  onEventsDropped?: (count: number) => void;
};
```

---

# 🧠 Reliability Model

## Idempotency (automatic)

Every event gets a **UUID v4 idempotency key** on the client.

This guarantees:

* safe retries
* duplicate suppression server-side
* multi-tab safety
* network failure safety

You do **not** need to manage idempotency manually.

---

## Retry Policy

The SDK retries **only when safe**:

✅ network failures
✅ HTTP 5xx

The SDK does **NOT** retry:

❌ HTTP 4xx
❌ validation errors
❌ auth errors

This prevents retry storms and protects ingestion.

---

## Backoff Strategy

Exponential backoff with jitter:

```
delay = base * 2^attempt * jitter(0.5–1.5)
```

This prevents thundering herd during outages.

---

## Browser Delivery Guarantees

When a tab becomes hidden:

* SDK attempts `navigator.sendBeacon`
* falls back to fetch if unavailable

This significantly reduces tail loss on:

* tab close
* navigation
* mobile background

---

# 🧵 Multi-Tab Behavior (Browser)

By default:

```ts
multiTabMode: "independent"
```

Each tab sends independently (safe but higher traffic).

## Leader Mode (recommended for heavy apps)

```ts
const tracker = new FeatureTracker({
  apiKey: '...',
  multiTabMode: 'leader',
});
```

Behavior:

* one tab becomes the sender
* reduces duplicate network pressure
* preserves correctness

---

# 🚨 Queue Backpressure

If the in-memory queue overflows:

* new events are dropped
* optional callback fires

```ts
const tracker = new FeatureTracker({
  apiKey: '...',
  onEventsDropped(count) {
    console.warn('Events dropped:', count);
  },
});
```

This protects the host application from memory blowups.

---

# 🧪 Framework Examples

---

## ⚛️ React

```ts
import { useEffect } from 'react';
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: import.meta.env.VITE_FEATURE_KEY,
});

export function App() {
  useEffect(() => {
    tracker.track('app.loaded');
  }, []);

  return <div>Hello</div>;
}
```

---

## ⚡ Next.js (App Router)

**Important:** create tracker once.

```ts
// lib/tracker.ts
import { FeatureTracker } from '@feature-tracker/sdk';

export const tracker = new FeatureTracker({
  apiKey: process.env.NEXT_PUBLIC_FEATURE_KEY!,
  multiTabMode: 'leader',
});
```

Usage in client component:

```ts
'use client';

import { tracker } from '@/lib/tracker';

export function CheckoutButton() {
  return (
    <button
      onClick={() =>
        tracker.track('checkout.started')
      }
    >
      Checkout
    </button>
  );
}
```

✅ no layout remounts
✅ no hydration risk
✅ singleton safe

---

## 🟢 Vue 3

```ts
// tracker.ts
import { FeatureTracker } from '@feature-tracker/sdk';

export const tracker = new FeatureTracker({
  apiKey: import.meta.env.VITE_FEATURE_KEY,
});
```

```ts
// component.vue
import { tracker } from './tracker';

tracker.track('page.viewed');
```

---

## 🟠 Svelte

```ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: import.meta.env.VITE_FEATURE_KEY,
});

tracker.track('page.viewed');
```

---

## 🟣 Vanilla JS

```html
<script type="module">
  import { FeatureTracker } from 'https://esm.sh/@feature-tracker/sdk';

  const tracker = new FeatureTracker({
    apiKey: 'YOUR_KEY',
  });

  tracker.track('page.viewed');
</script>
```

---

# 🖥️ Server Environments

---

## NestJS

```ts
@Injectable()
export class BillingService {
  private tracker = new FeatureTracker({
    apiKey: process.env.FEATURE_API_KEY!,
  });

  charge(userId: string) {
    this.tracker.track('invoice.created', { userId });
  }
}
```

---

## Express

```ts
import express from 'express';
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: process.env.FEATURE_API_KEY!,
});

const app = express();

app.post('/checkout', (req, res) => {
  tracker.track('checkout.completed');
  res.sendStatus(200);
});
```

---

## Fastify

```ts
import Fastify from 'fastify';
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: process.env.FEATURE_API_KEY!,
});

const app = Fastify();

app.post('/event', async () => {
  tracker.track('api.called');
});
```

---

## Deno

```ts
import { FeatureTracker } from "npm:@feature-tracker/sdk";

const tracker = new FeatureTracker({
  apiKey: Deno.env.get("FEATURE_API_KEY")!,
});
```

---

## Bun

```ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: process.env.FEATURE_API_KEY!,
});
```

---

# 🎯 Best Practices

✅ Use stable semantic event names
✅ Always send `userId` when available
✅ Track business events, not UI noise
✅ Reuse a singleton tracker instance
✅ Enable leader mode for heavy browser apps

---

## Event Naming

**Bad**

```
button_clicked
modal_opened
```

**Good**

```
invoice.created
checkout.completed
team.invited
```

---

# 🏗️ Design Principles

* Deterministic ingestion first
* Batch-first transport
* Minimal allocations
* Retry safety over aggressiveness
* Zero heavy dependencies
* Runtime auto-detection

**Complexity belongs on the server.**

---

# 📄 License

MIT
