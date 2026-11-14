<p align="center">
<img src="./assets/eventra-icon-animated.svg" width="120">
</p>

# Eventra SDK

<p align="center">
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@eventra_dev/eventra-sdk.svg?style=flat-square&color=blue"></a>
  <a href="https://www.npmjs.com/package/@eventra_dev/eventra-sdk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@eventra_dev/eventra-sdk.svg?style=flat-square&color=blue"></a>
  <a href="https://github.com/and-1991/eventra-sdk/actions/workflows/test.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/and-1991/eventra-sdk/test.yml?branch=main&label=tests&style=flat-square&logo=vitest&logoColor=white"></a>
  <img alt="tests passing" src="https://img.shields.io/badge/tests-280%20passing-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="test suites" src="https://img.shields.io/badge/suites-22-brightgreen?style=flat-square">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&logo=vitest&logoColor=white">
  <img alt="node" src="https://img.shields.io/node/v/@eventra_dev/eventra-sdk?style=flat-square&color=darkgreen&logo=node.js&logoColor=white">
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-blue?style=flat-square&logo=typescript&logoColor=white"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@eventra_dev/eventra-sdk?style=flat-square&color=lightgrey">
</p>

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
| Serverless (AWS Lambda only) | immediate flush + retry |
| Edge        | batching + retry                       |
| Anything else (e.g. Cloudflare Workers) | not distinctly detected — falls back to the same batching + retry path as Node.js |

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

Event names lose NUL, line breaks and half-surrogates (the server removes them too), are trimmed, cut to 64 characters and trimmed again, `userId` is cut to 120 (API limits); a cut never leaves half of an emoji, so the name is the one the CLI catalog holds. A numeric `userId` is written out as text, and `null` or an object means no user id. `properties` are copied when you call `track()`, so changing the object afterwards does not change the event. `track()` never throws: an empty name, or properties that exceed the depth/size limits, are dropped silently and reported via `onEventsDropped` instead. A properties object with more than 50,000 values in all is refused as soon as its keys are listed, without walking it (listing the keys of a huge object is the only cost left: about 0.35 s for a million).

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
- Serverless (AWS Lambda is auto-detected and flushes immediately; on Vercel and other platforms call `await tracker.flush()` yourself, as in the example below)
- Bun / Deno (not tested)

The browser mode (persistence, tab-close flush) is used only when `window` and `document` both have `addEventListener`. A global `window` without them (React Native, Deno 1.x) does not count as a browser, so the constructor does not throw there; the queue then lives in memory.

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

By default (`multiTabMode: "independent"`) every open tab shares its pending events with the others, so the events of a tab that closes are not lost. An event another open tab just announced is left to that tab for 15 seconds (it sends within its flush interval and tells the others); only after that does another tab send it, for example when the first tab was closed. Events read back from storage (an earlier page, a closed tab) are sent at once. An event keeps the same idempotency key in every tab, so it is counted once even if two tabs send it. Use `"leader"` to have one tab send for all of them.

Optional - single sender across tabs:

```ts
const tracker = new Eventra({
  apiKey: "...",
  multiTabMode: "leader",
});
```

**Privacy note:** persistence stores the pending queue — including any `userId`/`properties` you pass to `track()` — as plaintext JSON in `localStorage` so it survives reloads. If that's a concern (e.g. properties may carry PII on a shared/public device), disable it:

```ts
const tracker = new Eventra({
  apiKey: "...",
  persistQueue: false,
});
```

Writes to `localStorage` are coalesced: a burst of `track()` calls costs one write about 50 ms later, not one write per call, and the queue is written immediately on `pagehide`, when the tab becomes hidden, and on `shutdown()`/`destroy()`. Closing or navigating away does not lose events that fit in storage; only a hard crash of the tab in that ~50 ms window can.

