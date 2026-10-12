import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real-browser checks for the persisted queue: localStorage writes are
// coalesced (debounced) and written immediately on pagehide, a reload picks
// the queue back up, delivered events are never sent again, and a second tab
// does not re-send what the first one already delivered. jsdom cannot cover
// pagehide, real storage events or BroadcastChannel between tabs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

const HARNESS_HTML = `<!doctype html>
<html><body><script type="module">
  window.__eventraReady = import("/index.mjs");
</script></body></html>`;

async function startServer(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HARNESS_HTML);
      return;
    }
    if (req.url === "/index.mjs") {
      const body = await readFile(path.join(distDir, "index.mjs"), "utf8");
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

type Delivered = string[];

// route the SDK endpoint: while `state.up` is false every request is aborted
// (what an ad blocker or an outage looks like); otherwise it is accepted and
// the event names are recorded
async function routeApi(
  page: Page,
  state: { up: boolean },
  delivered: Delivered,
) {
  await page.route("https://api.eventra.dev/**", async (route) => {
    if (!state.up) {
      await route.abort("failed");
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      events?: { name: string }[];
    };
    for (const e of body.events ?? []) delivered.push(e.name);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
}

const OPTIONS = {
  apiKey: "test-key",
  disableTimer: true,
  autoFlushOnExit: false,
  maxRetries: 1,
  retryBaseDelayMs: 1,
};

test.describe("persisted queue in a real browser", () => {
  test("a failed flush survives a reload, is delivered once, and is not re-sent", async ({
    page,
  }) => {
    const { server, url } = await startServer();
    try {
      const state = { up: false };
      const delivered: Delivered = [];
      await routeApi(page, state, delivered);

      await page.goto(url);
      await page.evaluate(async (opts) => {
        const mod = await (window as any).__eventraReady;
        const sdk = new mod.Eventra(opts);
        (window as any).__sdk = sdk;
        sdk.track("e2e.queue.a");
        sdk.track("e2e.queue.b");
        sdk.track("e2e.queue.c");
        await sdk.flush(); // fails: endpoint unreachable
      }, OPTIONS);

      // the debounced write has landed in real localStorage
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const raw = localStorage.getItem("__eventra_q__");
              return raw ? JSON.parse(raw).length : 0;
            }),
          { timeout: 2000 },
        )
        .toBe(3);
      expect(delivered).toEqual([]);

      // reload: a new SDK instance restores the queue and delivers it
      state.up = true;
      await page.reload();
      await page.evaluate(async (opts) => {
        const mod = await (window as any).__eventraReady;
        const sdk = new mod.Eventra(opts);
        (window as any).__sdk = sdk;
        await sdk.flush();
        await sdk.flush(); // nothing left: must not send anything again
      }, OPTIONS);

      expect([...delivered].sort()).toEqual([
        "e2e.queue.a",
        "e2e.queue.b",
        "e2e.queue.c",
      ]);

      // delivered events are gone from storage
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const raw = localStorage.getItem("__eventra_q__");
              return raw ? JSON.parse(raw).length : 0;
            }),
          { timeout: 2000 },
        )
        .toBe(0);
    } finally {
      server.close();
    }
  });

  test("pagehide writes the queue immediately, without waiting for the debounce", async ({
    page,
  }) => {
    const { server, url } = await startServer();
    try {
      const state = { up: false };
      await routeApi(page, state, []);
      await page.goto(url);

      const stored = await page.evaluate(async (opts) => {
        const mod = await (window as any).__eventraReady;
        const sdk = new mod.Eventra(opts);
        (window as any).__sdk = sdk;
        sdk.track("e2e.pagehide");
        // fire right away: a debounced write may not have happened yet
        window.dispatchEvent(new Event("pagehide"));
        const raw = localStorage.getItem("__eventra_q__");
        return raw ? JSON.parse(raw).length : 0;
      }, OPTIONS);

      expect(stored).toBe(1);
    } finally {
      server.close();
    }
  });

  test("a second tab does not re-send what the first tab already delivered", async ({
    context,
  }) => {
    const { server, url } = await startServer();
    try {
      const state = { up: true };
      const delivered: Delivered = [];

      const tabA = await context.newPage();
      await routeApi(tabA, state, delivered);
      await tabA.goto(url);

      await tabA.evaluate(async (opts) => {
        const mod = await (window as any).__eventraReady;
        const sdk = new mod.Eventra(opts);
        (window as any).__sdk = sdk;
        sdk.track("e2e.tabs.one");
        sdk.track("e2e.tabs.two");
        await sdk.flush();
      }, OPTIONS);
      expect([...delivered].sort()).toEqual(["e2e.tabs.one", "e2e.tabs.two"]);

      // tab B starts after the delivery and tracks its own event
      const tabB = await context.newPage();
      await routeApi(tabB, state, delivered);
      await tabB.goto(url);
      await tabB.evaluate(async (opts) => {
        const mod = await (window as any).__eventraReady;
        const sdk = new mod.Eventra(opts);
        (window as any).__sdk = sdk;
        sdk.track("e2e.tabs.three");
        await sdk.flush();
      }, OPTIONS);

      // and tab A flushes again afterwards
      await tabA.evaluate(async () => {
        await (window as any).__sdk.flush();
      });

      expect([...delivered].sort()).toEqual([
        "e2e.tabs.one",
        "e2e.tabs.three",
        "e2e.tabs.two",
      ]);
    } finally {
      server.close();
    }
  });
});
