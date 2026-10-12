import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real browser: delivery diagnostics. A blocked client counts what it dropped
// and failed to send, keeps the counters across a reload (real localStorage),
// and reports them with the first batch that gets through, exactly once.

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

type Body = {
  diagnostics?: {
    reportId: string;
    droppedTotal: number;
    failedTotal: number;
    byReason: Record<string, number>;
  };
  events: Array<{ name: string }>;
};

const OPTIONS = {
  apiKey: "test-key",
  disableTimer: true,
  autoFlushOnExit: false,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  maxQueueSize: 2,
};

test("blocked then unblocked: counters survive a reload and are reported exactly once", async ({
  page,
}) => {
  const { server, url } = await startServer();
  try {
    const state = { up: false };
    const bodies: Body[] = [];

    await page.route("https://api.eventra.dev/**", async (route) => {
      if (!state.up) {
        await route.abort("failed"); // what an ad blocker does
        return;
      }
      bodies.push(JSON.parse(route.request().postData() ?? "{}") as Body);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(url);
    await page.evaluate(async (opts) => {
      const mod = await (window as any).__eventraReady;
      const sdk = new mod.Eventra(opts);
      (window as any).__sdk = sdk;
      sdk.track("e2e.diag.a");
      sdk.track("e2e.diag.b");
      sdk.track("e2e.diag.c"); // the queue holds 2: this one is dropped
      await sdk.flush(); // blocked: a failed delivery
    }, OPTIONS);

    // the counters reach real localStorage
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem("__eventra_d__");
            if (!raw) return 0;
            const r = JSON.parse(raw);
            return (r.counts?.dropped ?? 0) + (r.counts?.failed ?? 0) +
              (r.pending?.counts?.dropped ?? 0) + (r.pending?.counts?.failed ?? 0);
          }),
        { timeout: 2000 },
      )
      .toBeGreaterThan(0);
    expect(bodies).toHaveLength(0);

    // reload with the endpoint reachable again
    state.up = true;
    await page.reload();
    await page.evaluate(async (opts) => {
      const mod = await (window as any).__eventraReady;
      const sdk = new mod.Eventra(opts);
      (window as any).__sdk = sdk;
      await sdk.flush(); // the restored queue, with the first report
      sdk.track("e2e.diag.d");
      await sdk.flush(); // the next report
      sdk.track("e2e.diag.e");
      await sdk.flush(); // nothing left to report
      await sdk.flush();
    }, OPTIONS);

    const reports = new Map<string, NonNullable<Body["diagnostics"]>>();
    for (const b of bodies) if (b.diagnostics) reports.set(b.diagnostics.reportId, b.diagnostics);

    let dropped = 0;
    let failed = 0;
    const byReason: Record<string, number> = {};
    for (const r of reports.values()) {
      dropped += r.droppedTotal;
      failed += r.failedTotal;
      for (const [k, v] of Object.entries(r.byReason)) byReason[k] = (byReason[k] ?? 0) + v;
    }

    // one dropped event (queue_full) and one failed delivery (network), each
    // reported once, never twice
    expect(dropped).toBe(1);
    expect(failed).toBe(1);
    expect(byReason).toEqual({ queue_full: 1, network: 1 });

    // and the events themselves were all delivered
    const names = bodies.flatMap((b) => b.events.map((e) => e.name)).sort();
    expect(names).toEqual(["e2e.diag.a", "e2e.diag.b", "e2e.diag.d", "e2e.diag.e"]);

    // the last batches carry nothing extra
    expect(bodies[bodies.length - 1].diagnostics).toBeUndefined();
  } finally {
    server.close();
  }
});

test("diagnostics: false sends nothing extra, even after failures", async ({ page }) => {
  const { server, url } = await startServer();
  try {
    const state = { up: false };
    const bodies: Body[] = [];
    await page.route("https://api.eventra.dev/**", async (route) => {
      if (!state.up) {
        await route.abort("failed");
        return;
      }
      bodies.push(JSON.parse(route.request().postData() ?? "{}") as Body);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(url);
    await page.evaluate(async (opts) => {
      const mod = await (window as any).__eventraReady;
      const sdk = new mod.Eventra({ ...opts, diagnostics: false });
      sdk.track("e2e.off.a");
      await sdk.flush();
    }, OPTIONS);
    // the queue reaches localStorage on a short debounce; a new instance reads it
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("__eventra_q__") !== null), {
        timeout: 2000,
      })
      .toBe(true);
    state.up = true;
    await page.evaluate(async (opts) => {
      const mod = await (window as any).__eventraReady;
      const sdk = new mod.Eventra({ ...opts, diagnostics: false });
      await sdk.flush();
    }, OPTIONS);

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.diagnostics === undefined)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("__eventra_d__"))).toBeNull();
  } finally {
    server.close();
  }
});