On `pagehide` what is queued is sent at once with `fetch` `keepalive`, even while another request is still running (the browser cancels that one when the page goes away, so its events are sent again in the keepalive request; the server counts an event once by its idempotency key). One keepalive request carries at most 60,000 bytes (or `maxPayloadBytes` when that is smaller) and 500 events, so a very large queue is not all sent then; the rest stays in `localStorage` for the next visit. After a back/forward cache restore (`pageshow`) requests are normal again.

`localStorage` is shared with your own app, so the SDK keeps its queue there to about 1 MB (1,000,000 characters of JSON) and your own writes keep working. When the queue is larger, only the newest events are written; the older ones stay in the in-memory queue and are still delivered while the page is open, but would not survive the page closing before that.

Events kept in `localStorage` have a maximum age of 14 days: when the queue is loaded again (page load, another tab writing it), events older than that are dropped. The server only remembers idempotency keys for 30 days, so an event that was already delivered while the page was closing (whose response is never seen) must not be re-sent by a visitor who comes back months later and be counted twice.

With `persistQueue: false`, nothing is written to `localStorage`; the queue lives in memory only and is lost if the page closes before delivery (sharing events between tabs via `BroadcastChannel` still works, since that's never written to disk).

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
// created once, outside the handler: the platform reuses it between invocations.
// A new Eventra per call keeps adding exit listeners and is never cleaned up.
const tracker = new Eventra({
  apiKey: "...",
});

export default async function handler(req, res) {
  tracker.track("function.called");

  await tracker.flush();

  res.status(200).end();
}
```

- AWS Lambda is detected automatically and flushes right away; on Vercel and other platforms the SDK batches on a timer, so always `await tracker.flush()` before the response ends
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
    console.warn(`Dropped ${count} event(s)`);
  },
  onDeliveryFailed: ({ status, events }) => {
    console.error(`Ingest rejected batch (${status})`, events.length);
  },
});
```

`endpoint` is optional - omit it to use the production ingest URL. Use `https`: a plain `http` endpoint on a remote host logs a warning, since the API key would travel unencrypted (`localhost` is exempt). The SDK never follows a redirect when sending, so the key cannot be forwarded to another host. A redirect is not a server rejection, so `onDeliveryFailed` is not called for it: the events stay queued and are retried, and in Node (and other runtimes whose `fetch` names the redirect) the SDK logs one warning telling you to check the endpoint URL. A browser only reports a failed request, so there a redirect looks like any other network failure.

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
| apiKey | Project API key (required). Create it with `SDK` access in the dashboard (a key made for the CLI is refused with 403) |
| endpoint | Ingest batch URL |
| flushInterval | Flush interval (ms) |
| maxBatchSize | Events per batch (default: 50, at most 500 - the most the ingest API accepts in one request) |
| maxQueueSize | Max buffer size |
| maxRetries | Total delivery attempts per batch (default: 3) |
| retryBaseDelayMs | Base delay for exponential backoff (ms) |
| maxPayloadBytes | Max serialized batch size (default: 60000) |
| fetchImpl | Custom `fetch` (Node without native fetch, tests) |
| autoFlushOnExit | Node / serverless, default `true`: flush what is queued when the script ends by itself (`beforeExit`, bounded by `shutdownTimeoutMs`) and on `SIGINT`/`SIGTERM`. `process.exit()` and a crash do not run it, so call `await tracker.shutdown()` first |
| disableTimer | Disable periodic flush timer |
| onEventsDropped | Called when events are dropped (queue full, an invalid event, or a single event above `maxPayloadBytes`), normally once per dropped event, so the count is 1; when a saved queue is trimmed at load, the number removed |
| onDeliveryFailed | Callback on permanent ingest errors (4xx except 429). The whole rejected batch is dropped, including events that were valid, because the server does not say which one it refused. A single event above `maxPayloadBytes` is reported here too, with status `413`, besides `onEventsDropped` |
| multiTabMode | `"independent"` (default) or `"leader"` (browser only) |
| exitOnSignal | Node only, default `true`: on `SIGINT`/`SIGTERM` the SDK flushes (bounded by `shutdownTimeoutMs`) and then, when no other listener for the signal exists, re-raises it so the process ends as it would without the SDK; when your app has its own listener the SDK only flushes. `false` only flushes and never re-raises. See [Shutdown](#shutdown) |
| shutdownTimeoutMs | Total time `shutdown()` may spend flushing (default: 10000). It gives up after this, so a dead or rate-limited server cannot hold a `SIGTERM` shutdown past your grace period |
| diagnostics | Report delivery problems (counts only) with the next successful batch, default `true`; `false` sends nothing extra. See [Delivery diagnostics](#delivery-diagnostics) |
| persistQueue | Persist the queue to `localStorage` in the browser (browser only, default: `true`) — `false` keeps it in-memory only, avoiding writing `userId`/`properties` to disk |

An option with an invalid value (for example `maxBatchSize: 0` or `NaN`, an empty `endpoint`) is ignored with one console warning and the default is used. Callbacks such as `onEventsDropped` and `onDeliveryFailed` can throw or reject without affecting the SDK. Draining a large queue (hundreds of thousands of events) takes time in proportion to its size. Some values are refused at once instead: an `apiKey` with characters a header cannot carry, a `fetchImpl` that is not a function. `endpoint` that is not a URL, an unknown `multiTabMode`, a `diagnostics` that is not `true` or `false`, a fractional `maxBatchSize` or `maxQueueSize`, a `maxBatchSize` above 500 (500 is used), and a `maxRetries` above 20 are reported with a warning and replaced. A `userId` that is `NaN` or infinite is no user id.

---

## Manual Flush

```ts
await tracker.flush();
```

`flush()` also waits for a send that is already running (the timer, a full batch, or the per-call flush on serverless), so awaiting it in a serverless handler is enough. While the circuit breaker is open or a `Retry-After` wait is active it resolves without sending, and the events stay queued.

---

## Shutdown

Graceful shutdown — flush first, then cleanup:

```ts
await tracker.shutdown();
```

On `SIGINT`/`SIGTERM` the SDK flushes its queue (within `shutdownTimeoutMs`). Registering any signal handler cancels Node's default "exit on SIGINT/SIGTERM", so the SDK keeps that default for you:

- **Nobody else listens to the signal** (a plain Express server, for example): after the flush the SDK re-raises the signal and the process ends as it would have without the SDK, so `docker stop` or a Kubernetes rollout does not wait for `SIGKILL`. When the process is PID 1 in a container (no init such as `tini`), where a re-raised signal would be ignored, it exits with code 130 (`SIGINT`) or 143 (`SIGTERM`) instead.
- **Your app has its own listener** (your own `process.on("SIGTERM")`, `process.once`, NestJS `enableShutdownHooks()`): the SDK only flushes and your app owns its shutdown. This is decided when the signal arrives (the SDK's listener runs first), so a listener that removes itself while it shuts down is never cut off by a re-raise.

A `process.on`/`process.once` listener of your own replaces Node's default exit, and the SDK does not re-raise next to it, so that listener has to end the process itself. Awaiting `shutdown()` alone leaves the process running:

```ts
process.on("SIGTERM", async () => {
  await tracker.shutdown();
  // your own cleanup here
  process.exit(0);
});
```

If you have nothing else to do on the signal, leave the listener out: the default (`exitOnSignal: true`) already flushes and then ends the process.

Set `exitOnSignal: false` to only flush and never re-raise. Then, if the SDK is the only signal handler in your process, **your app must exit itself** (for example `process.exit()` after your cleanup).

`shutdown()` has a total time budget (`shutdownTimeoutMs`, default 10 s). While it runs, retries and `Retry-After` waits that do not fit in what is left are skipped and requests are cut at the deadline, so a server that is down or rate limiting cannot hold the process past a typical termination grace period; events that could not be sent stay in the persisted queue (browser) or are lost with the process (Node). The flush timer never keeps a Node process alive on its own, and events still queued when a script ends are sent on `beforeExit` (each time the loop drains, so later ones too, within the same budget); `process.exit()` or a crash skips that. `track()` after `shutdown()` is ignored without a callback. `shutdown()` waits for a flush that is already running before sending what is left.

For Node / serverless, prefer explicit shutdown over relying on process signals:

```ts
await tracker.flush();
await tracker.shutdown();
```

`destroy()` stops timers and listeners immediately without flushing, and a retry that is waiting does not run. In a browser the queue stays in `localStorage` for the next page; where it cannot be kept (Node, `persistQueue: false`, blocked storage) the events still queued are reported to `onEventsDropped` (a batch already in flight is not counted).

---

## Delivery diagnostics

The SDK counts what it could not deliver and tells Eventra with the next batch that gets through, so the dashboard can show how many events never arrived and why. It is on by default and switched off with `diagnostics: false`.

What is counted (numbers only, never event names, user ids or properties):

| group | reason | meaning |
|-------|--------|---------|
| dropped (events) | `queue_full` | the queue overflowed |
| | `invalid_event` | empty name, or properties over the depth/size limits |
| | `too_large` | a single event above `maxPayloadBytes` |
| | `rejected` | the server answered 4xx (not 429) |
| failed (send attempts) | `network` | blocked, offline, DNS or timeout, after the retries |
| | `server_error` | 5xx after the retries |
| | `rate_limited` | 429 after the retries |
| (detail) | `circuit_open` | the circuit breaker opened; listed by reason only, not added to `failedTotal` |

A failed batch is not lost: its events stay queued. `failedTotal` counts failed send attempts (a batch that could not be delivered after all its retries counts once, whatever the number of events or HTTP requests in it), `droppedTotal` counts events that are gone. The two are different units and are not added together.

How it is sent: as optional metadata in the batch envelope, never as an event, so it is not billed and an event count never includes it.

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": { "name": "@eventra_dev/eventra-sdk", "version": "<sdk-version>", "runtime": "browser" },
  "diagnostics": {
    "reportId": "0b6f3c52-3a2a-4a3e-8f0e-1b2f6f2d9b11",
    "since": "2026-03-12T09:41:00.000Z",
    "droppedTotal": 3,
    "failedTotal": 2,
    "byReason": { "queue_full": 3, "network": 2 },
    "queued": 12,
    "sdkVersion": "<sdk-version>"
  },
  "events": []
}
```

- A report is built from the counters since the last acknowledged one, and is removed only after the server answers 2xx for the batch that carried it. If that batch fails, the same report (same `reportId`) is sent again, and the server counts a `reportId` once, so a retry never double counts.
- In the browser the counters are kept with the queue (`localStorage`, same debounce) and survive a reload; with `persistQueue: false` they stay in memory.
- A server that does not know the field and rejects the batch with 400/422 gets the same batch again without it (no event is lost), and the SDK stops sending the field.
- **Limit:** a client that is fully blocked (an ad blocker, a firewall) cannot report anything: the report travels with a successful batch, so it only arrives once a later batch gets through. To reduce blocking, send events through a first-party endpoint on your own domain (a reverse proxy that forwards `/eventra/ingest` to Eventra's ingest URL, with the `x-api-key` header passed through) and set `endpoint` to it.

---

## Reliability Features

Eventra SDK includes:

- Idempotency (UUID v4 per event, stable across retries)
- Retry with exponential backoff + jitter (capped); `Retry-After` on 429/5xx is honoured (up to 30 s), also for the next scheduled flush after the last attempt
- Circuit breaker with half-open recovery: one probe request, cooldown doubles after each failed probe (5 s up to 60 s)
- Queue-based delivery (all runtimes)
- Safe dequeue (events removed only after successful ingest)
- Queue persistence (browser) with merge + cross-tab sync — opt out via `persistQueue: false` if `localStorage` isn't acceptable for your data
- Multi-tab leader election with re-election
- `fetch` + `keepalive` on tab close (with `x-api-key`, size-checked)
- `pagehide` + `visibilitychange` flush hooks
- Property validation at `track()` (depth + size) — fails soft via `onEventsDropped`, `track()` never throws
- Payload byte limits per batch
- Permanent error handling via `onDeliveryFailed` (401, 422, etc.)
- Automatic requeue on network errors and 429 / 5xx
- Delivery diagnostics: counts of dropped / failed events sent with the next successful batch (opt out with `diagnostics: false`)

---

## Test Coverage

**100% statement/branch/function/line coverage** (v8 provider, `pnpm test:coverage`).

280 vitest tests across 24 files (plus 7 Playwright tests in a real browser) cover the entire delivery pipeline:

- `track()` validation — name length, userId truncation, properties depth/size, idempotency keys
- Batching — auto-flush at `maxBatchSize`, periodic flush via timer, queue overflow drop
- Retry & backoff — 429, 5xx, network errors, no-retry on 4xx, fetch timeout/abort
- Circuit breaker - opens after 5 consecutive failed batches (each one after its retries), cools down, resets on success
- Payload guards — multi-batch splitting, oversize event dropped via `onDeliveryFailed(413)`
- Shutdown & destroy - flush ordering, timer teardown, idempotent shutdown, the `shutdownTimeoutMs` budget, signal handling (re-raise only when nobody else listens, PID 1, `exitOnSignal: false`)
- Persisted queue - coalesced writes, 14-day maximum age, delivered-key filtering, cross-tab merge
- Runtime detection — Node, Edge (`EdgeRuntime`), Serverless (AWS Lambda), unknown fallback, Node process exit handling
- Browser mode - persistence (with its size cap), leader election (including multi-tab lease races), BroadcastChannel sync, `fetch` keepalive, `pagehide` while a request is in flight, `pageshow` after a back/forward cache restore, a `window` that is not a browser
- Storage edge cases — corrupted/blocked localStorage, quota exceeded, queue trimming
- Internal fallbacks - `crypto.getRandomValues` (and a random id when there is no Web Crypto at all, as on Node 18), `Buffer`/string-length byte counting
- Regressions: `flush()` waiting for a flush already in flight, properties copied at `track()`, a corrupt stored queue

Run locally:

```bash
pnpm --filter @eventra_dev/eventra-sdk test
pnpm --filter @eventra_dev/eventra-sdk test:coverage
```

> **Node version note:** the SDK itself supports Node 18+ (see `engines`), but `vitest@4` depends on `node:util`'s `styleText`, which requires Node **≥ 20.12** - running the test suite on an older Node 20.x patch (or Node 18) fails to start. CI runs the matrix on Node 20 and 22; locally, use Node 20.19 or newer (20.x or 22.x).

---

## Event Format

```json
{
  "sentAt": "2026-03-12T10:00:00Z",
  "sdk": {
    "name": "@eventra_dev/eventra-sdk",
    "version": "<sdk-version>",
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

`idempotencyKey` is generated once per event and stays identical across every retry attempt of that event — delivery is **at-least-once, not exactly-once**. A retried batch resends the same events with the same keys, and under a slow network a request can be fully received and processed by the ingestion endpoint even after the SDK's own fetch timed out client-side and moved on to a retry — the backend seeing the same `idempotencyKey` more than once is expected, not a sign of a bug, and should be deduplicated on that key rather than on request count.

Limits enforced by the SDK at `track()` time:

| Field | Limit |
|-------|-------|
| `name` | trimmed, ≤ 64 chars |
| `userId` | ≤ 120 chars |
| `properties` (JSON serialized) | ≤ 32,000 bytes per event |
| Property nesting depth | ≤ 8 |
| Batch payload | ≤ `maxPayloadBytes` (default 60,000) |
| Fetch timeout | 5,000 ms |
| Circuit breaker | opens after 5 consecutive failed batches (each one after its retries), cools down 5,000 ms, doubling after each failed probe up to 60,000 ms |

---

## Docs

https://eventra.dev/docs

---

## License

MIT, copyright (c) 2026 [Yuriy Korolik](https://github.com/and-1991). See [LICENSE](LICENSE).
