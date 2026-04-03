# Eventra SDK

[![npm version](https://img.shields.io/npm/v/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![npm downloads](https://img.shields.io/npm/dm/@eventra_dev/eventra-sdk.svg)](https://www.npmjs.com/package/@eventra_dev/eventra-sdk)
[![TypeScript](https://img.shields.io/badge/typescript-ready-blue.svg)](https://www.typescriptlang.org/)

Eventra SDK allows you to send **feature usage and product analytics events** to the Eventra platform.

Eventra helps you:

- Track feature adoption
- Detect unused features
- Understand user behavior
- Monitor backend usage
- Analyze product growth

It is designed to be:

* lightweight
* runtime-agnostic
* resilient (batching + retry)
* production-safe
* TypeScript-first

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

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

tracker.track("checkout.completed", {
  userId: "user_123",
});
```

That's it. Events are automatically:

- batched
- retried
- flushed

---

# Event Properties

Eventra allows you to pass **optional properties** with every event.

Properties are completely flexible — you can send **any JSON-compatible data**.

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

Properties are optional:

```ts
tracker.track("app.loaded");
```

Or with userId only:

```ts
tracker.track("user.login", {
  userId: "user_123"
});
```

---

# Common Examples

## Feature Usage

```ts
tracker.track("feature.used", {
  userId: "user_123",
  properties: {
    feature: "dashboard",
    section: "analytics"
  }
});
```

## Page View

```ts
tracker.track("page.viewed", {
  properties: {
    path: window.location.pathname
  }
});
```

## API Usage

```ts
tracker.track("api.request", {
  properties: {
    endpoint: "/checkout",
    method: "POST",
    status: 200
  }
});
```

## Error Tracking

```ts
tracker.track("error.occurred", {
  properties: {
    message: "Payment failed",
    code: "PAYMENT_ERROR"
  }
});
```

---

# Where You Can Use Eventra SDK

Eventra SDK works in many environments:

* Browser applications
* React apps
* Next.js apps
* Node.js backends
* NestJS services
* Express APIs
* Vanilla JavaScript
* Edge runtimes
* Bun
* Deno

---

# Browser Usage

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

tracker.track("page.viewed", {
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

# React Usage

```ts
import { useEffect } from "react";
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

export function App() {

  useEffect(() => {
    tracker.track("app.loaded");
  }, []);

  return <div>Hello</div>;
}
```

---

# Next.js Usage

Client component example:

```ts
"use client";

import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

export function CheckoutButton() {
  return (
    <button
      onClick={() => tracker.track("checkout.started")}
    >
      Checkout
    </button>
  );
}
```

---

# Node.js Usage

```ts
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

tracker.track("invoice.created", {
  userId: "user_123",
});
```

---

# NestJS Usage

```ts
import { Injectable } from "@nestjs/common";
import { Eventra } from "@eventra_dev/eventra-sdk";

@Injectable()
export class BillingService {

  private tracker = new Eventra({
    apiKey: "YOUR_PROJECT_API_KEY",
  });

  charge(userId: string) {
    this.tracker.track("invoice.created", {
      userId
    });
  }
}
```

---

# Express Usage

```ts
import express from "express";
import { Eventra } from "@eventra_dev/eventra-sdk";

const app = express();

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

app.post("/checkout", (req, res) => {

  tracker.track("checkout.completed");

  res.sendStatus(200);
});
```

---

# Vanilla JavaScript (CDN)

```html
<script type="module">

import { Eventra } from "https://esm.sh/@eventra_dev/eventra-sdk";

const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
});

tracker.track("page.viewed");

</script>
```

---

# Configuration

```ts
const eventra = new Eventra({

  apiKey: "YOUR_PROJECT_API_KEY",
  endpoint: "IF YOU NEED SOMETHING DIFFERENT",
  flushInterval: 2000,
  maxBatchSize: 50,
  maxQueueSize: 10000,
  maxRetries: 3

});
```

---

# Options

| option        | description                        |
| ------------- | ---------------------------------- |
| apiKey        | Project API key                    |
| endpoint      | Event ingestion endpoint           |
| flushInterval | Batch flush interval (ms)          |
| maxBatchSize  | Maximum events per batch           |
| maxQueueSize  | Maximum buffered events            |
| maxRetries    | Retry attempts for failed requests |
| multiTabMode  | Browser tab coordination mode      |

---

# Multi-Tab Mode (Browser)

```ts
const tracker = new Eventra({
  apiKey: "YOUR_PROJECT_API_KEY",
  multiTabMode: "leader"
});
```

Only one tab will send events.

---

# Manual Flush

```ts
await tracker.flush();
```

---

# Shutdown / Cleanup

```ts
tracker.destroy();
```

Stops timers and prevents further event sending.

---

# Runtime Support

Eventra SDK works in:

* Node.js
* Browser
* Bun
* Deno
* Edge runtimes
* Serverless environments

---

# Event Format

Events are sent in batches:

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": {
    "name": "@eventra_dev/eventra-sdk",
    "version": "1.0.2",
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

# Documentation

Full documentation:

https://eventra.dev/docs

---

# License

MIT
