# Eventra SDK

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)

Eventra SDK allows you to send **feature usage and product analytics events** to the Eventra platform.

It is designed to be:

* lightweight
* runtime-agnostic (Node.js / Browser / Bun / Deno)
* resilient (batching + retry)
* production-safe

---

# Installation

Install the SDK using your preferred package manager.

### npm

```bash
npm i @eventra_dev/eventra-sdk
```

### pnpm

```bash
pnpm add @eventra_dev/eventra-sdk
```

### yarn

```bash
yarn add @eventra_dev/eventra-sdk
```

---

# Quick Start

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const eventra = new Eventra({
  apiKey: "your-api-key",
  endpoint: "https://api.eventra.dev/api/v1/events"
});

eventra.track("user_signup", {
  userId: "user_123",
  properties: {
    plan: "pro"
  }
});
```

---

# Basic Usage

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const client = new Eventra({
  apiKey: "your-api-key",
  endpoint: "https://api.eventra.dev/api/v1/events"
});

client.track("project_created", {
  userId: "user_1",
  properties: {
    projectId: "proj_123"
  }
});
```

Events are automatically:

* batched
* retried
* flushed periodically

---

# Configuration

You can configure the SDK behaviour:

```ts
const eventra = new Eventra({
  apiKey: "your-api-key",

  endpoint: "https://api.eventra.dev/api/v1/events",

  flushInterval: 2000,
  maxBatchSize: 50,
  maxQueueSize: 10000,
  maxRetries: 3
});
```

### Options

| option        | description                        |
| ------------- | ---------------------------------- |
| apiKey        | Project API key                    |
| endpoint      | Event ingestion endpoint           |
| flushInterval | Batch flush interval (ms)          |
| maxBatchSize  | Maximum events per batch           |
| maxQueueSize  | Maximum buffered events            |
| maxRetries    | Retry attempts for failed requests |

---

# Browser Usage

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const eventra = new Eventra({
  apiKey: "public-api-key",
  endpoint: "https://api.eventra.dev/api/v1/events"
});

eventra.track("page_view", {
  properties: {
    path: window.location.pathname
  }
});
```

The SDK automatically:

* batches events
* retries failed requests
* flushes on page exit

---

# Node.js Usage

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const eventra = new Eventra({
  apiKey: process.env.EVENTRA_API_KEY!,
  endpoint: "https://api.eventra.dev/api/v1/events"
});

eventra.track("job_completed", {
  properties: {
    duration: 120
  }
});
```

---

# Multi-tab Mode (Browser)

To avoid duplicate event sending across multiple tabs you can enable leader mode:

```ts
const eventra = new Eventra({
  apiKey: "your-api-key",
  multiTabMode: "leader"
});
```

Only one tab will send events.

---

# Manual Flush

You can flush the queue manually:

```ts
await eventra.flush();
```

---

# Shutdown / Cleanup

```ts
eventra.destroy();
```

Stops timers and prevents further event sending.

---

# Runtime Support

The SDK works in:

* Node.js
* Browser
* Bun
* Deno
* Edge runtimes

---

# Event Format

Events are sent in batches:

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": {
    "name": "@eventra_dev/eventra-sdk",
    "version": "0.1.2",
    "runtime": "node"
  },
  "events": [
    {
      "name": "user_signup",
      "userId": "user_123",
      "timestamp": "2026-03-12T10:00:00Z",
      "properties": {}
    }
  ]
}
```

---

# Error Handling

Client errors (4xx) are **not retried**.
Server errors (5xx) are retried with **exponential backoff**.

---

# Documentation

Full documentation:

https://eventra.dev/docs

---

# License

MIT
