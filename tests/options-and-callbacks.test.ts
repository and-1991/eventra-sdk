import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.restoreAllMocks();
});

function make(extra: Record<string, unknown>, responses: Array<number | "network" | "abort"> = [200]) {
  const { fetchImpl, calls } = createMockFetch({ responses });
  const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, ...extra } as never);
  active.push(sdk);
  return { sdk, calls };
}

describe("callbacks of the integrator never break the SDK", () => {
  it("a throwing onEventsDropped does not make track() throw", () => {
    const { sdk } = make({
      onEventsDropped: () => {
        throw new Error("boom");
      },
    });
    expect(() => sdk.track("   ")).not.toThrow();
  });

  it("a throwing onDeliveryFailed does not leave the rejected batch queued", async () => {
    const { sdk, calls } = make(
      {
        onDeliveryFailed: () => {
          throw new Error("boom");
        },
      },
      [422],
    );
    sdk.track("a");
    await sdk.flush();
    await sdk.flush();
    expect(calls).toHaveLength(1);
  });

  it("a rejecting async callback causes no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { sdk } = make({ onEventsDropped: async () => Promise.reject(new Error("async boom")) });
      sdk.track("");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("invalid options fall back to the defaults, with a warning", () => {
  const cases: Array<[string, unknown]> = [
    ["maxBatchSize", 0],
    ["maxBatchSize", -1],
    ["maxBatchSize", Number.NaN],
    ["maxQueueSize", 0],
    ["maxPayloadBytes", 0],
    ["maxPayloadBytes", -1],
    ["maxRetries", Number.NaN],
    ["flushInterval", Number.POSITIVE_INFINITY],
    ["flushInterval", 0],
    ["shutdownTimeoutMs", Number.NaN],
    ["retryBaseDelayMs", -5],
  ];
  for (const [name, value] of cases) {
    it(`${name}: ${String(value)} still delivers`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { sdk, calls } = make({ [name]: value });
      sdk.track("a");
      await sdk.flush();
      expect(calls).toHaveLength(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`"${name}"`))).toBe(true);
    });
  }

  it("an empty endpoint uses the default one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const withoutEndpoint = make({});
    withoutEndpoint.sdk.track("a");
    await withoutEndpoint.sdk.flush();
    const { sdk, calls } = make({ endpoint: "" });
    sdk.track("a");
    await sdk.flush();
    expect(calls[0].url).toBe(withoutEndpoint.calls[0].url);
    expect(calls[0].url).not.toBe("");
  });

  it("valid values, including maxRetries 0 and shutdownTimeoutMs 0, are kept without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    make({ maxRetries: 0, shutdownTimeoutMs: 0, maxBatchSize: 1, flushInterval: 10 });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("is invalid"))).toEqual([]);
  });

  it("new Eventra() without options says what is missing", () => {
    expect(() => new (Eventra as unknown as new (o?: unknown) => Eventra)()).toThrow(/apiKey required/);
    expect(() => new (Eventra as unknown as new (o?: unknown) => Eventra)({ apiKey: 5 })).toThrow(/apiKey required/);
  });
});

describe("flush on beforeExit is bounded", () => {
  const setup = () => {
    const onceSpy = vi.spyOn(process, "once");
    const made = make({ autoFlushOnExit: true });
    const beforeExit = onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").pop()![1] as () => void;
    return { ...made, beforeExit, internals: made.sdk as unknown as { shutdownDeadline: number; shuttingDown: boolean } };
  };

  it("sets a deadline for the flush and lifts it afterwards", async () => {
    const { sdk, calls, beforeExit, internals } = setup();
    sdk.track("last");
    beforeExit();
    expect(internals.shutdownDeadline).toBeGreaterThan(Date.now());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(internals.shutdownDeadline).toBe(0));
  });

  it("leaves a deadline that someone else set alone", async () => {
    const { sdk, calls, beforeExit, internals } = setup();
    sdk.track("last");
    const theirs = Date.now() + 60_000;
    internals.shutdownDeadline = theirs;
    beforeExit();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(internals.shutdownDeadline).toBe(theirs);
  });

  it("keeps the deadline when a shutdown started meanwhile", async () => {
    const { sdk, calls, beforeExit, internals } = setup();
    sdk.track("last");
    internals.shuttingDown = true;
    beforeExit();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(internals.shutdownDeadline).toBeGreaterThan(0);
  });
});

