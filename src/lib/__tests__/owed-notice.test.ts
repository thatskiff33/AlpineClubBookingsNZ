import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";
import { createOwedNoticeStore } from "./support/owed-notice-store";

/*
 * #5433: the owed-notice mechanism itself, with a deliverer of its own and an
 * in-memory `OwedNotice` table: the write, the stamp-guarded claim, the
 * own-claim settle and defer, the post-commit delivery, and the sweep's wait,
 * moved-on check, cut-off, maximum age and kind filter. The bump kinds that
 * use it are proved in booking-bump-notice-owed.test.ts, and the table's
 * primary key and claim exclusivity against PostgreSQL in
 * owed-notice.realdb.test.ts.
 */

const mocks = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const table = createOwedNoticeStore();
// The unknown-kind report's once-a-day claim.
const cooldown = createAlertCooldownStore();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get owedNotice() {
      return table.delegate;
    },
    get alertCooldown() {
      return cooldown.delegate;
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  deliverOwedNotice,
  OWED_NOTICE_HARD_CEILING_MULTIPLE,
  owedNoticeTableSource,
  type OwedNoticeDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeSource,
} from "@/lib/owed-notice/deliver";
import {
  CONFIRM_PENDING_OWED_NOTICE_CAP,
  drainOwedNotices,
  EMAIL_RETRY_OWED_NOTICE_CAP,
  UNKNOWN_KIND_REPORT_AFTER_MS,
  UNKNOWN_KIND_REPORT_EVERY_MS,
  type OwedNoticeDrainOptions,
} from "@/lib/owed-notice/drain";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";
import {
  claimOwedNotice,
  deferOwedNotice,
  owedNoticeId,
  owedNoticeMarker,
  recordOwedNotices,
  settleOwedNotice,
} from "@/lib/owed-notice/store";

