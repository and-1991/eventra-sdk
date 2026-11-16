import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Eventra, type TrackerOptions } from "../src";
import { createMockFetch } from "./helpers/mockFetch";
import { installBrowserEnv, type BrowserEnvHandle } from "./helpers/browserEnv";

const USER_PREFIX = "__eventra_u__";

let active: Eventra[] = [];

function makeSdk(extra: Partial<TrackerOptions> = {}) {
  const { fetchImpl, calls } = createMockFetch({ responses: [200] });
  const sdk = new Eventra({
    apiKey: "k",
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
    ...extra,
  });
  active.push(sdk);
  return { sdk, calls };
}

async function sentUserIds(sdk: Eventra, calls: ReturnType<typeof makeSdk>["calls"]) {
  await sdk.flush();
  return calls.flatMap((c) => c.body.events.map((e) => e.userId));
}

// the user is stored under a key named after the API key: find it whatever the hash is
function storedUserKeys(env: BrowserEnvHandle): string[] {
  const keys: string[] = [];
  for (let i = 0; i < env.storage.length; i++) {
    const key = env.storage.key(i)!;
    if (key.startsWith(USER_PREFIX)) keys.push(key);
  }
  return keys;
}

function userKeyOf(sdk: Eventra): string {
  return (sdk as unknown as { userKey: string }).userKey;
}

// runs `fn` with a global the SDK reads at construction, put back afterwards
function withGlobal<T>(name: string, value: unknown, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, name);
  const before = g[name];
  Object.defineProperty(g, name, { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(g, name, { value: before, configurable: true, writable: true });
    else delete g[name];
  }
}

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.restoreAllMocks();
});

