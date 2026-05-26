import { vi } from "vitest";

export type FetchCall = {
  url: string;
  body: { sentAt: string; sdk: unknown; events: Array<Record<string, unknown>> };
  headers: Record<string, string>;
  keepalive: boolean;
};

export type MockFetchOptions = {
  // queue of status codes / errors to return on each subsequent call
  // - number = HTTP status
  // - "network" = network error (rejected promise)
  // - "abort" = AbortError to simulate timeout
  responses: Array<number | "network" | "abort">;
};

export function createMockFetch(opts: MockFetchOptions) {
  const calls: FetchCall[] = [];
  let cursor = 0;

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const keepalive = !!(init as RequestInit & { keepalive?: boolean })?.keepalive;

    calls.push({ url, body, headers, keepalive });

    const r = opts.responses[Math.min(cursor, opts.responses.length - 1)];
    cursor++;

    if (r === "network") {
      throw new TypeError("network error");
    }
    if (r === "abort") {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }

    return {
      status: r,
      ok: r >= 200 && r < 300,
    } as unknown as Response;
  });

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    mock: fetchImpl,
  };
}