const EVENT_AT = new Date("2026-07-01T00:00:00.000Z");
const at = (ms: number) => new Date(EVENT_AT.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const WAIT = HOUR;
const RETRY = 24 * HOUR;
const MAX_AGE = 7 * 24 * HOUR;
const CUTOFF = 3 * 24 * HOUR;

type Subject = { id: string; open: boolean };

/** A test kind's deliverer, every part a spy. */
function testDeliverer(kind: OwedNoticeKind, audience: "member" | "officers" = "member", { withPastCutoff = false } = {}) {
  const spies = {
    load: vi.fn(async (): Promise<Subject | null> => ({ id: "s1", open: true })),
    stillOwed: vi.fn(async (subject: Subject): Promise<true | string> => (subject.open ? true : "closed")),
    deliver: vi.fn<(...args: unknown[]) => Promise<OwedNoticeOutcome>>(async () => "settled"),
    pastCutoff: vi.fn(async (): Promise<OwedNoticeOutcome> => "settled"),
  };
  const common = {
    kind,
    job: "test",
    sweepAfterMs: WAIT,
    unreachedRetryAfterMs: RETRY,
    maxAgeMs: MAX_AGE,
    load: () => spies.load(),
    stillOwed: (subject: Subject) => spies.stillOwed(subject),
    sendBy: (_subject: Subject, marker: { eventAt: Date }) => new Date(marker.eventAt.getTime() + CUTOFF),
    ...(withPastCutoff ? { pastCutoff: () => spies.pastCutoff() } : {}),
  };
  const deliverer: OwedNoticeDeliverer<Subject> =
    audience === "member"
      ? {
          ...common,
          audience,
          idempotencyKey: (marker) => `${marker.subjectId}:${marker.eventAt.getTime()}`,
          deliver: (subject, marker, context) => spies.deliver(subject, marker, context),
        }
      : { ...common, audience, deliver: (subject, marker, context) => spies.deliver(subject, marker, context) };
  return { deliverer, spies };
}

// A kind of the test's own, outside `OWED_NOTICE_KINDS`: the drain is handed its deliverer directly.
const KIND = "test-kind" as OwedNoticeKind;
const markerFor = (subjectId = "s1", eventAt = EVENT_AT, kind = KIND) => owedNoticeMarker({ kind, subjectId, eventAt });

function seed(subjectId = "s1", stampedAt = EVENT_AT, kind: string = KIND, createdAt = EVENT_AT) {
  table.seed({ id: owedNoticeId(kind, subjectId, EVENT_AT), kind, subjectId, eventAt: EVENT_AT, stampedAt, createdAt });
  return owedNoticeId(kind, subjectId, EVENT_AT);
}

const drainWith = (
  deliverer: OwedNoticeDeliverer<Subject>,
  now: Date,
  sources: OwedNoticeSource[] = [owedNoticeTableSource],
  options: OwedNoticeDrainOptions = {},
) => drainOwedNotices(now, { job: "test-sweep", ...options, deliverers: [deliverer as OwedNoticeDeliverer], sources });

beforeEach(() => {
  vi.clearAllMocks();
  table.rows.clear();
  cooldown.rows.clear();
});

describe("recordOwedNotices, inside the change's transaction", () => {
  it("writes every notice in one insert that skips a marker already there, stamped with its event time", async () => {
    const tx = { owedNotice: table.delegate } as never;
    const markers = await recordOwedNotices(tx, [
      { kind: KIND, subjectId: "s1", eventAt: EVENT_AT, payload: { creditCents: 1500, linkId: "pl_1" } },
      { kind: KIND, subjectId: "s1", eventAt: EVENT_AT, variant: "x" },
    ]);

    expect(markers.map((marker) => marker.id)).toEqual([`${KIND}:s1:${EVENT_AT.getTime()}`, `${KIND}:s1:${EVENT_AT.getTime()}:x`]);
    expect(table.delegate.createMany).toHaveBeenCalledTimes(1);
    expect(table.delegate.createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true });
    expect([...table.rows.values()].map((row) => [row.stampedAt, row.payload])).toEqual([
      [EVENT_AT, { creditCents: 1500, linkId: "pl_1" }],
      [EVENT_AT, null],
    ]);

    // A second write of the same notice leaves the first as it is and raises nothing.
    table.rows.get(markers[0]!.id)!.stampedAt = at(5);
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "s1", eventAt: EVENT_AT }])).resolves.toHaveLength(1);
    expect(table.rows.get(markers[0]!.id)!.stampedAt).toEqual(at(5));
  });

  it("refuses a payload that is not ids and whole numbers, and writes nothing for an empty list", async () => {
    const tx = { owedNotice: table.delegate } as never;
    const write = (payload: Record<string, string | number>) => recordOwedNotices(tx, [{ kind: KIND, subjectId: "s1", eventAt: EVENT_AT, payload }]);
    await expect(write({ cents: 1.5 })).rejects.toThrow("whole number or an id");
    // Free text, an email address, a too-long id, an empty string: never an id.
    for (const text of ["Jane Doe", "jane@example.org", "x".repeat(65), ""]) {
      await expect(write({ name: text }), text).rejects.toThrow("whole number or an id");
    }
    await expect(write({ "not a key": 1 })).rejects.toThrow("not an identifier");
    await expect(write(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, i])))).rejects.toThrow("at most 8 fields");
    await expect(recordOwedNotices(tx, [])).resolves.toEqual([]);
    // Every refusal, and the empty list, wrote nothing.
    expect(table.delegate.createMany).not.toHaveBeenCalled();
    // Eight fields of ids and whole numbers are accepted.
    await expect(write(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, i % 2 ? i : `id_${i}-x`])))).resolves.toHaveLength(1);
    expect(table.delegate.createMany).toHaveBeenCalledTimes(1);
  });
});

