// Delivery diagnostics: counters of what the SDK itself could not deliver, so
// the dashboard can say how many events never arrived. Numbers only - never
// event names, user ids or properties.
//
// Counters accumulate locally, are moved into a "pending" report right before
// they are attached to a batch, and are removed only after the server answered
// 2xx for that very batch. A failed send keeps the pending report, which is
// re-sent with the same `reportId` (the server counts a reportId once), so a
// retry or a lost response never double reports and a failure never loses it.

// events the SDK gave up on
export type DroppedReason =
  | "queue_full" // queue overflow
  | "invalid_event" // empty name or unusable properties
  | "too_large" // a single event above the payload limit
  | "rejected"; // the server answered 4xx (not 429)

// failed send attempts: one per batch that could not be delivered after all
// retries (the events stay queued). `failedTotal` counts these; `circuit_open`
// is listed by reason only and is not added to the total.
export type FailedReason =
  | "network" // blocked, offline, DNS, timeout
  | "server_error" // 5xx
  | "rate_limited" // 429
  | "circuit_open"; // the circuit breaker opened

export type DiagnosticsReason = DroppedReason | FailedReason;

const DROPPED_REASONS: ReadonlySet<string> = new Set([
  "queue_full",
  "invalid_event",
  "too_large",
  "rejected",
]);
const FAILED_REASONS: ReadonlySet<string> = new Set([
  "network",
  "server_error",
  "rate_limited",
  "circuit_open",
]);

// a counter can never exceed this, so the payload stays tiny and numeric
const COUNT_MAX = 1_000_000_000;

export interface DiagnosticsReport {
  /** one id per report, the server counts it once */
  reportId: string;
  /** when the oldest counted problem happened (ISO) */
  since: string;
  droppedTotal: number;
  /** failed send attempts (batches that failed after retries), not events */
  failedTotal: number;
  byReason: Record<string, number>;
  /** events waiting in the queue when the report was built */
  queued: number;
  sdkVersion: string;
}

interface Counts {
  dropped: number;
  failed: number;
  byReason: Record<string, number>;
  since?: string;
}

interface PendingReport {
  reportId: string;
  counts: Counts;
}

interface StoredRecord {
  counts: Counts;
  pending?: PendingReport;
}

export interface DiagnosticsStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

// used in Node, and in the browser when the queue must not touch localStorage
export class MemoryStore implements DiagnosticsStore {
  private data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.data.get(key) ?? null;
  }

  set(key: string, value: unknown) {
    this.data.set(key, value);
  }
}

// localStorage first (shared by tabs and surviving a reload), memory as the
// fallback when storage is blocked (private mode) and so reads nothing back
export class SharedStore implements DiagnosticsStore {
  private memory = new MemoryStore();

  constructor(private readonly storage: DiagnosticsStore) {}

  get(key: string): unknown {
    return this.storage.get(key) ?? this.memory.get(key);
  }

  set(key: string, value: unknown) {
    this.memory.set(key, value);
    this.storage.set(key, value);
  }
}

function emptyCounts(): Counts {
  return { dropped: 0, failed: 0, byReason: {} };
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= COUNT_MAX
  );
}

function parseCounts(value: unknown): Counts | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.dropped) || !isCount(v.failed)) return null;

  const byReason: Record<string, number> = {};
  const raw = v.byReason;
  if (typeof raw === "object" && raw !== null) {
    for (const [reason, count] of Object.entries(raw)) {
      if (
        (DROPPED_REASONS.has(reason) || FAILED_REASONS.has(reason)) &&
        isCount(count)
      ) {
        byReason[reason] = count;
      }
    }
  }

  const since =
    typeof v.since === "string" && !Number.isNaN(Date.parse(v.since))
      ? v.since
      : undefined;

  return { dropped: v.dropped, failed: v.failed, byReason, since };
}