describe("identify() in the browser", () => {
  let env: BrowserEnvHandle;
  beforeEach(() => {
    env = installBrowserEnv();
  });
  afterEach(() => env.restore());

  it("adds the identified user to every following event", async () => {
    const { sdk, calls } = makeSdk();
    sdk.track("before");
    sdk.identify("user_1");
    sdk.track("after");
    expect(sdk.getUserId()).toBe("user_1");
    expect(await sentUserIds(sdk, calls)).toEqual([undefined, "user_1"]);
  });

  it("writes a number out as text and cuts a long id to 120 characters", () => {
    const { sdk } = makeSdk();
    sdk.identify(42);
    expect(sdk.getUserId()).toBe("42");
    sdk.identify(0);
    expect(sdk.getUserId()).toBe("0");
    sdk.identify("u".repeat(200));
    expect(sdk.getUserId()).toBe("u".repeat(120));
  });

  it("a userId of the call wins, null sends the event without a user, and a blank one counts as not given", async () => {
    const { sdk, calls } = makeSdk();
    sdk.identify("user_1");
    sdk.track("own", { userId: "user_2" });
    sdk.track("none", { userId: null });
    sdk.track("blank", { userId: "  " });
    sdk.track("empty", { userId: "" });
    sdk.track("default");
    expect(await sentUserIds(sdk, calls)).toEqual(["user_2", undefined, "user_1", "user_1", "user_1"]);
  });

  it("keeps the user of an event already tracked when reset() follows before the send", async () => {
    const { sdk, calls } = makeSdk();
    sdk.identify("user_1");
    sdk.track("a");
    sdk.reset();
    sdk.track("b");
    expect(await sentUserIds(sdk, calls)).toEqual(["user_1", undefined]);
  });

  it("refuses values that name nobody, with one warning, and keeps the current user", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    sdk.identify("user_1");
    for (const bad of ["", "   ", "undefined", " null ", null, undefined, {}, Number.NaN]) {
      sdk.identify(bad as unknown as string);
    }
    expect(sdk.getUserId()).toBe("user_1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/reset\(\)/);
  });

  it("keeps the user in localStorage, so a reload sends its first events with it", async () => {
    const first = makeSdk();
    first.sdk.identify("user_1");
    expect(JSON.parse(env.storage.getItem(userKeyOf(first.sdk)) as string)).toBe("user_1");
    first.sdk.destroy();

    const second = makeSdk();
    expect(second.sdk.getUserId()).toBe("user_1");
    second.sdk.track("after_reload");
    expect(await sentUserIds(second.sdk, second.calls)).toEqual(["user_1"]);
  });

  it("keeps the storage key stable across releases (a new key would forget every stored user on upgrade)", () => {
    // FNV-1a of the API key, in hex: pinned on purpose
    expect(userKeyOf(makeSdk({ apiKey: "k" }).sdk)).toBe("__eventra_u__ee0c38ea");
    expect(userKeyOf(makeSdk({ apiKey: "test-key-abc" }).sdk)).toBe("__eventra_u__ebc799da");
  });

  it("stores the user per API key, so another project on the same site never gets it", () => {
    const mine = makeSdk({ apiKey: "key-a" }).sdk;
    const widget = makeSdk({ apiKey: "key-b" }).sdk;
    mine.identify("user_1");
    expect(widget.getUserId()).toBeUndefined();

    widget.reset();
    expect(mine.getUserId()).toBe("user_1");
    expect(storedUserKeys(env)).toEqual([userKeyOf(mine)]);
    expect(userKeyOf(mine)).not.toContain("key-a");

    expect(makeSdk({ apiKey: "key-b" }).sdk.getUserId()).toBeUndefined();
  });

  it("ignores a stored value that is not a usable id", () => {
    const key = userKeyOf(makeSdk().sdk);
    env.storage.setItem(key, "123");
    expect(makeSdk().sdk.getUserId()).toBeUndefined();
    env.storage.setItem(key, JSON.stringify("   "));
    expect(makeSdk().sdk.getUserId()).toBeUndefined();
    env.storage.setItem(key, "{not json");
    expect(makeSdk().sdk.getUserId()).toBeUndefined();
  });

  it("with persistQueue: false keeps the user in memory only and clears one stored earlier", async () => {
    const key = userKeyOf(makeSdk().sdk);
    env.storage.setItem(key, JSON.stringify("stale"));

    const { sdk, calls } = makeSdk({ persistQueue: false });
    expect(env.storage.getItem(key)).toBeNull();
    expect(sdk.getUserId()).toBeUndefined();

    sdk.identify("user_1");
    sdk.track("a");
    expect(env.storage.getItem(key)).toBeNull();
    expect(await sentUserIds(sdk, calls)).toEqual(["user_1"]);
  });

  it("reset() forgets the user and removes it from localStorage", () => {
    const { sdk } = makeSdk();
    sdk.identify("user_1");
    sdk.reset();
    expect(sdk.getUserId()).toBeUndefined();
    expect(storedUserKeys(env)).toEqual([]);
  });

  it("reset() clears a stored user and tells the other tabs even when this tab holds none", () => {
    const other = makeSdk({ persistQueue: false }).sdk;
    other.identify("user_1");
    const { sdk } = makeSdk({ persistQueue: false });
    env.storage.setItem(userKeyOf(sdk), JSON.stringify("left_behind"));
    expect(sdk.getUserId()).toBeUndefined(); // a tab that missed the identify message

    sdk.reset();

    expect(other.getUserId()).toBeUndefined();
    expect(storedUserKeys(env)).toEqual([]);
  });

  it("calls after destroy() do nothing", () => {
    const { sdk } = makeSdk();
    sdk.identify("user_1");
    sdk.destroy();
    sdk.reset();
    expect(sdk.getUserId()).toBe("user_1");
    sdk.identify("user_2");
    expect(sdk.getUserId()).toBe("user_1");
  });

  it("identify() with the same user again does not announce it again", () => {
    const { sdk } = makeSdk();
    sdk.identify("user_1");
    const post = vi.spyOn(
      (sdk as unknown as { channel: { postMessage: (m: unknown) => void } }).channel,
      "postMessage",
    );
    sdk.identify("user_1");
    expect(post).not.toHaveBeenCalled();
  });

  it("shares identify() and reset() with the other open tabs through the channel", () => {
    const a = makeSdk({ persistQueue: false }).sdk;
    const b = makeSdk({ persistQueue: false }).sdk;
    a.identify("user_1");
    expect(b.getUserId()).toBe("user_1");
    a.reset();
    expect(b.getUserId()).toBeUndefined();
  });

  it("survives a message on the channel that is not an object", () => {
    const a = makeSdk({ persistQueue: false }).sdk;
    const b = makeSdk({ persistQueue: false }).sdk;
    a.identify("user_1");
    const channel = (a as unknown as { channel: BroadcastChannel }).channel;
    expect(() => channel.postMessage(null)).not.toThrow();
    expect(() => channel.postMessage(undefined)).not.toThrow();
    expect(b.getUserId()).toBe("user_1");
  });

  it("ignores a user message from the channel that holds no usable id or belongs to another project", () => {
    const a = makeSdk({ persistQueue: false }).sdk;
    const b = makeSdk({ persistQueue: false }).sdk;
    a.identify("user_1");
    const key = userKeyOf(a);
    const channel = (a as unknown as { channel: BroadcastChannel }).channel;
    channel.postMessage({ type: "user", key, userId: "   " });
    channel.postMessage({ type: "user", key, userId: 7 });
    channel.postMessage({ type: "user", key });
    channel.postMessage({ type: "user", key: "other", userId: null });
    channel.postMessage({ type: "user", userId: "intruder" });
    expect(b.getUserId()).toBe("user_1");
  });

  it("follows another tab through the storage event, also when the storage is cleared", () => {
    const { sdk } = makeSdk();
    const key = userKeyOf(sdk);
    env.storage.setItem(key, JSON.stringify("user_9"));
    env.window.dispatch("storage", { key });
    expect(sdk.getUserId()).toBe("user_9");

    env.storage.clear();
    env.window.dispatch("storage", { key: null });
    expect(sdk.getUserId()).toBeUndefined();

    env.storage.setItem(key, JSON.stringify("user_10"));
    env.window.dispatch("storage", { key: "something_else" });
    expect(sdk.getUserId()).toBeUndefined();
  });

  it("works in a browser whose localStorage is blocked", async () => {
    const g = globalThis as { localStorage?: unknown };
    g.localStorage = {
      setItem() {
        throw new Error("SecurityError");
      },
    };
    const { sdk, calls } = makeSdk();
    sdk.identify("user_1");
    sdk.track("a");
    sdk.reset();
    expect(sdk.getUserId()).toBeUndefined();
    expect(await sentUserIds(sdk, calls)).toEqual(["user_1"]);
  });
});