describe("the claim, the settle and the defer", () => {
  it("gives a marker to exactly one of two callers racing it, and counts the attempt", async () => {
    const id = seed();
    const claims = await Promise.all([
      claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: EVENT_AT }),
      claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: EVENT_AT }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    // Strictly after the bound, even on a frozen clock.
    expect(claims.find(Boolean)).toEqual(at(1));
    expect(table.rows.get(id)!.attempts).toBe(1);
  });

  it("settles only a marker still carrying the caller's own claim", async () => {
    const id = seed();
    const mine = await claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: at(10) });
    // Another caller claimed it since (its stamp moved on).
    table.rows.get(id)!.stampedAt = at(20);

    await settleOwedNotice({ id, claimedAt: mine! });
    expect(table.rows.has(id)).toBe(true);

    await settleOwedNotice({ id, claimedAt: at(20) });
    expect(table.rows.has(id)).toBe(false);
  });

  it("defers by the caller's own claim only, so the marker is due exactly the retry after the claim", async () => {
    const id = seed();
    const claimedAt = (await claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: at(10) }))!;

    await deferOwedNotice({ id, claimedAt: at(99), waitMs: WAIT, retryAfterMs: RETRY });
    expect(table.rows.get(id)!.stampedAt).toEqual(claimedAt);

    await deferOwedNotice({ id, claimedAt, waitMs: WAIT, retryAfterMs: RETRY });
    expect(table.rows.get(id)!.stampedAt.getTime() + WAIT).toBe(claimedAt.getTime() + RETRY);
  });
});

describe("deliverOwedNotice, right after the commit", () => {
  it("claims on the stamp the transaction wrote, sends with the member's event key, and clears the marker", async () => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND);
    vi.setSystemTime(at(30 * 60 * 1000));
    try {
      await deliverOwedNotice(deliverer, markerFor(), { id: "s1", open: true });
    } finally {
      vi.setSystemTime(EVENT_AT);
    }

    // #5433 review C: the run's own clock, the moment the delivery ran.
    expect(spies.deliver).toHaveBeenCalledWith({ id: "s1", open: true }, markerFor(), {
      idempotencyKey: `s1:${EVENT_AT.getTime()}`,
      job: "test",
      now: at(30 * 60 * 1000),
    });
    expect(table.rows.size).toBe(0);
  });

  it("hands an officers' kind no event key, only the job and the run's clock", async () => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND, "officers");
    await deliverOwedNotice(deliverer, markerFor(), { id: "s1", open: true });
    expect(spies.deliver.mock.calls[0]![2]).toEqual({ job: "test", now: EVENT_AT });
  });

  it("sends nothing when a sweep already holds the marker", async () => {
    const id = seed("s1", at(5));
    const { deliverer, spies } = testDeliverer(KIND);

    await deliverOwedNotice(deliverer, markerFor(), { id: "s1", open: true });

    expect(spies.deliver).not.toHaveBeenCalled();
    expect(table.rows.get(id)!.stampedAt).toEqual(at(5));
  });

  it("never throws, and leaves the marker, when the deliverer throws", async () => {
    const id = seed();
    const { deliverer, spies } = testDeliverer(KIND);
    spies.deliver.mockRejectedValueOnce(new Error("boom"));

    await expect(deliverOwedNotice(deliverer, markerFor(), { id: "s1", open: true })).resolves.toBeUndefined();
    expect(table.rows.has(id)).toBe(true);
  });
});

