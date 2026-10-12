import { describe, expect, it, vi } from "vitest";
import {
  Diagnostics,
  MemoryStore,
  SharedStore,
  type DiagnosticsStore,
} from "../src/diagnostics";

const KEY = "d";

function make(store: DiagnosticsStore = new MemoryStore(), onChange = () => {}) {
  let n = 0;
  const diag = new Diagnostics(store, KEY, () => `report-${++n}`, onChange);
  return { diag, store };
}

describe("stores", () => {
  it("MemoryStore returns null for a missing key and what was set", () => {
    const s = new MemoryStore();
    expect(s.get("a")).toBeNull();
    s.set("a", { x: 1 });
    expect(s.get("a")).toEqual({ x: 1 });
  });

  it("SharedStore reads storage first and falls back to memory when storage reads nothing", () => {
    const backing = new Map<string, unknown>();
    const storage: DiagnosticsStore = {
      get: (k) => backing.get(k) ?? null,
      set: (k, v) => void backing.set(k, v),
    };
    const s = new SharedStore(storage);
    s.set("a", 1);
    expect(backing.get("a")).toBe(1);
    expect(s.get("a")).toBe(1);

    // another tab changed it
    backing.set("a", 2);
    expect(s.get("a")).toBe(2);

    // storage blocked: reads nothing, memory still has the last write
    const blocked = new SharedStore({ get: () => null, set: () => {} });
    blocked.set("a", 3);
    expect(blocked.get("a")).toBe(3);
  });
});

describe("Diagnostics counters", () => {
  it("counts dropped and failed separately, by reason, and calls onChange", () => {
    const onChange = vi.fn();
    const { diag } = make(new MemoryStore(), onChange);

    diag.record("queue_full", 3);
    diag.record("network");
    diag.record("network");

    expect(onChange).toHaveBeenCalledTimes(3);

    const report = diag.claim(7, "1.2.3")!;
    expect(report.droppedTotal).toBe(3);
    expect(report.failedTotal).toBe(2);
    expect(report.byReason).toEqual({ queue_full: 3, network: 2 });
    expect(report.queued).toBe(7);
    expect(report.sdkVersion).toBe("1.2.3");
    expect(report.reportId).toBe("report-1");
    expect(Number.isNaN(Date.parse(report.since))).toBe(false);
  });

  it("ignores a non-positive count", () => {
    const onChange = vi.fn();
    const { diag } = make(new MemoryStore(), onChange);
    diag.record("network", 0);
    diag.record("network", -2);
    expect(onChange).not.toHaveBeenCalled();
    expect(diag.claim(0, "v")).toBeNull();
  });

  it("caps every counter", () => {
    const { diag } = make();
    diag.record("queue_full", 5_000_000_000);
    diag.record("queue_full", 5);
    diag.record("network", 5_000_000_000);
    const report = diag.claim(0, "v")!;
    expect(report.droppedTotal).toBe(1_000_000_000);
    expect(report.failedTotal).toBe(1_000_000_000);
    expect(report.byReason.queue_full).toBe(1_000_000_000);
  });

  it("sync() does nothing when nothing changed", () => {
    const set = vi.fn();
    const { diag } = make({ get: () => null, set });
    diag.sync();
    expect(set).not.toHaveBeenCalled();
  });

  it("sync() merges the local counters into what another tab already stored", () => {
    const store = new MemoryStore();
    const a = make(store).diag;
    const b = make(store).diag;

    a.record("network", 2);
    a.sync();
    b.record("network", 1);
    b.record("rejected", 4);
    b.sync();

    const report = a.claim(0, "v")!;
    expect(report.byReason).toEqual({ network: 3, rejected: 4 });
    expect(report.failedTotal).toBe(3);
    expect(report.droppedTotal).toBe(4);
  });

  it("keeps the oldest since when merging", () => {
    const store = new MemoryStore();
    store.set(KEY, {
      counts: { dropped: 0, failed: 1, byReason: { network: 1 }, since: "2020-01-01T00:00:00.000Z" },
    });
    const { diag } = make(store);
    diag.record("network");
    expect(diag.claim(0, "v")!.since).toBe("2020-01-01T00:00:00.000Z");

    // and an older stored one is replaced by a newer local one only if older
    const store2 = new MemoryStore();
    store2.set(KEY, {
      counts: { dropped: 0, failed: 1, byReason: { network: 1 }, since: "2999-01-01T00:00:00.000Z" },
    });
    const { diag: d2 } = make(store2);
    d2.record("network");
    expect(d2.claim(0, "v")!.since < "2999").toBe(true);
  });
});