describe("identify() outside a browser", () => {
  function makeWithoutNode(extra: Partial<TrackerOptions> = {}) {
    // no process.versions.node: the runtime is "unknown" (React Native, Deno 1, Cloudflare Workers)
    return withGlobal("process", { env: {} }, () => makeSdk(extra));
  }

  it("works in memory in React Native", async () => {
    const { sdk, calls } = withGlobal("navigator", { product: "ReactNative" }, () => makeWithoutNode());
    expect((sdk as unknown as { runtime: string }).runtime).toBe("unknown");
    sdk.identify("user_1");
    sdk.track("a");
    sdk.reset();
    sdk.track("b");
    expect(await sentUserIds(sdk, calls)).toEqual(["user_1", undefined]);
  });

  it("never writes to a localStorage polyfill in React Native: only a browser keeps the user", () => {
    const storage = new Map<string, string>();
    const polyfill = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    };
    const { sdk } = withGlobal("localStorage", polyfill, () =>
      withGlobal("navigator", { product: "ReactNative" }, () => makeWithoutNode()),
    );
    withGlobal("localStorage", polyfill, () => {
      sdk.identify("user_1");
      expect(storage.size).toBe(0);
      storage.set(userKeyOf(sdk), JSON.stringify("other"));
      sdk.reset();
      expect(storage.size).toBe(1);
    });
  });

  it("is ignored in another unknown runtime (Cloudflare Workers, Deno), where one instance serves many requests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk, calls } = withGlobal("navigator", { userAgent: "Cloudflare-Workers" }, () => makeWithoutNode());
    sdk.identify("user_a");
    sdk.track("request_b");
    expect(sdk.getUserId()).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toMatch(/withUser/);
    expect(await sentUserIds(sdk, calls)).toEqual([undefined]);
  });

  it("counts as not React Native when navigator cannot be read", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throwing = {};
    Object.defineProperty(throwing, "product", {
      get() {
        throw new Error("no");
      },
    });
    const { sdk } = withGlobal("navigator", throwing, () => makeWithoutNode());
    sdk.identify("user_1");
    expect(sdk.getUserId()).toBeUndefined();
  });

  it("is ignored with one warning on Node, and reset() there does nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk, calls } = makeSdk();
    sdk.identify("user_1");
    sdk.identify("user_2");
    sdk.reset();
    sdk.track("a");
    expect(sdk.getUserId()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/withUser/);
    expect(await sentUserIds(sdk, calls)).toEqual([undefined]);
  });

  it("is ignored in serverless and on the edge too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const g = globalThis as { EdgeRuntime?: unknown };
    g.EdgeRuntime = "edge";
    try {
      const { sdk } = makeSdk();
      sdk.identify("user_1");
      expect(sdk.getUserId()).toBeUndefined();
    } finally {
      delete g.EdgeRuntime;
    }

    process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
    try {
      const { sdk } = makeSdk();
      sdk.identify("user_1");
      expect(sdk.getUserId()).toBeUndefined();
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });
});