describe("drainOwedNotices, the sweep", () => {
  it("waits until the marker's stamp is a full wait old, then sends and clears it", async () => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND);

    await expect(drainWith(deliverer, at(WAIT - 1))).resolves.toEqual({ checked: 0, delivered: 0, cleared: 0, expired: 0 });
    expect(spies.deliver).not.toHaveBeenCalled();

    await expect(drainWith(deliverer, at(WAIT))).resolves.toEqual({ checked: 1, delivered: 1, cleared: 0, expired: 0 });
    // The sweep's own job, not the job that committed the change, and the sweep's own clock.
    expect(spies.deliver.mock.calls[0]![2]).toEqual({ idempotencyKey: `s1:${EVENT_AT.getTime()}`, job: "test-sweep", now: at(WAIT) });
    expect(table.rows.size).toBe(0);
  });

  it("keeps a marker whose send threw for a full wait from that attempt", async () => {
    const id = seed();
    const { deliverer, spies } = testDeliverer(KIND);
    spies.deliver.mockResolvedValue("threw");

    await drainWith(deliverer, at(WAIT));
    await drainWith(deliverer, at(2 * WAIT - 1));
    expect(spies.deliver).toHaveBeenCalledTimes(1);
    await drainWith(deliverer, at(2 * WAIT));
    expect(spies.deliver).toHaveBeenCalledTimes(2);
    expect(table.rows.has(id)).toBe(true);
  });

  it("holds a marker whose send reached nobody for the kind's longer retry", async () => {
    const id = seed();
    const { deliverer, spies } = testDeliverer(KIND, "officers");
    spies.deliver.mockResolvedValue("unreached");

    await drainWith(deliverer, at(WAIT));
    await drainWith(deliverer, at(WAIT + RETRY - 1));
    expect(spies.deliver).toHaveBeenCalledTimes(1);
    spies.deliver.mockResolvedValue("settled");
    await drainWith(deliverer, at(WAIT + RETRY));
    expect(spies.deliver).toHaveBeenCalledTimes(2);
    expect(table.rows.has(id)).toBe(false);
  });

  it("leaves a marker in place, never throwing, when the deliverer throws", async () => {
    const id = seed();
    const { deliverer, spies } = testDeliverer(KIND);
    spies.deliver.mockRejectedValueOnce(new Error("boom"));

    await expect(drainWith(deliverer, at(WAIT))).resolves.toEqual({ checked: 1, delivered: 0, cleared: 0, expired: 0 });
    expect(table.rows.has(id)).toBe(true);
  });

  it.each([
    ["gone", null],
    ["closed", { id: "s1", open: false }],
  ])("clears a marker whose subject is %s, sending nothing", async (why, subject) => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND);
    spies.load.mockResolvedValue(subject);

    await expect(drainWith(deliverer, at(WAIT))).resolves.toMatchObject({ cleared: 1 });
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ why }), expect.any(String));
    expect(table.rows.size).toBe(0);
  });

  it("clears a marker past its maximum age with an error log, before reading its subject", async () => {
    seed("s1", at(MAX_AGE - WAIT));
    const { deliverer, spies } = testDeliverer(KIND);

    await expect(drainWith(deliverer, at(MAX_AGE + 1))).resolves.toMatchObject({ expired: 1 });
    expect(spies.load).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("maximum age"));
    expect(table.rows.size).toBe(0);
  });

  it("clears a marker past its cut-off with an error log when the kind has nothing to do instead", async () => {
    seed("s1", at(CUTOFF));
    const { deliverer, spies } = testDeliverer(KIND);

    await expect(drainWith(deliverer, at(CUTOFF + WAIT + 1))).resolves.toMatchObject({ expired: 1 });
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("cut-off"));
    expect(table.rows.size).toBe(0);
  });

  it("past the cut-off, runs the kind's own step instead of the send, and answers it like a send", async () => {
    const id = seed("s1", at(CUTOFF));
    const { deliverer, spies } = testDeliverer(KIND, "member", { withPastCutoff: true });
    spies.pastCutoff.mockResolvedValue("threw");

    await expect(drainWith(deliverer, at(CUTOFF + WAIT + 1))).resolves.toMatchObject({ expired: 0 });
    expect(table.rows.has(id)).toBe(true);

    spies.pastCutoff.mockResolvedValue("settled");
    await expect(drainWith(deliverer, at(CUTOFF + 3 * WAIT))).resolves.toMatchObject({ expired: 1 });
    expect(spies.pastCutoff).toHaveBeenCalledTimes(2);
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(table.rows.size).toBe(0);
  });

  it("leaves a kind it has no deliverer for exactly where it is", async () => {
    const other = seed("s2", EVENT_AT, "a-kind-a-newer-release-owns");
    seed("s1");
    const { deliverer, spies } = testDeliverer(KIND);

    await expect(drainWith(deliverer, at(WAIT))).resolves.toMatchObject({ checked: 1, delivered: 1 });
    expect(spies.load).toHaveBeenCalledTimes(1);
    expect(table.rows.get(other)).toMatchObject({ stampedAt: EVENT_AT, attempts: 0 });
    // The sweep's reads are by kind, its own only; the unknown-kind report reads `notIn` its kinds.
    expect(table.delegate.findMany.mock.calls.map(([args]) => args.where.kind)).toEqual([KIND, { notIn: [KIND] }]);
  });

  it("sends once when two sweeps reach a marker at the same moment", async () => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND);

    const results = await Promise.all([drainWith(deliverer, at(WAIT)), drainWith(deliverer, at(WAIT))]);

    expect(spies.deliver).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.delivered).sort()).toEqual([0, 1]);
  });

  it("carries on past a source that cannot be read, and never throws", async () => {
    seed();
    const { deliverer } = testDeliverer(KIND);
    const broken: OwedNoticeSource = { name: "broken", listDue: vi.fn(async () => Promise.reject(new Error("db down"))) };

    await expect(drainWith(deliverer, at(WAIT), [broken, owedNoticeTableSource])).resolves.toMatchObject({ delivered: 1 });
  });
});

