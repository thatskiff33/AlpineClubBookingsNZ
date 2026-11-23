/**
 * Real-PostgreSQL proof of the owed-notice table's guarantees (#5433), the
 * ones an in-memory double cannot show:
 *
 * - a marker commits with its transaction, and a rollback leaves none;
 * - writing a marker that already exists, inside a transaction, raises no
 *   unique-key error (`createMany` with `skipDuplicates` is
 *   `INSERT ... ON CONFLICT DO NOTHING`), so the transaction goes on and
 *   commits, and the existing marker keeps its stamp;
 * - of several callers claiming one marker at the same moment on separate
 *   connections, exactly one wins, and the settle deletes only by the
 *   winner's own claim;
 * - two drains at once deliver a marker once, and a drain reads only the
 *   kinds it has a deliverer for: another kind's marker is left untouched.
 *
 * The bump kinds on this table, and the legacy `AlertCooldown` markers beside
 * it, are proved in booking-bump-notice-owed.realdb.test.ts.
 *
 * Ordinary Vitest runs skip the whole file. It runs in CI's `realdb-all` job
 * on the guarded, disposable loopback PostgreSQL the race harness provisions
 * (#1881), and owns and cleans its own `race-5433-` rows: each case has its
 * own kind and subject, and asserts only on its own rows. Its deliverers are
 * spies, so no email is sent and no provider is called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OwedNoticeDeliverer } from "@/lib/owed-notice/deliver";
import type { OwedNoticeKind } from "@/lib/owed-notice/kinds";

import { listingTogether } from "./support/owed-notice-listing-barrier";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
// A full factory, never `importOriginal`: the real module imports next-auth,
// which does not resolve under plain Node ESM. Nothing this suite runs calls it.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: false })),
  requireSession: vi.fn(async () => ({ ok: false })),
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5433-";
const EVENT_AT = new Date("2026-06-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let store: typeof import("@/lib/owed-notice/store");
let deliver: typeof import("@/lib/owed-notice/deliver");
let drainOwedNotices: (typeof import("@/lib/owed-notice/drain"))["drainOwedNotices"];

(RUN ? describe : describe.skip)("the owed-notice table - real PostgreSQL (#5433)", { timeout: 60_000 }, () => {
  /** A case's own kind, so it asserts on its own rows only (outside `OWED_NOTICE_KINDS`; the drain is handed its deliverer). */
  const kindOf = (tag: string) => `${PREFIX}${tag}` as OwedNoticeKind;

  async function deleteOwnRows() {
    await prisma.owedNotice.deleteMany({ where: { kind: { startsWith: PREFIX } } });
  }

  /** A spy deliverer for one kind: it always finds its subject still owed, and settles. */
  function spyDeliverer(kind: OwedNoticeKind) {
    const sent: string[] = [];
    const deliverer: OwedNoticeDeliverer<{ id: string }> = {
      kind,
      job: "race-5433",
      audience: "officers",
      sweepAfterMs: HOUR,
      unreachedRetryAfterMs: 24 * HOUR,
      maxAgeMs: 3650 * 24 * HOUR,
      load: async (marker) => ({ id: marker.subjectId }),
      stillOwed: async () => true,
      sendBy: () => new Date(EVENT_AT.getTime() + 3650 * 24 * HOUR),
      deliver: async (_subject, marker) => {
        sent.push(marker.id);
        return "settled";
      },
    };
    return { deliverer, sent };
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "owed notice table proof");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    store = await import("@/lib/owed-notice/store");
    deliver = await import("@/lib/owed-notice/deliver");
    ({ drainOwedNotices } = await import("@/lib/owed-notice/drain"));
    await deleteOwnRows();
  }, 60_000);

  beforeEach(() => {
    resetStripeRaceHooks();
  });

  afterAll(async () => {
    resetStripeRaceHooks();
    if (typeof prisma === "undefined") return;
    try {
      await deleteOwnRows();
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("commits a marker with its transaction and leaves none when the transaction rolls back", async () => {
    const kept = kindOf("commit");
    const rolledBack = kindOf("rollback");

    await prisma.$transaction((tx) => store.recordOwedNotices(tx, [{ kind: kept, subjectId: "s1", eventAt: EVENT_AT }]));
    await expect(
      prisma.$transaction(async (tx) => {
        await store.recordOwedNotices(tx, [{ kind: rolledBack, subjectId: "s1", eventAt: EVENT_AT }]);
        throw new Error("the change failed after its marker");
      }),
    ).rejects.toThrow("after its marker");

    expect(await prisma.owedNotice.findMany({ where: { kind: { in: [kept, rolledBack] } }, select: { id: true, stampedAt: true } })).toEqual([
      { id: store.owedNoticeId(kept, "s1", EVENT_AT), stampedAt: EVENT_AT },
    ]);
  });

  it("writes an existing marker again inside a transaction without aborting it, and keeps its stamp", async () => {
    const kind = kindOf("dup");
    const id = store.owedNoticeId(kind, "s1", EVENT_AT);
    await prisma.$transaction((tx) => store.recordOwedNotices(tx, [{ kind, subjectId: "s1", eventAt: EVENT_AT }]));
    const claimedAt = await store.claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: new Date(EVENT_AT.getTime() + HOUR) });
    expect(claimedAt).not.toBeNull();

    // The duplicate, then a further write in the same transaction: a caught
    // unique-key error would have aborted it, and the commit would fail.
    await prisma.$transaction(async (tx) => {
      await store.recordOwedNotices(tx, [
        { kind, subjectId: "s1", eventAt: EVENT_AT },
        { kind, subjectId: "s2", eventAt: EVENT_AT },
      ]);
      await store.recordOwedNotices(tx, [{ kind, subjectId: "s3", eventAt: EVENT_AT }]);
    });

    const rows = await prisma.owedNotice.findMany({ where: { kind }, select: { subjectId: true, stampedAt: true, attempts: true }, orderBy: { subjectId: "asc" } });
    expect(rows).toEqual([
      { subjectId: "s1", stampedAt: claimedAt, attempts: 1 },
      { subjectId: "s2", stampedAt: EVENT_AT, attempts: 0 },
      { subjectId: "s3", stampedAt: EVENT_AT, attempts: 0 },
    ]);
  });

  it("gives a marker to exactly one of several callers claiming it at once, and settles only by that claim", async () => {
    const kind = kindOf("claim");
    const id = store.owedNoticeId(kind, "s1", EVENT_AT);
    await prisma.$transaction((tx) => store.recordOwedNotices(tx, [{ kind, subjectId: "s1", eventAt: EVENT_AT }]));
    const now = new Date(EVENT_AT.getTime() + HOUR);

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.claimOwedNotice({ id, stampedNoLaterThan: EVENT_AT, now: new Date(now.getTime() + i) })),
    );
    const winners = claims.filter((claim): claim is Date => claim !== null);
    expect(winners).toHaveLength(1);

    // A settle by any other stamp deletes nothing.
    await store.settleOwedNotice({ id, claimedAt: EVENT_AT });
    expect(await prisma.owedNotice.count({ where: { id } })).toBe(1);
    await store.settleOwedNotice({ id, claimedAt: winners[0]! });
    expect(await prisma.owedNotice.count({ where: { id } })).toBe(0);
  });

  it("delivers a marker once from two drains at once, and leaves a kind it has no deliverer for untouched", async () => {
    const mine = kindOf("drain");
    const other = kindOf("someone-elses");
    await prisma.$transaction((tx) =>
      store.recordOwedNotices(tx, [
        { kind: mine, subjectId: "s1", eventAt: EVENT_AT },
        { kind: other, subjectId: "s1", eventAt: EVENT_AT },
      ]),
    );
    const { deliverer, sent } = spyDeliverer(mine);
    // Both drains list the marker before either claims it, so they truly overlap.
    const options = { deliverers: [deliverer as OwedNoticeDeliverer], sources: [listingTogether(deliver.owedNoticeTableSource)] };
    const sweepAt = new Date(EVENT_AT.getTime() + 2 * HOUR);

    const results = await Promise.all([drainOwedNotices(sweepAt, options), drainOwedNotices(sweepAt, options)]);

    expect(sent).toEqual([store.owedNoticeId(mine, "s1", EVENT_AT)]);
    expect(results.map((result) => result.delivered).sort()).toEqual([0, 1]);
    // Both runs listed it: run one after the other, the second would have checked none.
    expect(results.map((result) => result.checked)).toEqual([1, 1]);
    expect(await prisma.owedNotice.count({ where: { kind: mine } })).toBe(0);
    expect(await prisma.owedNotice.findMany({ where: { kind: other }, select: { stampedAt: true, attempts: true } })).toEqual([
      { stampedAt: EVENT_AT, attempts: 0 },
    ]);
  });
});