describe("withUser()", () => {
  it("binds the user to the events of the scope only", async () => {
    const { sdk, calls } = makeSdk();
    const alice = sdk.withUser("alice");
    const bob = sdk.withUser(7);
    alice.track("a");
    bob.track("b");
    sdk.track("c");
    expect(await sentUserIds(sdk, calls)).toEqual(["alice", "7", undefined]);
  });

  it("a userId of the call wins over the scope, null sends without a user, and a blank one counts as not given", async () => {
    const { sdk, calls } = makeSdk();
    const alice = sdk.withUser("alice");
    alice.track("own", { userId: "bob" });
    alice.track("none", { userId: null });
    alice.track("blank", { userId: "" });
    alice.track("props", { properties: { plan: "pro" } });
    await sdk.flush();
    const events = calls.flatMap((c) => c.body.events);
    expect(events.map((e) => e.userId)).toEqual(["bob", undefined, "alice", "alice"]);
    expect(events[3].properties).toEqual({ plan: "pro" });
  });

  it("a valid id gives no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    sdk.withUser("alice").track("a");
    sdk.withUser(7).track("b");
    expect(warn).not.toHaveBeenCalled();
  });

  it("undefined or null give a scope without a user and no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk, calls } = makeSdk();
    sdk.withUser(undefined).track("a");
    sdk.withUser(null).track("b");
    expect(warn).not.toHaveBeenCalled();
    expect(await sentUserIds(sdk, calls)).toEqual([undefined, undefined]);
  });

  it("warns once about an invalid id and sends its events without one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk, calls } = makeSdk();
    sdk.withUser("  ").track("a");
    sdk.withUser("undefined").track("b");
    sdk.withUser({} as unknown as string).track("c");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^Eventra: withUser\(\) got an invalid user id/);
    expect(await sentUserIds(sdk, calls)).toEqual([undefined, undefined, undefined]);
  });

  it("drops an invalid event of a scope like track() does, without throwing", () => {
    const onEventsDropped = vi.fn();
    const { sdk } = makeSdk({ onEventsDropped });
    const scope = sdk.withUser("alice");
    expect(() => scope.track("")).not.toThrow();
    const options = Object.defineProperty({}, "userId", {
      get() {
        throw new Error("getter");
      },
    });
    expect(() => scope.track("x", options)).not.toThrow();
    expect(onEventsDropped).toHaveBeenCalledTimes(2);
  });

  it("reports an event a scope had to drop under the same reason as track() does", async () => {
    const { sdk, calls } = makeSdk();
    const options = Object.defineProperty({}, "userId", {
      get() {
        throw new Error("getter");
      },
    });
    sdk.withUser("alice").track("x", options);
    sdk.track("ok");
    await sdk.flush();
    const body = calls[0].body as unknown as { diagnostics?: { byReason: Record<string, number> } };
    expect(body.diagnostics?.byReason).toEqual({ invalid_event: 1 });
  });

  it("in the browser, a scope without a user never falls back to the identified one", async () => {
    const env = installBrowserEnv();
    try {
      const { sdk, calls } = makeSdk();
      sdk.identify("me");
      sdk.withUser(undefined).track("a");
      sdk.withUser(null).track("b");
      sdk.withUser("other").track("c");
      sdk.track("d");
      expect(await sentUserIds(sdk, calls)).toEqual([undefined, undefined, "other", "me"]);
    } finally {
      env.restore();
    }
  });
});