describe("options warnings without a console", () => {
  it("do not throw when there is no console", () => {
    vi.stubGlobal("console", undefined);
    try {
      expect(() => make({ maxBatchSize: 0 })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("flush() while a running flush fails unexpectedly", () => {
  it("still resolves and sends what is queued", async () => {
    const { sdk, calls } = make({});
    sdk.track("a");
    (sdk as unknown as { flushPromise: Promise<void> }).flushPromise = Promise.reject(new Error("unexpected"));
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("names and user ids", () => {
  const send = async (name: string, userId?: unknown) => {
    const { sdk, calls } = make({});
    sdk.track(name, { userId } as never);
    await sdk.flush();
    return calls[0]?.body.events[0] as { name: string; userId?: string } | undefined;
  };

  it("a name cut inside a space is trimmed again, as the CLI catalog holds it", async () => {
    const name = `${"a".repeat(63)} ${"b".repeat(10)}`;
    expect((await send(name))!.name).toBe("a".repeat(63));
  });

  it("a cut never leaves half an emoji", async () => {
    const name = `${"a".repeat(63)}😀tail`;
    const sent = (await send(name))!.name;
    expect(sent).toBe("a".repeat(63));
    expect(/[\uD800-\uDFFF]/.test(sent)).toBe(false);
  });

  it("a long user id is cut without half an emoji either", async () => {
    const sent = (await send("e", `${"u".repeat(119)}😀`))!.userId!;
    expect(sent).toBe("u".repeat(119));
  });

  it("userId null or an object means no user id, and a number is written out", async () => {
    expect((await send("e", null))!.userId).toBeUndefined();
    expect((await send("e", { id: 1 }))!.userId).toBeUndefined();
    expect((await send("e", 42))!.userId).toBe("42");
    expect((await send("e", 10n))!.userId).toBe("10");
    expect((await send("e", "plain"))!.userId).toBe("plain");
  });
});

describe("a custom fetch that ignores the abort signal", () => {
  it("does not hold the SDK forever", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (() => new Promise(() => undefined)) as unknown as typeof fetch;
      const sdk = new Eventra({ apiKey: "k", disableTimer: true, autoFlushOnExit: false, fetchImpl, maxRetries: 1 });
      active.push(sdk);
      sdk.track("a");
      const done = sdk.flush();
      await vi.advanceTimersByTimeAsync(6000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a request that fails after the deadline passed is still handled", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const { sdk } = make({ fetchImpl, maxRetries: 1 });
    sdk.track("a");
    await expect(sdk.flush()).resolves.toBeUndefined();
  });
});

describe("the reply body", () => {
  it("is closed, because only the status and headers are used", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = (async () => ({ status: 200, ok: true, body: { cancel }, headers: { get: () => null } })) as unknown as typeof fetch;
    const { sdk } = make({ fetchImpl });
    sdk.track("a");
    await sdk.flush();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a body that cannot be closed does not matter", async () => {
    for (const body of [{ cancel: () => { throw new Error("x"); } }, { cancel: () => Promise.reject(new Error("x")) }, { cancel: () => 1 }]) {
      const fetchImpl = (async () => ({ status: 200, ok: true, body })) as unknown as typeof fetch;
      const { sdk, calls } = make({ fetchImpl });
      sdk.track("a");
      await expect(sdk.flush()).resolves.toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  });
});

describe("beforeExit is listened to again", () => {
  it("each time the loop drains, so events tracked later are still delivered", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const { sdk, calls } = make({ autoFlushOnExit: true });
    const calls1 = onceSpy.mock.calls.filter((c) => c[0] === "beforeExit");
    const handler = calls1.pop()![1] as () => void;
    handler();
    expect(onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").length).toBe(calls1.length + 2);
    sdk.track("later");
    handler();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("not once the SDK is destroyed", () => {
    const onceSpy = vi.spyOn(process, "once");
    const { sdk } = make({ autoFlushOnExit: true });
    const handler = onceSpy.mock.calls.filter((c) => c[0] === "beforeExit").pop()![1] as () => void;
    sdk.destroy();
    const before = onceSpy.mock.calls.length;
    handler();
    expect(onceSpy.mock.calls.length).toBe(before);
  });
});
