# Feature Tracker SDK

Official JavaScript / TypeScript SDK for **Feature Tracker**.

Allows you to track feature usage in your product with minimal overhead
and production-grade batching.

------------------------------------------------------------------------

# 🚀 Installation

``` bash
pnpm add @feature-tracker/sdk
```

or

``` bash
npm install @feature-tracker/sdk
```

------------------------------------------------------------------------

# ⚡ Quick Start

``` ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: 'YOUR_API_KEY',
});
```

------------------------------------------------------------------------

# ✅ Track Feature Usage

``` ts
tracker.track('checkout.clicked', {
  userId: 'user_123',
});
```

Minimal payload → minimal latency.

------------------------------------------------------------------------

# 🔥 Auto-Batching (IMPORTANT)

SDK automatically batches events.

Instead of sending:

    100 requests/sec

SDK sends:

    1 request with 100 events

👉 drastically reduces network overhead.

------------------------------------------------------------------------

## Default batching config

option          default
  --------------- ------------
flushInterval   2000 ms
maxBatchSize    100 events

------------------------------------------------------------------------

# ⚙️ Configuration

``` ts
const tracker = new FeatureTracker({
  apiKey: 'YOUR_API_KEY',
  flushInterval: 3000,
  maxBatchSize: 200,
  endpoint: 'https://api.yourdomain.com',
});
```

------------------------------------------------------------------------

# 🧠 Example --- React

``` ts
import { FeatureTracker } from '@feature-tracker/sdk';

export const tracker = new FeatureTracker({
  apiKey: process.env.NEXT_PUBLIC_FEATURE_TRACKER!,
});
```

Usage:

``` ts
tracker.track('pricing.viewed');
```

------------------------------------------------------------------------

# 🧠 Example --- Node.js

Perfect for:

-   cron jobs
-   workers
-   backend tracking
-   queues

``` ts
tracker.track('job.completed', {
  userId: job.userId,
});
```

------------------------------------------------------------------------

# 🔥 Retry Logic

SDK automatically retries failed requests using exponential backoff.

Handles:

✅ network errors\
✅ temporary API downtime\
✅ 5xx responses

------------------------------------------------------------------------

# 🧱 Offline Queue (Browser)

If the network is unavailable:

👉 events are buffered\
👉 sent later

No data loss.

------------------------------------------------------------------------

# ⚡ Performance Design

SDK is built around:

-   async ingestion\
-   batching\
-   low GC pressure\
-   minimal allocations

Tracking a feature is essentially **O(1)**.

------------------------------------------------------------------------

# 🔐 Security

SDK sends events using:

    Authorization: Bearer API_KEY

Never expose **server keys** in the browser.

Use project-level public keys only.

------------------------------------------------------------------------

# 🚨 Best Practices

## ✅ Use stable feature names

GOOD:

    checkout.clicked
    dashboard.opened
    subscription.cancelled

BAD:

    button1
    test123
    random_event

Your analytics is only as good as naming.

------------------------------------------------------------------------

## ✅ Always send userId (if available)

Without userId you lose:

-   unique user analytics
-   retention insights
-   funnel analysis (future)

------------------------------------------------------------------------

## ✅ Track behavior --- not UI clicks

Track:

    payment_succeeded
    file_uploaded
    workspace_created

NOT:

    blue_button_clicked

Think product analytics.

------------------------------------------------------------------------

# 📊 What gets tracked?

Each event:

``` json
{
  "name": "checkout.clicked",
  "userId": "user_123",
  "timestamp": "auto-generated"
}
```

------------------------------------------------------------------------

# 🧠 Architecture

    SDK → Ingest API → Aggregation → Analytics

SDK is intentionally lightweight --- the server does the heavy lifting.

------------------------------------------------------------------------

# 🔥 Production Advice

## Do NOT flush on every event.

Batching exists for a reason.

Bad:

``` ts
await tracker.track(...)
```

Good:

``` ts
tracker.track(...)
```

Fire and forget.

------------------------------------------------------------------------

# 🧪 Debug Mode

``` ts
const tracker = new FeatureTracker({
  apiKey: 'YOUR_API_KEY',
  debug: true,
});
```

Logs outgoing batches --- useful during integration.

------------------------------------------------------------------------

# 📈 Roadmap

Planned SDK features:

-   React hooks
-   Auto page tracking
-   Session tracking
-   Error tracking
-   Performance metrics
-   Plugin system

------------------------------------------------------------------------

# 👨‍💻 Philosophy

Feature Tracker SDK is built with one goal:

> **Zero-friction analytics.**

No bloated configs.\
No megabyte bundles.\
No runtime overhead.

Just tracking.

------------------------------------------------------------------------

# 🧱 Versioning

We follow **semver**.

Breaking changes → major versions.

------------------------------------------------------------------------

# 🤝 Contributing

PRs welcome.

If you're building something cool with Feature Tracker --- we'd love to
hear about it 🚀

------------------------------------------------------------------------

# 📄 License

MIT
