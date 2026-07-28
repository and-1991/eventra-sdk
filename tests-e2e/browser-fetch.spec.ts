import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The vitest suite (tests/browser.test.ts) always injects a mocked
// `fetchImpl`, so it never exercises the real `globalThis.fetch`. Native
// browser fetch is a WebIDL operation that requires its receiver (`this`)
// to be the global object — calling it detached (e.g. `this.fetch(...)`
// on an SDK instance) throws "Illegal invocation" synchronously, before
// any request is sent. Only a real browser reproduces that check, which is
// why this lives in Playwright instead of vitest/jsdom.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

const HARNESS_HTML = `<!doctype html>
<html>
  <body>
    <script type="module">
      window.__eventraReady = import("/index.mjs");
    </script>
  </body>
</html>`;

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

test.describe("real browser fetch", () => {
  test("flush() delivers events via native window.fetch (no fetchImpl override)", async ({
    page,
  }) => {
    const { server, url } = await startServer();

    try {
      let requestCount = 0;
      await page.route("https://api.eventra.dev/**", (route) => {
        requestCount++;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      });

      await page.goto(url);

      const flushed = await page.evaluate(async () => {
        const mod = await (window as unknown as { __eventraReady: Promise<any> })
          .__eventraReady;
        const sdk = new mod.Eventra({
          apiKey: "test-key",
          disableTimer: true,
          autoFlushOnExit: false,
          maxRetries: 1,
        });

        sdk.track("e2e.smoke");
        await sdk.flush();
        sdk.destroy();
        return true;
      });

      expect(flushed).toBe(true);
      expect(requestCount).toBe(1);
    } finally {
      server.close();
    }
  });
});