// what is in storage may be stale, hand-edited or from another version: only
// a well-formed record is used, anything else starts over
function parseRecord(value: unknown): StoredRecord {
  if (typeof value !== "object" || value === null) {
    return { counts: emptyCounts() };
  }
  const v = value as Record<string, unknown>;
  const counts = parseCounts(v.counts) ?? emptyCounts();

  let pending: PendingReport | undefined;
  const p = v.pending as Record<string, unknown> | undefined;
  if (typeof p === "object" && p !== null && typeof p.reportId === "string") {
    const pendingCounts = parseCounts(p.counts);
    if (pendingCounts) pending = { reportId: p.reportId, counts: pendingCounts };
  }

  return { counts, pending };
}

function total(counts: Counts): number {
  return counts.dropped + counts.failed;
}

function add(into: Counts, from: Counts) {
  into.dropped = Math.min(COUNT_MAX, into.dropped + from.dropped);
  into.failed = Math.min(COUNT_MAX, into.failed + from.failed);
  for (const [reason, count] of Object.entries(from.byReason)) {
    into.byReason[reason] = Math.min(
      COUNT_MAX,
      (into.byReason[reason] ?? 0) + count,
    );
  }
  if (from.since && (!into.since || from.since < into.since)) {
    into.since = from.since;
  }
}

export class Diagnostics {
  // not yet merged into the (possibly shared) record
  private local: Counts = emptyCounts();
  private dirty = false;

  constructor(
    private readonly store: DiagnosticsStore,
    private readonly key: string,
    private readonly newId: () => string,
    private readonly onChange: () => void = () => {},
  ) {}

  record(reason: DiagnosticsReason, n = 1) {
    if (!(n > 0)) return;
    const isDropped = DROPPED_REASONS.has(reason);

    if (isDropped) {
      this.local.dropped = Math.min(COUNT_MAX, this.local.dropped + n);
    } else if (reason !== "circuit_open") {
      // `circuit_open` is an extra detail of a failure that was already
      // counted, so it appears in byReason only and never in failedTotal
      this.local.failed = Math.min(COUNT_MAX, this.local.failed + n);
    }
    this.local.byReason[reason] = Math.min(
      COUNT_MAX,
      (this.local.byReason[reason] ?? 0) + n,
    );
    this.local.since ??= new Date().toISOString();

    this.dirty = true;
    this.onChange();
  }

  // writes the local counters into the shared record (debounced by the client,
  // immediate on pagehide/destroy); a no-op when nothing changed
  sync() {
    if (!this.dirty) return;
    const record = this.read();
    add(record.counts, this.local);
    this.local = emptyCounts();
    this.dirty = false;
    this.store.set(this.key, record);
  }

  // Moves the counters into a pending report and returns it; an unacknowledged
  // pending report is returned again as it is. null when there is nothing to
  // report or another tab claimed the same counters first.
  claim(queued: number, sdkVersion: string): DiagnosticsReport | null {
    this.dirty = this.dirty || total(this.local) > 0;
    this.sync();

    const record = this.read();

    if (!record.pending) {
      if (total(record.counts) === 0) return null;

      const reportId = this.newId();
      record.pending = { reportId, counts: record.counts };
      record.counts = emptyCounts();
      this.store.set(this.key, record);

      // two tabs claiming at the same moment: only the one whose claim is what
      // is stored sends it, the other sends nothing this round
      const stored = this.read();
      if (stored.pending?.reportId !== reportId) return null;
    }

    const { reportId, counts } = record.pending;
    return {
      reportId,
      since: counts.since ?? new Date().toISOString(),
      droppedTotal: counts.dropped,
      failedTotal: counts.failed,
      byReason: { ...counts.byReason },
      queued,
      sdkVersion,
    };
  }

  // the server accepted the batch the report travelled with
  ack(reportId: string) {
    const record = this.read();
    if (record.pending?.reportId !== reportId) return;
    record.pending = undefined;
    this.store.set(this.key, record);
  }

  private read(): StoredRecord {
    return parseRecord(this.store.get(this.key));
  }
}
