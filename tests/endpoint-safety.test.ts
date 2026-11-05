import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];

afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
  vi.restoreAllMocks();
});

function make(endpoint: string, fetchImpl: typeof fetch) {
  const sdk = new Eventra({
    apiKey: "k",
    endpoint,
    disableTimer: true,
    autoFlushOnExit: false,
    fetchImpl,
  });
  active.push(sdk);
  return sdk;
}

describe("endpoint safety", () => {
  it("never follows a redirect, so the API key cannot be forwarded to another host", async () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });
    const sdk = make("https://api.example.com/v1/ingest/batch", fetchImpl as unknown as typeof fetch);

    sdk.track("a");
    await sdk.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
  });

  it("warns once about a plain http endpoint on a remote host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = createMockFetch({ responses: [200] });

    make("http://collector.internal.example.com/v1/ingest/batch", fetchImpl as unknown as typeof fetch);

    const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("plain http"));
    expect(messages).toHaveLength(1);
  });

  it.each(["https://api.example.com/x", "http://localhost:4000/x", "http://127.0.0.1:4000/x"])(
    "does not warn for %s",
    (endpoint) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { fetchImpl } = createMockFetch({ responses: [200] });

      make(endpoint, fetchImpl as unknown as typeof fetch);

      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("plain http"))).toHaveLength(0);
    },
  );

  it("does not throw on a malformed endpoint", () => {
    const { fetchImpl } = createMockFetch({ responses: [200] });

    expect(() => make("not a url", fetchImpl as unknown as typeof fetch)).not.toThrow();
  });
});
