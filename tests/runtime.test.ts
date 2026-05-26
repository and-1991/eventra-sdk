import { afterEach, describe, expect, it } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
});

function runtimeFromSdk(sdk: Eventra): string {
  return (sdk as unknown as { runtime: string }).runtime;
}

describe("runtime detection", () => {
  it("reports 'node' when running on Node without serverless markers", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
    });
    active.push(sdk);
    expect(runtimeFromSdk(sdk)).toBe("node");
  });

  it("reports 'serverless' when AWS_LAMBDA_FUNCTION_NAME is set", () => {
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });
    const original = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = "test-fn";

    try {
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        autoFlushOnExit: false,
        fetchImpl,
      });
      active.push(sdk);
      expect(runtimeFromSdk(sdk)).toBe("serverless");

      // serverless mode triggers an immediate flush per track()
      sdk.track("a");
      // give microtask queue a tick
      return Promise.resolve().then(() => {
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      if (original === undefined) {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      } else {
        process.env.AWS_LAMBDA_FUNCTION_NAME = original;
      }
    }
  });

  it("reports 'edge' when EdgeRuntime global is defined", () => {
    const g = globalThis as { EdgeRuntime?: unknown };
    const had = "EdgeRuntime" in g;
    g.EdgeRuntime = "edge-runtime-vercel";

    try {
      const { fetchImpl } = createMockFetch({ responses: [200] });
      const sdk = new Eventra({
        apiKey: "k",
        disableTimer: true,
        autoFlushOnExit: false,
        fetchImpl,
      });
      active.push(sdk);
      expect(runtimeFromSdk(sdk)).toBe("edge");
    } finally {
      if (!had) delete (g as { EdgeRuntime?: unknown }).EdgeRuntime;
    }
  });
});
