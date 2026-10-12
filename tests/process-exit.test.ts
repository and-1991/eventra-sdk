import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.useRealTimers();
});

describe("process exit handling (Node runtime, autoFlushOnExit default)", () => {
  it("registers SIGINT/SIGTERM handlers that flush-and-shutdown, and unregisters them on destroy", async () => {
    const onceSpy = vi.spyOn(process, "once");
    const offSpy = vi.spyOn(process, "off");
    // never let a test really signal the process, even if the behavior changes
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    // autoFlushOnExit left at its default (true) so setupProcessExit() runs
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      fetchImpl,
    });
    active.push(sdk);

    expect(onceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    const sigintHandler = onceSpy.mock.calls.find((c) => c[0] === "SIGINT")?.[1] as (
      ...args: unknown[]
    ) => void;
    expect(sigintHandler).toBeTypeOf("function");

    sdk.track("bye");
    sigintHandler();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["bye"]);
    // default: flush and nothing else, the app owns its own shutdown
    await new Promise((r) => setTimeout(r, 50));
    expect(killSpy).not.toHaveBeenCalled();

    sdk.destroy();
    expect(offSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
    expect(offSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    killSpy.mockRestore();
    onceSpy.mockRestore();
    offSpy.mockRestore();
  });

  it("does nothing when the process-like global has no .on (e.g. a restricted runtime)", () => {
    const originalProcess = globalThis.process;
    (globalThis as { process?: unknown }).process = { env: {}, versions: {} };

    try {
      const { fetchImpl } = createMockFetch({ responses: [200] });
      expect(() => {
        const sdk = new Eventra({
          apiKey: "k",
          disableTimer: true,
          fetchImpl,
        });
        active.push(sdk);
      }).not.toThrow();
    } finally {
      (globalThis as { process?: unknown }).process = originalProcess;
    }
  });
});
