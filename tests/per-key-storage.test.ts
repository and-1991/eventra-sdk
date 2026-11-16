import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

// Up to 2.1.0 the stored queue, the channel between tabs, the leader lease and the delivery counters were one
// for every API key of a site. With two Eventra projects on a page (an app and a third-party widget), an event
// of one went out under the other's key with its user id: the events of a tab that closed before sending, and
// events a tracker created right after `await flush()` found in localStorage before their removal was written.

// FNV-1a of "app" and "widget", the suffix of every name below
const APP = "1f6a832c";
const WIDGET = "a9802c05";

let env: BrowserEnvHandle;
const active: Eventra[] = [];

beforeEach(() => {
  env = installBrowserEnv();
});

afterEach(() => {
  for (const sdk of active.splice(0)) sdk.destroy();
  env.restore();
  vi.restoreAllMocks();
});

function tracker(apiKey: string, extra: Record<string, unknown> = {}) {
  const mock = createMockFetch({ responses: [200] });
  const sdk = new Eventra({ apiKey, disableTimer: true, autoFlushOnExit: false, fetchImpl: mock.fetchImpl, ...extra });
  active.push(sdk);
  return { sdk, calls: mock.calls };
}

const sent = (calls: ReturnType<typeof tracker>["calls"]) =>
  calls.flatMap((c) => c.body.events.map((e) => `${c.headers["x-api-key"]}:${String(e.name)}`));

const stored = (name: string) => JSON.parse(env.storage.getItem(name) ?? "[]") as Array<{ name: string }>;

describe("two Eventra projects on one site", () => {
  it("keep their queues apart in localStorage", async () => {
    vi.useFakeTimers();
    const app = tracker("app");
    const widget = tracker("widget");
    app.sdk.track("app.event", { userId: "u1" });
    widget.sdk.track("widget.event");
    await vi.advanceTimersByTimeAsync(60);

    expect(stored(`__eventra_q__${APP}`).map((e) => e.name)).toEqual(["app.event"]);
    expect(stored(`__eventra_q__${WIDGET}`).map((e) => e.name)).toEqual(["widget.event"]);
    expect(env.storage.getItem("__eventra_q__")).toBeNull();
  });

  it("never send the events of a tab that closed before sending them under the other key", async () => {
    const closing = tracker("app");
    closing.sdk.track("app.event", { userId: "u1" });
    closing.sdk.destroy(); // the tab closes: its event stays in localStorage and was announced to other tabs

    const widget = tracker("widget");
    const app = tracker("app");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await widget.sdk.flush();
    await app.sdk.flush();

    expect(sent(widget.calls)).toEqual([]);
    expect(sent(app.calls)).toEqual(["app:app.event"]);
  });

  it("never take the events another project's tab announces", async () => {
    const app = tracker("app");
    const widget = tracker("widget");
    app.sdk.track("app.event");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
    await widget.sdk.flush();

    expect(sent(widget.calls)).toEqual([]);
  });

  it("each have a leader tab of their own", async () => {
    const app = tracker("app", { multiTabMode: "leader" });
    const widget = tracker("widget", { multiTabMode: "leader" });
    app.sdk.track("a");
    widget.sdk.track("w");
    await app.sdk.flush();
    await widget.sdk.flush();

    expect(sent(app.calls)).toEqual(["app:a"]);
    expect(sent(widget.calls)).toEqual(["widget:w"]);
    expect(env.storage.getItem(`__eventra_leader__${APP}`)).not.toBeNull();
    expect(env.storage.getItem(`__eventra_leader__${WIDGET}`)).not.toBeNull();
  });

  it("keep their delivery counters apart", async () => {
    const failing = createMockFetch({ responses: ["network"] });
    const app = new Eventra({ apiKey: "app", disableTimer: true, autoFlushOnExit: false, maxRetries: 0, fetchImpl: failing.fetchImpl });
    active.push(app);
    app.track("a");
    await app.flush();

    const widget = tracker("widget");
    widget.sdk.track("w");
    await widget.sdk.flush();

    expect(widget.calls[0].body).not.toHaveProperty("diagnostics");
    expect(env.storage.getItem(`__eventra_d__${APP}`)).not.toBeNull();
  });
});

describe("a tracker created right after await flush()", () => {
  it("does not send the delivered events again", async () => {
    vi.useFakeTimers();
    const first = tracker("app");
    first.sdk.track("once");
    await vi.advanceTimersByTimeAsync(60); // the queue is written to localStorage
    await first.sdk.flush();

    const second = tracker("app");
    await second.sdk.flush();

    expect(sent(first.calls)).toEqual(["app:once"]);
    expect(second.calls).toHaveLength(0);
    expect(stored(`__eventra_q__${APP}`)).toEqual([]);
  });
});

describe("the queue an earlier version left in localStorage", () => {
  it("is taken once by the first tracker that loads, and removed", async () => {
    const event = { idempotencyKey: "11111111-1111-4111-8111-111111111111", name: "left.by.2.1.0", properties: {}, timestamp: new Date().toISOString() };
    env.storage.setItem("__eventra_q__", JSON.stringify([event]));
    env.storage.setItem("__eventra_d__", JSON.stringify({ counts: { dropped: 0, failed: 1, byReason: { network: 1 } } }));

    const app = tracker("app");
    const widget = tracker("widget");
    await app.sdk.flush();
    await widget.sdk.flush();

    expect(sent(app.calls)).toEqual(["app:left.by.2.1.0"]);
    expect(widget.calls).toHaveLength(0);
    expect(env.storage.getItem("__eventra_q__")).toBeNull();
    expect(env.storage.getItem("__eventra_d__")).toBeNull();
  });

  it("drops events from it that are too old to send", async () => {
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const event = { idempotencyKey: "22222222-2222-4222-8222-222222222222", name: "too.old", properties: {}, timestamp: old };
    env.storage.setItem("__eventra_q__", JSON.stringify([event]));

    const app = tracker("app");
    await app.sdk.flush();

    expect(app.calls).toHaveLength(0);
    expect(env.storage.getItem("__eventra_q__")).toBeNull();
  });

  it("is left alone when it is not a list", async () => {
    env.storage.setItem("__eventra_q__", "{broken");
    const app = tracker("app");
    await app.sdk.flush();

    expect(app.calls).toHaveLength(0);
    expect(env.storage.getItem("__eventra_q__")).toBe("{broken");
  });
});
