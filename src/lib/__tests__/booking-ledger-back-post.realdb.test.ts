/**
 * Real-PostgreSQL proof of the booking-ledger back-post (#3583 PR 2; design
 * `docs/design/booking-ledger.md` §6, §7).
 *
 * Histories are built by the real writers and their lines deleted
 * (`support/booking-ledger-history.ts`), which is what a booking made before
 * #3580–#3582 holds. The back-post must post every one of them so the census
 * finds nothing to say — confirmation exact and inexact, card, internet-banking
 * and credit settlement, a refund, a cancellation and its hand-back, an edit
 * from before #3582 beside one from after it, a review closure and a change fee
 * — list the booking it cannot post with its reason and post nothing for it,
 * post nothing on a second run, and stay one set of lines when a live edit or
 * refund races it on the same booking.
 *
 * Skipped unless `RUN_CONCURRENCY_RACE_TESTS=1`; it reuses the guarded,
 * disposable loopback PostgreSQL `concurrency-lock-races.realdb.test.ts`
 * provisions (#1881), which imports this file so CI reaches it, and cleans its
 * own `race-3583b-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";
import {
  buildBookingLedgerHistories,
  cleanHistories,
  createHistoryBooking,
  historyNames,
  parkHistoryStrand,
  seedHistoryFixtures,
  settleHistoryByCard,
  stripAllLines,
  type HistoryName,
} from "@/lib/__tests__/support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-3583b-";
const NAMES = historyNames(PREFIX);

let prisma: PrismaClient;
let backPost: typeof import("@/lib/booking-ledger-back-post");
let censusStore: typeof import("@/lib/booking-ledger-projection-census-store");

async function census(): Promise<BookingLedgerCensusReport> {
  return censusStore.censusBookingLedgerProjection(prisma);
}

/** Everything the report says about one booking, so another suite's rows cannot colour it. */
function about(report: BookingLedgerCensusReport, bookingId: string) {
  return {
    disagreements: report.disagreements.filter((row) => row.bookingId === bookingId),
    coverage: Object.entries(report.coverage).flatMap(([kind, ids]) => (ids.includes(bookingId) ? [kind] : [])),
    integrity: report.integrity.findings.filter((finding) => finding.bookingId === bookingId).map((finding) => finding.kind),
    classes: Object.entries(report.classes).flatMap(([name, entry]) =>
      entry.instances.filter((instance) => instance.bookingId === bookingId).map((instance) => `${name}:${instance.identity}`),
    ),
  };
}

const NOTHING = { disagreements: [], coverage: [], integrity: [], classes: [] };

async function runOne(bookingId: string, apply: boolean) {
  const run = await backPost.runBookingLedgerBackPost({ client: prisma, apply, bookingIds: [bookingId] });
  return run.outcomes[0]!;
}

async function lines(bookingId: string) {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId },
    orderBy: { id: "asc" },
    select: { id: true, kind: true, anchorKind: true, anchorId: true, quantity: true, amountCents: true, postingKey: true, reversesLineId: true },
  });
}