describe("identifyHint", () => {
  const hintWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((call) => /has a userId/.test(String(call[0]))).length;

  // the hint is about development; vitest itself runs with NODE_ENV=test, which never warns
  let nodeEnvBefore: string | undefined;
  beforeEach(() => {
    nodeEnvBefore = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });
  afterEach(() => {
    process.env.NODE_ENV = nodeEnvBefore;
  });

  function trackMany(target: { track: (name: string, options?: { userId?: string }) => void }, n: number, userId?: string) {
    for (let i = 0; i < n; i++) target.track("e", userId === undefined ? undefined : { userId });
  }

  it("warns once on a server when none of the first 50 events has a user", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    trackMany(sdk, 49);
    expect(warn).not.toHaveBeenCalled();
    trackMany(sdk, 100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/tracker\.withUser/);
  });

  it("points at identify() in the browser", () => {
    const env = installBrowserEnv();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { sdk } = makeSdk();
      trackMany(sdk, 50);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/tracker\.identify\(userId\)/);
    } finally {
      env.restore();
    }
  });

  it("does not count a blank userId as a user", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    sdk.track("e", { userId: null });
    trackMany(sdk, 49, "");
    expect(hintWarnings(warn)).toBe(1);
  });

  it("is not silenced by a scope without a user", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    sdk.withUser(undefined);
    sdk.withUser(null);
    trackMany(sdk, 50);
    expect(hintWarnings(warn)).toBe(1);
  });

  it("stays silent once an event carries a user, or identify()/withUser() got one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const own = makeSdk().sdk;
    own.track("e", { userId: "u" });
    trackMany(own, 60);

    const scoped = makeSdk().sdk;
    scoped.withUser("u");
    trackMany(scoped, 60);

    const env = installBrowserEnv();
    try {
      const identified = makeSdk().sdk;
      identified.identify("u");
      identified.reset();
      trackMany(identified, 60);
    } finally {
      env.restore();
    }
    expect(hintWarnings(warn)).toBe(0);
  });

  it("on a server warns only when NODE_ENV says development (Lambda and Docker often set none)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const env of [undefined, "production", "test", "staging"]) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      trackMany(makeSdk().sdk, 60);
    }
    expect(hintWarnings(warn)).toBe(0);
  });

  it("in a browser warns unless the bundle is for production or a test run", () => {
    const env = installBrowserEnv();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (const value of ["production", "test"]) {
        process.env.NODE_ENV = value;
        trackMany(makeSdk().sdk, 60);
      }
      expect(hintWarnings(warn)).toBe(0);
      delete process.env.NODE_ENV;
      trackMany(makeSdk().sdk, 60);
      expect(hintWarnings(warn)).toBe(1);
    } finally {
      env.restore();
    }
  });

  it("stays silent with identifyHint: false", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    trackMany(makeSdk({ identifyHint: false }).sdk, 60);
    expect(hintWarnings(warn)).toBe(0);
  });

  it("counts as production where process.env cannot be read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk();
    trackMany(sdk, 49);
    const proc = process as unknown as { env: unknown };
    const envBefore = proc.env;
    proc.env = undefined;
    try {
      sdk.track("e");
    } finally {
      proc.env = envBefore;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("counts as production in a browser bundle that has no process (NODE_ENV not replaced)", () => {
    const env = installBrowserEnv();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { sdk } = makeSdk();
      trackMany(sdk, 49);
      const proc = process as unknown as { env: unknown };
      const envBefore = proc.env;
      proc.env = undefined;
      try {
        sdk.track("e");
      } finally {
        proc.env = envBefore;
      }
      expect(hintWarnings(warn)).toBe(0);
    } finally {
      env.restore();
    }
  });

  it("warns about an identifyHint that is not a boolean and keeps the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sdk } = makeSdk({ identifyHint: "no" as unknown as boolean });
    expect(String(warn.mock.calls[0][0])).toMatch(/identifyHint/);
    trackMany(sdk, 50);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