describe("Diagnostics claim / ack", () => {
  it("returns null when there is nothing to report", () => {
    const { diag } = make();
    expect(diag.claim(0, "v")).toBeNull();
  });

  it("claims once, resends the same pending report until acknowledged, then starts a new one", () => {
    const { diag } = make();
    diag.record("network");

    const first = diag.claim(1, "v")!;
    // unacknowledged: the very same report (same id and numbers) comes back
    diag.record("rejected", 2); // new problems wait for the next report
    const again = diag.claim(5, "v")!;
    expect(again.reportId).toBe(first.reportId);
    expect(again.failedTotal).toBe(1);
    expect(again.droppedTotal).toBe(0);
    expect(again.queued).toBe(5);

    diag.ack(first.reportId);

    const next = diag.claim(0, "v")!;
    expect(next.reportId).not.toBe(first.reportId);
    expect(next.droppedTotal).toBe(2);
    expect(next.failedTotal).toBe(0);

    diag.ack(next.reportId);
    expect(diag.claim(0, "v")).toBeNull();
  });

  it("ack of an unknown report id changes nothing", () => {
    const { diag } = make();
    diag.record("network");
    const report = diag.claim(0, "v")!;
    diag.ack("some-other-id");
    expect(diag.claim(0, "v")!.reportId).toBe(report.reportId);
  });

  it("ack with nothing pending is harmless", () => {
    const { diag } = make();
    expect(() => diag.ack("x")).not.toThrow();
  });

  it("a second tab sees the first tab's pending report and sends it, never a copy", () => {
    const store = new MemoryStore();
    const a = make(store).diag;
    const b = make(store).diag;

    a.record("network", 3);
    const fromA = a.claim(0, "v")!;
    // b has no counters of its own and finds a's pending report: same id, so
    // the server counts it once even if both tabs send it
    const fromB = b.claim(0, "v")!;
    expect(fromB.reportId).toBe(fromA.reportId);
    expect(fromB.failedTotal).toBe(3);
  });

  it("loses the claim race when another tab stored a different pending report", () => {
    const real = new MemoryStore();
    let writes = 0;
    // the first claim write is overwritten by "another tab" right after it
    const racing: DiagnosticsStore = {
      get: (k) => real.get(k),
      set: (k, v) => {
        real.set(k, v);
        if (++writes === 2) {
          real.set(k, {
            counts: { dropped: 0, failed: 0, byReason: {} },
            pending: {
              reportId: "other-tab",
              counts: { dropped: 0, failed: 1, byReason: { network: 1 } },
            },
          });
        }
      },
    };
    const { diag } = make(racing);
    diag.record("network");
    // writes: 1 = sync(), 2 = the claim, then overwritten
    expect(diag.claim(0, "v")).toBeNull();
    // the other tab's report is what is pending now and will be sent
    expect(diag.claim(0, "v")!.reportId).toBe("other-tab");
  });

  it("falls back to now when a stored pending report has no since", () => {
    const store = new MemoryStore();
    store.set(KEY, {
      counts: { dropped: 0, failed: 0, byReason: {} },
      pending: {
        reportId: "p",
        counts: { dropped: 1, failed: 0, byReason: { queue_full: 1 } },
      },
    });
    const report = make(store).diag.claim(0, "v")!;
    expect(report.reportId).toBe("p");
    expect(Number.isNaN(Date.parse(report.since))).toBe(false);
  });
});

describe("stored record validation", () => {
  const claimFrom = (value: unknown) => {
    const store = new MemoryStore();
    store.set(KEY, value);
    return make(store).diag.claim(0, "v");
  };

  it("starts over on anything that is not a well-formed record", () => {
    expect(claimFrom("nonsense")).toBeNull();
    expect(claimFrom(null)).toBeNull();
    expect(claimFrom({ counts: "x" })).toBeNull();
    expect(claimFrom({ counts: { dropped: -1, failed: 0, byReason: {} } })).toBeNull();
    expect(claimFrom({ counts: { dropped: 1.5, failed: 0, byReason: {} } })).toBeNull();
    expect(claimFrom({ counts: { dropped: 0, failed: 2e9, byReason: {} } })).toBeNull();
  });

  it("keeps only known reasons with valid counts, and a valid since", () => {
    const report = claimFrom({
      counts: {
        dropped: 1,
        failed: 1,
        byReason: { network: 1, evil: 5, rejected: -2, queue_full: "x" },
        since: "not a date",
      },
    })!;
    expect(report.byReason).toEqual({ network: 1 });
    expect(Number.isNaN(Date.parse(report.since))).toBe(false);

    const noReasons = claimFrom({
      counts: { dropped: 1, failed: 0, byReason: "x", since: "2020-05-05T00:00:00.000Z" },
    })!;
    expect(noReasons.byReason).toEqual({});
    expect(noReasons.since).toBe("2020-05-05T00:00:00.000Z");
  });

  it("ignores a malformed pending report", () => {
    expect(
      claimFrom({
        counts: { dropped: 0, failed: 0, byReason: {} },
        pending: { reportId: 5, counts: { dropped: 1, failed: 0, byReason: {} } },
      }),
    ).toBeNull();
    expect(
      claimFrom({
        counts: { dropped: 0, failed: 0, byReason: {} },
        pending: { reportId: "p", counts: "bad" },
      }),
    ).toBeNull();
  });
});