describe("the cut-off step is never skipped by the age check (#5433 review)", () => {
  it("takes a kind's past-cut-off step for a marker past its maximum age, rather than clearing it unread", async () => {
    seed("s1", at(MAX_AGE));
    const { deliverer, spies } = testDeliverer(KIND, "member", { withPastCutoff: true });

    await expect(drainWith(deliverer, at(MAX_AGE + WAIT + 1))).resolves.toMatchObject({ expired: 1 });

    expect(spies.load).toHaveBeenCalledTimes(1);
    expect(spies.pastCutoff).toHaveBeenCalledTimes(1);
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(table.rows.size).toBe(0);
  });

  it("still clears without the step a marker past its maximum age whose subject has moved on", async () => {
    seed("s1", at(MAX_AGE));
    const { deliverer, spies } = testDeliverer(KIND, "member", { withPastCutoff: true });
    spies.load.mockResolvedValue({ id: "s1", open: false });

    await expect(drainWith(deliverer, at(MAX_AGE + WAIT + 1))).resolves.toMatchObject({ cleared: 1 });
    expect(spies.pastCutoff).not.toHaveBeenCalled();
  });
});

describe("a kind nobody delivers is reported, never deleted (#5433 review)", () => {
  it("logs once per run how many markers of unknown kinds are older than the report age, and leaves them", async () => {
    const now = at(UNKNOWN_KIND_REPORT_AFTER_MS + WAIT);
    seed("old-1", EVENT_AT, "a-kind-nobody-delivers", EVENT_AT);
    seed("old-2", EVENT_AT, "another-unknown-kind", EVENT_AT);
    seed("young", EVENT_AT, "a-kind-nobody-delivers", at(UNKNOWN_KIND_REPORT_AFTER_MS + 1));
    const { deliverer } = testDeliverer(KIND);

    await drainWith(deliverer, now);

    const reports = mocks.logger.error.mock.calls.filter(([, message]) => String(message).includes("kind this release does not deliver"));
    expect(reports).toHaveLength(1);
    expect(reports[0]![0]).toMatchObject({ count: 2, job: "test-sweep" });
    expect(table.rows.size).toBe(3);
  });

  it("says nothing when every unknown-kind marker is younger than the report age", async () => {
    seed("young", EVENT_AT, "a-kind-nobody-delivers", EVENT_AT);
    const { deliverer } = testDeliverer(KIND);

    await drainWith(deliverer, at(UNKNOWN_KIND_REPORT_AFTER_MS - 1));

    expect(mocks.logger.error.mock.calls.some(([, message]) => String(message).includes("kind this release does not deliver"))).toBe(false);
  });
});

