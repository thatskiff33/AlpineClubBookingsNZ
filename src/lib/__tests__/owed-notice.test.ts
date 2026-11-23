import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    get owedNotice() {
      return table.delegate;
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  deliverOwedNotice,
  owedNoticeTableSource,
  type OwedNoticeDeliverer,
  type OwedNoticeOutcome,
  type OwedNoticeSource,
} from "@/lib/owed-notice/deliver";
import { drainOwedNotices } from "@/lib/owed-notice/drain";
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
function testDeliverer(kind: string, audience: "member" | "officers" = "member", { withPastCutoff = false } = {}) {
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
      : { ...common, audience, deliver: (subject, marker) => spies.deliver(subject, marker) };
  return { deliverer, spies };
}

const KIND = "test-kind";
const markerFor = (subjectId = "s1", eventAt = EVENT_AT, kind = KIND) => owedNoticeMarker({ kind, subjectId, eventAt });

function seed(subjectId = "s1", stampedAt = EVENT_AT, kind = KIND) {
  table.seed({ id: owedNoticeId(kind, subjectId, EVENT_AT), kind, subjectId, eventAt: EVENT_AT, stampedAt });
  return owedNoticeId(kind, subjectId, EVENT_AT);
}

const drainWith = (deliverer: OwedNoticeDeliverer<Subject>, now: Date, sources: OwedNoticeSource[] = [owedNoticeTableSource]) =>
  drainOwedNotices(now, { deliverers: [deliverer as OwedNoticeDeliverer], sources });

beforeEach(() => {
  vi.clearAllMocks();
  table.rows.clear();
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

  it("refuses a payload number that is not a whole number, and writes nothing for an empty list", async () => {
    const tx = { owedNotice: table.delegate } as never;
    await expect(recordOwedNotices(tx, [{ kind: KIND, subjectId: "s1", eventAt: EVENT_AT, payload: { cents: 1.5 } }])).rejects.toThrow(
      "whole number",
    );
    await expect(recordOwedNotices(tx, [])).resolves.toEqual([]);
    expect(table.delegate.createMany).not.toHaveBeenCalled();
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

    expect(spies.deliver).toHaveBeenCalledWith({ id: "s1", open: true }, markerFor(), { idempotencyKey: `s1:${EVENT_AT.getTime()}` });
    expect(table.rows.size).toBe(0);
  });

  it("hands an officers' kind no event key", async () => {
    seed();
    const { deliverer, spies } = testDeliverer(KIND, "officers");
    await deliverOwedNotice(deliverer, markerFor(), { id: "s1", open: true });
    expect(spies.deliver.mock.calls[0]).toHaveLength(2);
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
    expect(spies.deliver.mock.calls[0]![2]).toEqual({ idempotencyKey: `s1:${EVENT_AT.getTime()}` });
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
    expect(table.delegate.findMany.mock.calls.map(([args]) => args.where.kind)).toEqual([KIND]);
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
