# Eventra SDK

![npm](https://img.shields.io/npm/v/@eventra/sdk)
![bundle size](https://img.shields.io/bundlephobia/minzip/@eventra/sdk)
![license](https://img.shields.io/npm/l/@eventra/sdk)
![types](https://img.shields.io/npm/types/@eventra/sdk)

Production-grade TypeScript SDK for tracking product events across **browser, server, and edge runtimes**.

Eventra is designed for **deterministic ingestion**, batching efficiency, and near-zero runtime overhead.

---

## ✨ Features

- UUID v4 idempotency keys
- Safe retry policy
- Exponential backoff with jitter
- sendBeacon support for browsers
- Multi-runtime support (Browser / Node / Bun / Deno / Edge)
- Optional multi-tab leader mode
- Queue overflow protection
- Zero dependencies

---

## 📦 Install

```bash
pnpm add @eventra/sdk
```

or

```bash
npm install @eventra/sdk
```

---

# 🚀 Quick Start

## Browser

```ts
import { Eventra } from "@eventra/sdk";

const tracker = new Eventra({
  apiKey: "YOUR_API_KEY"
});

tracker.track("checkout.completed", {
  userId: "user_123"
});
```

---

## Node / NestJS

```ts
import { Eventra } from "@eventra/sdk";

const tracker = new Eventra({
  apiKey: process.env.EVENTRA_API_KEY!
});

tracker.track("invoice.created", {
  userId: "user_123"
});
```

---

# ⚙️ Configuration

| Option | Default |
|------|------|
| flushInterval | 2000 ms |
| maxBatchSize | 50 |
| maxRetries | 3 |
| maxQueueSize | 10000 |
| retryBaseDelayMs | 300 |

Example:

```ts
const tracker = new Eventra({
  apiKey: "API_KEY",
  flushInterval: 2000,
  maxBatchSize: 50
});
```

---

# 🧠 Reliability Model

### Idempotency

Each event receives a **UUID v4 idempotency key**, ensuring:

- safe retries
- duplicate suppression
- multi-tab safety

---

### Retry Policy

The SDK retries only when safe:

✔ network failures  
✔ HTTP 5xx

It does **not retry**:

✖ HTTP 4xx  
✖ validation errors  
✖ authentication errors

---

### Backoff Strategy

```
delay = base * 2^attempt * jitter(0.5–1.5) 
```

---

# 🧵 Multi-Tab Mode

Default:

```ts
multiTabMode: "independent"
```

Leader mode:

```ts
const tracker = new Eventra({
  apiKey: "API_KEY",
  multiTabMode: "leader"
});
```

One tab becomes the sender and reduces duplicate traffic.

---

# 🏗 Architecture

```
Application
     │
     ▼
 Eventra SDK
     │
 batching + retry
     │
     ▼
 Eventra Ingest API
     │
 idempotent pipeline
     │
     ▼
 Eventra Event Store
```

---

# 🎯 Best Practices

Use semantic event names.

Good:

```
invoice.created
checkout.completed
team.invited
```

Bad:

```
button_clicked
modal_opened
```

---

# 📄 License

MIT