describe("a capped run (#5433 review)", () => {
  it("stops offering markers at its row cap and leaves the rest owed for the next run", async () => {
    for (const subject of ["a", "b", "c"]) seed(subject);
    const { deliverer, spies } = testDeliverer(KIND);

    const first = await drainWith(deliverer, at(WAIT), [owedNoticeTableSource], { maxRows: 2 });
    expect(first).toEqual({ checked: 2, delivered: 2, cleared: 0, expired: 0, capped: true });
    expect(table.rows.size).toBe(1);

    const second = await drainWith(deliverer, at(WAIT), [owedNoticeTableSource], { maxRows: 2 });
    expect(second).toEqual({ checked: 1, delivered: 1, cleared: 0, expired: 0 });
    expect(spies.deliver).toHaveBeenCalledTimes(3);
  });

  it("stops offering markers once its time budget is spent", async () => {
    for (const subject of ["a", "b"]) seed(subject);
    const { deliverer, spies } = testDeliverer(KIND);
    let elapsed = 0;
    spies.deliver.mockImplementation(async () => {
      elapsed += 1_000;
      return "settled";
    });

    const result = await drainWith(deliverer, at(WAIT), [owedNoticeTableSource], { budgetMs: 1_000, elapsedMs: () => elapsed });

    expect(result).toMatchObject({ checked: 1, capped: true });
    expect(table.rows.size).toBe(1);
  });
});

describe("a marker of any kind has a hard lifetime (#5433 review)", () => {
  it("clears a marker past twice its maximum age unread, even for a kind with a past-cut-off step that keeps failing", async () => {
    const ceiling = MAX_AGE * OWED_NOTICE_HARD_CEILING_MULTIPLE;
    seed("s1", at(ceiling - WAIT));
    const { deliverer, spies } = testDeliverer(KIND, "member", { withPastCutoff: true });
    spies.pastCutoff.mockResolvedValue("unreached");

    // Just inside the ceiling the step still runs (and fails).
    await expect(drainWith(deliverer, at(ceiling))).resolves.toMatchObject({ expired: 0 });
    expect(spies.pastCutoff).toHaveBeenCalledTimes(1);

    table.rows.get(owedNoticeId(KIND, "s1", EVENT_AT))!.stampedAt = at(ceiling - WAIT);
    await expect(drainWith(deliverer, at(ceiling + 1))).resolves.toMatchObject({ expired: 1 });
    expect(spies.pastCutoff).toHaveBeenCalledTimes(1);
    expect(spies.load).toHaveBeenCalledTimes(1);
    expect(table.rows.size).toBe(0);
  });
});

describe("a marker's identity cannot collide (#5433 review)", () => {
  it("refuses a subject or a variant that is not an id, so no two markers share an id", async () => {
    const tx = { owedNotice: table.delegate } as never;
    // Subject `s:123` at 456 ms would share an id with subject `s` at 123 ms, variant `456`.
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "s:123", eventAt: new Date(456) }])).rejects.toThrow("subjectId");
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "s", eventAt: new Date(123), variant: "4:56" }])).rejects.toThrow("variant");
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "", eventAt: EVENT_AT }])).rejects.toThrow("subjectId");
    await expect(recordOwedNotices(tx, [{ kind: "a:b" as OwedNoticeKind, subjectId: "s", eventAt: EVENT_AT }])).rejects.toThrow("kind");
    expect(table.delegate.createMany).not.toHaveBeenCalled();
    // A cuid-shaped booking id and a one-letter variant, as the bump writes them, pass.
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "cm1abc2def3ghi4jkl5mno6p", eventAt: EVENT_AT, variant: "g" }])).resolves.toHaveLength(1);
  });
});

