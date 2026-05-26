import { afterEach, describe, expect, it, vi } from "vitest";
import { Eventra } from "../src";
import { createMockFetch } from "./helpers/mockFetch";

let active: Eventra[] = [];
afterEach(() => {
  for (const sdk of active) sdk.destroy();
  active = [];
});

describe("payload size guards", () => {
  it("splits a flush into multiple batches when payload exceeds maxPayloadBytes", async () => {
    const { fetchImpl, calls } = createMockFetch({
      responses: Array(20).fill(200),
    });
    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxBatchSize: 100,
      maxPayloadBytes: 2_000, // small cap to force splitting
    });
    active.push(sdk);

    // each event has a ~500 byte payload → only a handful fit per batch
    for (let i = 0; i < 12; i++) {
      sdk.track(`evt.${i}`, { properties: { blob: "x".repeat(500) } });
    }
    await sdk.flush();

    expect(calls.length).toBeGreaterThan(1);
    const totalEvents = calls.reduce((acc, c) => acc + c.body.events.length, 0);
    expect(totalEvents).toBe(12);
  });

  it("drops a single oversize event via onEventsDropped + onDeliveryFailed(413)", async () => {
    const onEventsDropped = vi.fn();
    const onDeliveryFailed = vi.fn();
    const { fetchImpl, calls } = createMockFetch({ responses: [200] });

    const sdk = new Eventra({
      apiKey: "k",
      disableTimer: true,
      autoFlushOnExit: false,
      fetchImpl,
      maxPayloadBytes: 800,
      onEventsDropped,
      onDeliveryFailed,
    });
    active.push(sdk);

    // event right at the property size limit but well over the payload cap of 800
    sdk.track("poison", { properties: { huge: "x".repeat(1_500) } });
    sdk.track("ok");
    await sdk.flush();

    expect(onEventsDropped).toHaveBeenCalledWith(1);
    expect(onDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 413 }),
    );

    expect(calls.length).toBe(1);
    expect(calls[0].body.events.map((e) => e.name)).toEqual(["ok"]);
  });
});