(RUN ? describe : describe.skip)("the booking-ledger back-post, against PostgreSQL and the real writers (#3583)", () => {
  let built: Record<HistoryName, string>;

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking-ledger back-post");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    backPost = await import("@/lib/booking-ledger-back-post");
    censusStore = await import("@/lib/booking-ledger-projection-census-store");
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
    built = await buildBookingLedgerHistories(prisma, PREFIX);
  }, 300_000);

  afterAll(async () => {
    if (!prisma || process.env.KEEP_3583B === "1") return;
    await cleanHistories(prisma, PREFIX);
  }, 120_000);

  it("before the back-post, the census holds the gate on every history: the gap is real", async () => {
    const report = await census();
    for (const id of Object.values(built)) {
      const found = about(report, id);
      expect(found.coverage.length + found.disagreements.length, id).toBeGreaterThan(0);
    }
  });

  it("the dry run reports what --apply would post, and commits nothing", async () => {
    const before = await prisma.bookingLedgerLine.count({ where: { bookingId: { in: Object.values(built) } } });
    for (const id of Object.values(built)) {
      const outcome = await runOne(id, false);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "POSTED", lineIds: [] });
    }
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: { in: Object.values(built) } } })).toBe(before);
  }, 120_000);

  it("--apply posts every history so the census finds nothing to say, each through the live posters' own keys", async () => {
    for (const id of Object.values(built)) {
      const before = new Set((await lines(id)).map((line) => line.id));
      const outcome = await runOne(id, true);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "POSTED" });
      // The run names every line it inserted, so they can be found again.
      const inserted = (await lines(id)).map((line) => line.id).filter((lineId) => !before.has(lineId)).sort();
      if (outcome.kind === "POSTED") expect(outcome.lineIds, id).toEqual(inserted);
    }
    const report = await census();
    for (const [name, id] of Object.entries(built)) {
      const expected = name === "cash-cancel-handback" ? { ...NOTHING, classes: ["REFUND_MIRROR_HAND_BACK:REFUNDED"] } : NOTHING;
      expect(about(report, id), name).toEqual(expected);
    }

    // Exact and inexact strands alike: one line per guest-night, confirmation-keyed.
    const inexact = await lines(built.inexact);
    const nights = inexact.filter((line) => line.kind === "GUEST_NIGHT");
    expect(nights).toHaveLength(4);
    expect(nights.every((line) => line.quantity === 1 && line.postingKey?.startsWith(`confirmation:${built.inexact}:night:`))).toBe(true);
    // ...so a later closure can read the live ledger as a before side (decision A).
    const { findPostedChargeLines } = await import("@/lib/booking-ledger-read");
    const { pricingSideFromLiveLedger } = await import("@/lib/booking-ledger-modification-posting");
    const guests = await prisma.bookingGuest.findMany({ where: { bookingId: built.inexact }, select: { id: true, isMember: true } });
    expect(pricingSideFromLiveLedger(await findPostedChargeLines(prisma, built.inexact), guests, 0)).not.toBeNull();

    // The pre-#3582 removal is posted on its own row, keyed by the edit's key
    // functions; the date shift that posted live is untouched.
    const edits = await lines(built["card-refund-edits"]);
    const removal = edits.filter((line) => line.anchorId === `${built["card-refund-edits"]}-removal`);
    expect(removal.map((line) => [line.kind, line.amountCents])).toEqual([
      ["GUEST_NIGHT", -5_000],
      ["GUEST_NIGHT", -5_000],
    ]);
    expect(removal.every((line) => line.postingKey?.startsWith("reversal:") && line.reversesLineId !== null)).toBe(true);
    // ...its stored narration lines were read only to check that total.
    const stored = await prisma.bookingModification.findUniqueOrThrow({ where: { id: `${built["card-refund-edits"]}-removal` }, select: { priceLines: true } });
    expect(stored.priceLines).not.toBeNull();

    // The closure's re-price, from before #3582, posts on its own PRICE_REBASE row.
    const rebase = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: built["review-closure"], modificationType: "PRICE_REBASE" }, select: { id: true } });
    const repriced = (await lines(built["review-closure"])).filter((line) => line.anchorId === rebase.id);
    expect(repriced.map((line) => line.amountCents).sort((a, b) => a - b)).toEqual([-5_000, 2_000]);
    expect(repriced.map((line) => line.postingKey?.split(":")[0]).sort()).toEqual(["modification", "reversal"]);

    // The change fee posts under the edit's own key.
    const fee = await lines(built["change-fee"]);
    expect(fee.filter((line) => line.kind === "CHANGE_FEE").map((line) => [line.postingKey, line.amountCents])).toEqual([
      [`modification:${built["change-fee"]}-fee:change-fee`, 1_500],
    ]);

    // The cancellation took the stay back and kept the policy's half; the hand-back paid the rest.
    const cancelled = await lines(built["cash-cancel-handback"]);
    expect(cancelled.filter((line) => line.kind === "CANCELLATION_FEE").map((line) => line.amountCents)).toEqual([10_000]);
    expect(cancelled.filter((line) => line.kind === "BANK_REFUND").map((line) => line.amountCents)).toEqual([-10_000]);
  }, 120_000);

  it("a second --apply posts nothing new", async () => {
    const before = await prisma.bookingLedgerLine.count({ where: { bookingId: { startsWith: PREFIX } } });
    for (const id of Object.values(built)) expect(await runOne(id, true), id).toMatchObject({ kind: "NOTHING_TO_POST" });
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: { startsWith: PREFIX } } })).toBe(before);
  }, 120_000);

  it("two unposted edits anchor on the later one, and a second and third run find nothing left (review M1)", async () => {
    const id = built["two-edits"];
    const rows = await lines(id);
    expect(rows.filter((line) => line.anchorId === `${id}-e1`)).toEqual([]);
    expect(rows.filter((line) => line.anchorId === `${id}-e2`).map((line) => [line.kind, line.amountCents]).sort()).toEqual([
      ["CHANGE_FEE", 500],
      ["GUEST_NIGHT", -5_000],
      ["GUEST_NIGHT", -5_000],
      ["GUEST_NIGHT", -5_000],
      ["GUEST_NIGHT", 6_000],
    ]);
    for (const run of [2, 3]) expect(await runOne(id, true), `run ${run}`).toMatchObject({ kind: "NOTHING_TO_POST" });
    expect(about(await census(), id)).toEqual(NOTHING);
  }, 120_000);

  it("a refused live edit with no later posted edit stays coverage, and the back-post then posts it", async () => {
    const id = built["two-edits"];
    // As a refused edit leaves it: its rows written, its price moved, no line.
    const nightsBefore = await prisma.bookingGuestNight.findFirstOrThrow({ where: { bookingGuestId: `${id}-g1`, stayDate: new Date("2027-08-01T00:00:00.000Z") } });
    await prisma.bookingGuestNight.update({ where: { id: nightsBefore.id }, data: { priceCents: 4_000 } });
    await prisma.booking.update({ where: { id }, data: { totalPriceCents: { decrement: 1_000 }, finalPriceCents: { decrement: 1_000 } } });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await prisma.bookingModification.create({
      data: { id: `${id}-refused`, bookingId: id, memberId: NAMES.officerId, modificationType: "GUEST_UPDATE", previousData: {}, newData: {}, priceDiffCents: -1_000 },
    });
    expect(about(await census(), id).coverage).toContain("UNPOSTED_EDIT");
    expect(await runOne(id, true)).toMatchObject({ kind: "POSTED" });
    expect(about(await census(), id)).toEqual(NOTHING);
    expect(await runOne(id, true)).toMatchObject({ kind: "NOTHING_TO_POST" });
  }, 120_000);

  it("a cancellation from before #3611 replays its kept figure from the frozen retained figure and the credit rows", async () => {
    const id = `${PREFIX}pre-3611-cancel`;
    await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
    await settleHistoryByCard(id, 20_000);
    const { cancelBooking } = await import("@/lib/booking-cancel");
    const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
    // Card refund by credit: the policy's half goes back as account credit, no provider call.
    expect((await cancelBooking(id, NAMES.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "credit")).status).toBe(200);
    const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: id, type: "CANCELLED" }, select: { id: true, snapshot: true } });
    const before3611 = { ...(event.snapshot as Record<string, unknown>) };
    delete before3611.ledger;
    await prisma.bookingEvent.update({ where: { id: event.id }, data: { snapshot: before3611 as never } });
    await stripAllLines(prisma, id);

    const outcome = await runOne(id, true);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "POSTED" });
    // The half credited to account raised the refunded column: named, as live.
    expect(about(await census(), id)).toEqual({ ...NOTHING, classes: ["REFUND_MIRROR_CREDIT_ALLOCATION:REFUNDED"] });
    expect((await lines(id)).filter((line) => line.kind === "CANCELLATION_FEE").map((line) => line.amountCents)).toEqual([10_000]);
  }, 120_000);

  it("a booking it cannot post is listed with its reason, and nothing is posted for it — not even its settlement", async () => {
    const id = `${PREFIX}unpriced`;
    await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
    await settleHistoryByCard(id, 20_000);
    await stripAllLines(prisma, id);
    // A parked edit's review still open: a strand's nights carry no price.
    await parkHistoryStrand(prisma, NAMES, id, `${id}-g2`);

    for (const apply of [false, true]) {
      const outcome = await runOne(id, apply);
      expect(outcome).toMatchObject({ kind: "CANNOT_POST", reason: "UNPRICED_NIGHT" });
    }
    expect(await lines(id)).toEqual([]);
    // The census still names it, so the gate stays shut on it.
    expect(about(await census(), id).coverage).toContain("NO_LINES");

    // And the report says why, in words.
    const run = await backPost.runBookingLedgerBackPost({ client: prisma, apply: false, bookingIds: [id] });
    const { formatBookingLedgerBackPostReport } = await import("@/lib/booking-ledger-back-post-report");
    const text = formatBookingLedgerBackPostReport(run, (cents) => `${cents}`);
    expect(text).toContain(`CANNOT POST  ${id}  UNPRICED_NIGHT`);
  }, 120_000);

  it("a booking whose census would disagree is rolled back and listed with both figures", async () => {
    const id = `${PREFIX}disagrees`;
    await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
    await settleHistoryByCard(id, 20_000);
    await stripAllLines(prisma, id);
    // The mirror says more was captured than any transaction row holds.
    await prisma.payment.update({ where: { id: `${id}-payment` }, data: { amountCents: 25_000 } });

    const outcome = await runOne(id, true);
    expect(outcome).toMatchObject({
      kind: "CANNOT_POST",
      reason: "CENSUS_WOULD_NOT_PASS",
      disagreements: expect.arrayContaining([{ identity: "CAPTURED", columnCents: 25_000, ledgerCents: 20_000, deltaCents: 5_000 }]),
    });
    expect(await lines(id)).toEqual([]);
  }, 120_000);

  it("one booking's unexpected error is listed against it, and the run goes on to the next (review M2)", async () => {
    const bad = `${PREFIX}negative-night`;
    const good = `${PREFIX}after-negative`;
    for (const id of [bad, good]) {
      await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
      await settleHistoryByCard(id, 20_000);
      await stripAllLines(prisma, id);
    }
    // A legacy negative night price, which the NOT VALID check never examined
    // on old rows: the write door refuses to post it.
    await prisma.$executeRawUnsafe(`ALTER TABLE "BookingGuestNight" DROP CONSTRAINT "BookingGuestNight_price_nonnegative"`);
    try {
      await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: `${bad}-g1`, stayDate: new Date("2027-08-01T00:00:00.000Z") }, data: { priceCents: -100 } });
      await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: `${bad}-g1`, stayDate: new Date("2027-08-02T00:00:00.000Z") }, data: { priceCents: 10_100 } });
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "BookingGuestNight" ADD CONSTRAINT "BookingGuestNight_price_nonnegative" CHECK ("priceCents" >= 0) NOT VALID`);
    }
    const seen: string[] = [];
    const run = await backPost.runBookingLedgerBackPost({ client: prisma, apply: true, bookingIds: [bad, good], onOutcome: (outcome) => seen.push(outcome.bookingId) });
    expect(run.outcomes[0]).toMatchObject({ bookingId: bad, kind: "CANNOT_POST", reason: "UNEXPECTED_ERROR", detail: expect.stringContaining("unitCents") });
    expect(run.outcomes[1]).toMatchObject({ bookingId: good, kind: "POSTED" });
    expect(seen).toEqual([bad, good]);
    expect(await lines(bad)).toEqual([]);
  }, 120_000);

  it("a booking whose rows another writer holds past the lock timeout is listed for a re-run, then posts (review M2)", async () => {
    const id = `${PREFIX}held-rows`;
    await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
    await settleHistoryByCard(id, 20_000);
    await stripAllLines(prisma, id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (holding = resolve));
    // A writer that takes the payment row and never lock(1) — the card-refund writer's shape.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "bookingId" = ${id} FOR NO KEY UPDATE`;
        holding();
        await held;
      },
      { timeout: 60_000 },
    );
    await locked;
    const outcome = await runOne(id, true);
    release();
    await holder;
    expect(outcome).toMatchObject({ kind: "CANNOT_POST", reason: "LOCK_TIMEOUT" });
    expect(await lines(id)).toEqual([]);
    expect(await runOne(id, true)).toMatchObject({ kind: "POSTED" });
  }, 120_000);

  describe("racing a live writer on the same booking", () => {
    async function paidHistory(name: string): Promise<string> {
      const id = `${PREFIX}${name}`;
      await createHistoryBooking(prisma, NAMES, id, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id}` } });
      await settleHistoryByCard(id, 20_000);
      await stripAllLines(prisma, id);
      return id;
    }

    function liveNightKeys(rows: Awaited<ReturnType<typeof lines>>): string[] {
      const reversed = new Set(rows.flatMap((line) => (line.reversesLineId ? [line.reversesLineId] : [])));
      return rows.filter((line) => line.kind === "GUEST_NIGHT" && line.reversesLineId === null && !reversed.has(line.id)).map((line) => line.postingKey ?? "");
    }

    it.each([1, 2, 3])("a back-post and a live admin date shift (run %i): one set of lines, census agrees", async (run) => {
      const id = await paidHistory(`race-shift-${run}`);
      const { adminShiftBookingDates } = await import("@/lib/booking-date-modification-service");
      const [posted] = await Promise.all([
        runOne(id, true),
        adminShiftBookingDates({
          bookingId: id,
          actor: { id: NAMES.officerId, role: "ADMIN" },
          input: { checkIn: "2027-09-08", checkOut: "2027-09-10", confirmOverCapacity: true, notifyMember: false },
          ipAddress: "127.0.0.1",
        }),
      ]);
      expect(posted).toMatchObject({ kind: "POSTED" });
      const rows = await lines(id);
      expect(rows.filter((line) => line.anchorKind === "CONFIRMATION" && line.kind === "GUEST_NIGHT")).toHaveLength(4);
      // Four guest-nights stand, one per guest per night, whichever won.
      expect(liveNightKeys(rows)).toHaveLength(4);
      expect(about(await census(), id)).toEqual(NOTHING);
      expect(await runOne(id, true)).toMatchObject({ kind: "NOTHING_TO_POST" });
    }, 120_000);

    it.each([1, 2, 3])("a back-post and a live card refund (run %i): the refund posts once, census agrees", async (run) => {
      const id = await paidHistory(`race-refund-${run}`);
      const capture = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${id}-payment`, kind: "PRIMARY" }, select: { id: true } });
      const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
      await Promise.all([
        runOne(id, true),
        recordStripeRefundsAgainstTransaction({
          paymentId: `${id}-payment`,
          paymentTransactionId: capture.id,
          refunds: [{ id: `re_${id}`, amount: 4_000, currency: "nzd", status: "succeeded", created: null }],
          store: prisma,
        }),
      ]);
      const rows = await lines(id);
      expect(rows.filter((line) => line.kind === "CARD_REFUND").map((line) => line.amountCents)).toEqual([-4_000]);
      expect(rows.filter((line) => line.kind === "CARD_CAPTURE")).toHaveLength(1);
      expect(about(await census(), id)).toEqual(NOTHING);
    }, 120_000);

    it("waits for the global lock(1) a live poster holds, and reads the booking again once it has it", async () => {
      const id = await paidHistory("race-lock");
      let releaseHolder: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (releaseHolder = resolve));
      let holderHasLock: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => (holderHasLock = resolve));
      // A live writer inside lock(1): it prices the second guest's nights up by
      // $10 each, as a re-price would, and has not committed yet.
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          holderHasLock();
          await held;
          await tx.bookingGuestNight.updateMany({ where: { bookingGuestId: `${id}-g2` }, data: { priceCents: 6_000 } });
          await tx.booking.update({ where: { id }, data: { totalPriceCents: 22_000, finalPriceCents: 22_000 } });
        },
        { timeout: 60_000 },
      );
      await locked;
      let finished = false;
      const posting = runOne(id, true).then((outcome) => {
        finished = true;
        return outcome;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(finished).toBe(false);
      releaseHolder();
      await holder;
      await posting;
      // It confirmed the nights as the writer left them, not as it first saw them.
      const confirmed = (await lines(id)).filter((line) => line.anchorKind === "CONFIRMATION" && line.kind === "GUEST_NIGHT");
      expect(confirmed.reduce((sum, line) => sum + line.amountCents, 0)).toBe(22_000);
    }, 120_000);
  });
});