describe("a capped run is fair across kinds (#5433 review)", () => {
  const OTHER = "test-kind-two" as OwedNoticeKind;

  it("takes kinds in turn, so a backlog in one kind cannot starve another", async () => {
    for (const subject of ["a1", "a2", "a3", "a4", "a5"]) seed(subject);
    seed("b1", EVENT_AT, OTHER);
    const first = testDeliverer(KIND);
    const second = testDeliverer(OTHER);

    const result = await drainOwedNotices(at(WAIT), {
      job: "test-sweep",
      maxRows: 2,
      deliverers: [first.deliverer as OwedNoticeDeliverer, second.deliverer as OwedNoticeDeliverer],
      sources: [owedNoticeTableSource],
    });

    expect(result).toMatchObject({ delivered: 2, capped: true });
    expect(first.spies.deliver).toHaveBeenCalledTimes(1);
    expect(second.spies.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not spend the allowance on a marker another run already claimed", async () => {
    seed("held", at(WAIT + 5));
    seed("free");
    const { deliverer, spies } = testDeliverer(KIND);
    // A source that lists the held marker too, as one read just before another run claimed it would.
    const listsBoth: OwedNoticeSource = {
      name: "lists both",
      async listDue(d, at) {
        const due = await owedNoticeTableSource.listDue(d, at);
        const held = await owedNoticeTableSource.listDue(d, { ...at, dueBefore: new Date(at.dueBefore.getTime() + 10 * WAIT) });
        return [...held.filter((ref) => !due.some((other) => other.key === ref.key)), ...due];
      },
    };

    const result = await drainWith(deliverer, at(WAIT), [listsBoth], { maxRows: 1 });

    expect(result).toEqual({ checked: 2, delivered: 1, cleared: 0, expired: 0 });
    expect(spies.deliver).toHaveBeenCalledTimes(1);
  });

  it("reports no cap when it took exactly its limit and nothing it read was left", async () => {
    for (const subject of ["a", "b"]) seed(subject);
    const { deliverer } = testDeliverer(KIND);

    await expect(drainWith(deliverer, at(WAIT), [owedNoticeTableSource], { maxRows: 2 })).resolves.toEqual({
      checked: 2,
      delivered: 2,
      cleared: 0,
      expired: 0,
    });
  });

  it("caps the confirm-pending job's sweep below the email retry job's, both well inside a 30-minute slot", () => {
    expect(CONFIRM_PENDING_OWED_NOTICE_CAP.maxRows).toBeLessThan(EMAIL_RETRY_OWED_NOTICE_CAP.maxRows);
    expect(CONFIRM_PENDING_OWED_NOTICE_CAP.budgetMs).toBeLessThan(EMAIL_RETRY_OWED_NOTICE_CAP.budgetMs);
    expect(EMAIL_RETRY_OWED_NOTICE_CAP.budgetMs).toBeLessThan(30 * 60 * 1000);
  });
});

describe("the unknown-kind report is at most daily (#5433 review)", () => {
  it("logs once a day across runs, and again after a day", async () => {
    seed("old", EVENT_AT, "a-kind-nobody-delivers", EVENT_AT);
    const { deliverer } = testDeliverer(KIND);
    const reports = () => mocks.logger.error.mock.calls.filter(([, message]) => String(message).includes("kind this release does not deliver"));
    const firstRun = at(UNKNOWN_KIND_REPORT_AFTER_MS + WAIT);

    await drainWith(deliverer, firstRun);
    await drainWith(deliverer, new Date(firstRun.getTime() + 30 * 60 * 1000));
    expect(reports()).toHaveLength(1);
    expect(reports()[0]![0]).toMatchObject({ count: 1, kinds: ["a-kind-nobody-delivers"] });

    await drainWith(deliverer, new Date(firstRun.getTime() + UNKNOWN_KIND_REPORT_EVERY_MS + 1));
    expect(reports()).toHaveLength(2);
    expect(table.rows.size).toBe(1);
  });
});
