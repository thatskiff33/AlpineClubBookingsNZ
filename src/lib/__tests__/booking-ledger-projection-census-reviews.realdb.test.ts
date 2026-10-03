/**
 * Real-PostgreSQL proof that the booking-ledger projection census agrees with
 * what #3791's review closures write (#3583, `INV-MONEY-037`; design
 * `docs/design/booking-ledger.md` §5.3, §6).
 *
 * #3791 changed what a review closure's lines record on a booking paid by
 * account credit: the stand-in posts what the member was actually CREDITED
 * (after a cancellation, the share netted against the restore — less than was
 * typed, or nothing), and on a booking its credit covered the give-back beyond
 * the re-price posts under its own `agreed-give-back:` key. Every booking here
 * is built by the real writers — the confirmation planner, the real credit
 * apply and credit-covered settle, the real review raise and completion, the
 * real `cancelBooking` — and the census must find nothing to say about it.
 * Then one line is corrupted, or deleted, and the census must name it. Where
 * a sibling's re-price, or a second give-back row, leaves the census unable to
 * tell which task a give-back row belongs to, it must fail closed as
 * `AMBIGUOUS_REVIEW_GIVE_BACK`, and a deleted line must make the owner's
 * sign-off stale.
 *
 * Skipped unless `RUN_CONCURRENCY_RACE_TESTS=1`; it reuses the guarded,
 * disposable loopback PostgreSQL of `booking-ledger-projection-census.realdb.test.ts`,
 * which imports this file, and cleans its own `race-3583r-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";
import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-3583r-";
const OFFICER_ID = `${PREFIX}officer`;
const LODGE_ID = `${PREFIX}lodge`;
const CREDIT_NOTE_PREFIX = `${PREFIX}note-`;
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const TIERS = {
  full: { refundPercentage: 100, fixedFeeCents: 0 },
  halfLessFee: { refundPercentage: 50, fixedFeeCents: 2_000 },
} as const;

let prisma: PrismaClient;
let censusStore: typeof import("@/lib/booking-ledger-projection-census-store");
const bookingIds: string[] = [];

const memberOf = (bookingId: string) => `${bookingId}-member`;
const guestOf = (bookingId: string) => `${bookingId}-guest`;
const modificationOf = (bookingId: string) => `${bookingId}-mod`;
const paymentOf = (bookingId: string) => `${bookingId}-payment`;

async function clean(): Promise<void> {
  const rows = await prisma.booking.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  const where = { bookingId: { in: ids } };
  const memberIds = ids.map(memberOf);
  const payments = await prisma.payment.findMany({ where, select: { id: true } });
  const paymentIds = payments.map((payment) => payment.id);
  const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: { in: ids } }, select: { id: true } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [...slices.map((slice) => slice.id), ...ids.map(modificationOf)] } } });
  await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: { in: ids } } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...ids, ...paymentIds, ...ids.map(modificationOf)] } } });
  await prisma.bookingLedgerLine.deleteMany({ where });
  await prisma.memberCredit.deleteMany({ where: { memberId: { in: memberIds } } });
  await prisma.manualRefundTask.deleteMany({ where });
  await prisma.paymentRecoveryOperation.deleteMany({ where });
  await prisma.bookingEvent.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
  await prisma.bookingModification.deleteMany({ where });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await prisma.payment.deleteMany({ where });
  await prisma.bookingGuest.deleteMany({ where });
  await prisma.booking.deleteMany({ where: { id: { in: ids } } });
  await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
}

/**
 * A $200 stay, one guest, two $100 nights, confirmed on the ledger through the
 * settle's own confirmation planner and paid in full by account credit through
 * the real apply and credit-covered settle. `ib-allocated` is a bank-transfer
 * booking whose credit Xero allocated against its invoice (#3791's covered
 * shape). The parked edit leaves the strand's nights unpriced, so a closure's
 * re-base declines and its share posts as the stand-in, as on #3791's bookings.
 */
async function creditPaidBooking(name: string, shape: "card" | "ib-allocated"): Promise<string> {
  const id = `${PREFIX}${name}`;
  bookingIds.push(id);
  const memberId = memberOf(id);
  await prisma.member.create({
    data: { id: memberId, email: `${memberId}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Review", ageTier: "ADULT" },
  });
  await prisma.booking.create({
    data: { id, memberId, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: 20_000, finalPriceCents: 20_000 },
  });
  await prisma.bookingGuest.create({
    data: {
      id: guestOf(id),
      bookingId: id,
      firstName: "Review",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: true,
      stayStart: D1,
      stayEnd: CHECK_OUT,
      priceCents: 20_000,
      nights: { create: [{ stayDate: D1, priceCents: 10_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 10_000, priceSource: "SOLD" }] },
    },
  });
  await prisma.bookingModification.create({
    data: { id: modificationOf(id), bookingId: id, memberId, modificationType: "BATCH_MODIFY", previousData: {}, newData: {} },
  });
  await prisma.memberCredit.create({
    data: {
      memberId,
      amountCents: 20_000,
      type: "ADMIN_ADJUSTMENT",
      description: "race 3583 opening balance",
      ...(shape === "ib-allocated" ? { xeroCreditNoteId: `${CREDIT_NOTE_PREFIX}${name}` } : {}),
    },
  });

  const { planConfirmationChargeLines } = await import("@/lib/booking-ledger-confirmation-posting");
  const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
  const credit = await import("@/lib/member-credit");
  const { settleFullyCreditCoveredBooking } = await import("@/lib/booking-credit-election");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        lodgeId: true,
        totalPriceCents: true,
        promoAdjustmentCents: true,
        guests: { select: { id: true, firstName: true, lastName: true, ageTier: true, rateMembershipTypeId: true, nights: { select: { stayDate: true, priceCents: true } } } },
      },
    });
    const plan = planConfirmationChargeLines(booking);
    expect(plan.reconciles).toBe(true);
    await postBookingLedgerLines(tx, plan.postings);
    await credit.applyCreditToBooking(memberId, 20_000, id, tx, CLUB_FORMAT_TEST);
    await settleFullyCreditCoveredBooking(tx, { bookingId: id, appliedCreditCents: 20_000 });
  });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: id }, select: { id: true } });
  await prisma.payment.update({ where: { id: payment.id }, data: { id: paymentOf(id) } }).catch(() => undefined);
  if (shape === "ib-allocated") {
    const invoiceId = `${PREFIX}invoice-${name}`;
    await prisma.payment.update({ where: { bookingId: id }, data: { source: "INTERNET_BANKING", xeroInvoiceId: invoiceId } });
    await prisma.memberCredit.updateMany({ where: { appliedToBookingId: id, type: "BOOKING_APPLIED" }, data: { xeroCreditNoteId: `${CREDIT_NOTE_PREFIX}${name}` } });
    const { repairLegacyAppliedCreditNoteAllocationsForBooking } = await import("@/lib/xero-applied-credit-allocation-repair");
    await prisma.$transaction((tx) => repairLegacyAppliedCreditNoteAllocationsForBooking(id, invoiceId, tx, CLUB_FORMAT_TEST));
  }
  // The parked edit's strand: its nights carry no stored price any more.
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuestId: guestOf(id) } });
  return id;
}

/** One review of the parked edit, raised as every edit door raises it: under lock(1). */
async function raiseReview(bookingId: string, night: CalendarDate = "2027-08-01" as CalendarDate): Promise<string> {
  const { raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review");
  const raised = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return raiseEditFinancialReviewTask({
      occurrence: {
        bookingId,
        bookingGuestId: guestOf(bookingId),
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: [night],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: null, nightPrices: [] },
      },
      guestMemberId: memberOf(bookingId),
      bookingCheckIn: "2027-08-01" as CalendarDate,
      bookingCheckOut: "2027-08-03" as CalendarDate,
      bookingModificationId: modificationOf(bookingId),
      paymentId: null,
      guestsAddedByEdit: null,
      store: tx,
    });
  });
  return raised.taskId;
}

async function completeShare(taskId: string, confirmedAmountCents: number): Promise<void> {
  const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
  await resolveManualRefundTask(
    {
      taskId,
      resolution: "completed",
      note: "Priced from the booking's own payment history.",
      actingMemberId: OFFICER_ID,
      confirmedAmountCents,
      direction: "REFUND_TO_MEMBER",
      recordedNightPrices: null,
    },
    CLUB_FORMAT_TEST,
  );
}

/** A review dismissed: the closure still re-bases the booking from its strands. */
async function dismiss(taskId: string): Promise<void> {
  const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
  await resolveManualRefundTask(
    { taskId, resolution: "dismissed", note: "Settled with the member another way.", actingMemberId: OFFICER_ID, recordedNightPrices: null },
    CLUB_FORMAT_TEST,
  );
}

/** The parked edit's strand, priced again: $100 and $50, so a closure's re-base takes $50 off. */
async function repriceStrand(bookingId: string): Promise<void> {
  await prisma.bookingGuest.update({
    where: { id: guestOf(bookingId) },
    data: {
      priceCents: 15_000,
      nights: { create: [{ stayDate: D1, priceCents: 10_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
    },
  });
}

async function cancelAt(bookingId: string, rule: (typeof TIERS)[keyof typeof TIERS]): Promise<void> {
  await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
  await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, ...rule } });
  const { cancelBooking } = await import("@/lib/booking-cancel");
  const result = await cancelBooking(bookingId, OFFICER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
  expect(result.status).toBe(200);
}

async function census(): Promise<BookingLedgerCensusReport> {
  return censusStore.censusBookingLedgerProjection(prisma);
}

function about(report: BookingLedgerCensusReport, bookingId: string) {
  return {
    disagreements: report.disagreements.filter((row) => row.bookingId === bookingId),
    coverage: Object.entries(report.coverage).flatMap(([kind, ids]) => (ids.includes(bookingId) ? [kind] : [])),
    integrity: report.integrity.findings.filter((finding) => finding.bookingId === bookingId),
    classes: Object.entries(report.classes).flatMap(([name, entry]) =>
      entry.instances.filter((instance) => instance.bookingId === bookingId).map((instance) => `${name}:${instance.identity}`),
    ),
  };
}

const NOTHING = { disagreements: [], coverage: [], integrity: [], classes: [] };

async function reviewLines(bookingId: string) {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId, kind: "AGREED_ADJUSTMENT", anchorKind: "REVIEW_TASK" },
    select: { id: true, amountCents: true, postingKey: true, reversesLineId: true, anchorId: true },
    orderBy: { id: "asc" },
  });
}

(RUN ? describe : describe.skip)("the census against #3791's review closures, on PostgreSQL and the real writers (#3583)", () => {
  const built: Record<string, string> = {};
  const tasks: Record<string, string[]> = {};

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Projection-census review");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    censusStore = await import("@/lib/booking-ledger-projection-census-store");
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: OFFICER_ID } });
    await prisma.member.create({
      data: { id: OFFICER_ID, email: `${OFFICER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Census", lastName: "Officer", role: "ADMIN", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3583 Review Lodge", slug: "race-3583r" } });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: OFFICER_ID } });
  });

  it("finds nothing to say about any booking #3791's closures build", async () => {
    // Review first: the covered booking's give-back posts under its own key and
    // the live booking agrees; then the cancellation, at 100% and at 50% less $20.
    for (const [name, tier] of [["rf-full", TIERS.full], ["rf-half", TIERS.halfLessFee]] as const) {
      const id = await creditPaidBooking(name, "card");
      tasks[name] = [await raiseReview(id)];
      await completeShare(tasks[name][0]!, 5_000);
      expect((await reviewLines(id)).map((line) => [line.postingKey?.split(":")[0], line.amountCents])).toEqual([["agreed-give-back", -5_000]]);
      expect(about(await census(), id)).toEqual(NOTHING);
      await cancelAt(id, tier);
      built[name] = id;
      expect(about(await census(), id)).toEqual(NOTHING);
    }
    // Cancel first: the share nets against the restore — $0 at 100%, so no
    // line; $25 at 50% less $20 — and the stand-in posts what was credited.
    for (const [name, tier, credited] of [["cf-full", TIERS.full, []], ["cf-half", TIERS.halfLessFee, [-2_500]]] as const) {
      const id = await creditPaidBooking(name, "card");
      tasks[name] = [await raiseReview(id)];
      await cancelAt(id, tier);
      await completeShare(tasks[name][0]!, 5_000);
      built[name] = id;
      expect((await reviewLines(id)).map((line) => line.amountCents)).toEqual(credited);
      expect(about(await census(), id)).toEqual(NOTHING);
    }
    // A bank-transfer booking whose credit Xero allocated against its invoice.
    {
      const id = await creditPaidBooking("ib", "ib-allocated");
      tasks.ib = [await raiseReview(id)];
      await completeShare(tasks.ib[0]!, 5_000);
      built.ib = id;
      expect((await reviewLines(id)).map((line) => [line.postingKey?.split(":")[0], line.amountCents])).toEqual([["agreed-give-back", -5_000]]);
      expect(about(await census(), id)).toEqual(NOTHING);
    }
    // Two sibling reviews of one edit: on the covered booking, and after a
    // cancellation, where the second nets against what the first gave back.
    {
      const id = await creditPaidBooking("sib-rf", "card");
      tasks["sib-rf"] = [await raiseReview(id), await raiseReview(id, "2027-08-02" as CalendarDate)];
      for (const task of tasks["sib-rf"]) await completeShare(task, 2_000);
      built["sib-rf"] = id;
      expect((await reviewLines(id)).map((line) => line.amountCents)).toEqual([-2_000, -2_000]);
      // Two give-back rows beside give-back lines: matched by amount alone, so
      // the booking fails closed as the class the owner signs off.
      expect(about(await census(), id)).toEqual({ ...NOTHING, classes: Array(3).fill("AMBIGUOUS_REVIEW_GIVE_BACK:null") });
    }
    {
      const id = await creditPaidBooking("sib-cf", "card");
      tasks["sib-cf"] = [await raiseReview(id), await raiseReview(id, "2027-08-02" as CalendarDate)];
      await cancelAt(id, TIERS.halfLessFee);
      for (const task of tasks["sib-cf"]) await completeShare(task, 2_000);
      built["sib-cf"] = id;
      expect((await reviewLines(id)).map((line) => line.amountCents)).toEqual([-1_000, -1_000]);
      expect(about(await census(), id)).toEqual(NOTHING);
    }
  }, 300_000);

  it("names a review line whose amount is wrong, one that is missing, and one where nothing moved", async () => {
    const setAmount = (lineId: string, amountCents: number) =>
      prisma.bookingLedgerLine.update({ where: { id: lineId }, data: { unitCents: Math.abs(amountCents), amountCents } });
    const drifted = (report: BookingLedgerCensusReport, bookingId: string) =>
      about(report, bookingId).integrity.filter((finding) => finding.kind === "SOURCE_DRIFT").map((finding) => finding.lineId);
    const disagreeing = (report: BookingLedgerCensusReport, bookingId: string) =>
      about(report, bookingId).disagreements.map((row) => [row.identity, row.deltaCents]);

    // A live covered booking's give-back, $10 too large: the line, and owed(b).
    const [ibLine] = await reviewLines(built.ib!);
    await setAmount(ibLine!.id, -6_000);
    // A give-back the cancellation has since reversed, $10 too small: the
    // reversal no longer takes back what it names.
    const [rfLine] = await reviewLines(built["rf-half"]!);
    await setAmount(rfLine!.id, -4_000);
    // One sibling's netted share, $5 too large.
    const [sibLine] = await reviewLines(built["sib-cf"]!);
    await setAmount(sibLine!.id, -1_500);
    // A live give-back deleted: no line says the price came down.
    const [, sibRfLine] = await reviewLines(built["sib-rf"]!);
    await prisma.bookingLedgerLine.delete({ where: { id: sibRfLine!.id } });
    // A cancelled booking's netted stand-in deleted.
    const [cfLine] = await reviewLines(built["cf-half"]!);
    await prisma.bookingLedgerLine.delete({ where: { id: cfLine!.id } });
    // A stand-in where the netting credited nothing.
    const { planAgreedAdjustmentLine } = await import("@/lib/booking-ledger-modification-posting");
    const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
    await prisma.$transaction((tx) =>
      postBookingLedgerLines(tx, [
        planAgreedAdjustmentLine({
          bookingId: built["cf-full"]!,
          lodgeId: LODGE_ID,
          manualRefundTaskId: tasks["cf-full"]![0]!,
          direction: "REFUND_TO_MEMBER",
          amountCents: 2_500,
          note: "rogue",
          officerMemberId: OFFICER_ID,
        }),
      ]),
    );
    const [rogue] = await reviewLines(built["cf-full"]!);

    const report = await census();
    expect(drifted(report, built.ib!)).toEqual([ibLine!.id]);
    expect(disagreeing(report, built.ib!)).toEqual([["OWED", 1_000]]);
    expect(about(report, built["rf-half"]!).integrity.map((finding) => finding.kind)).toEqual(["REVERSAL_NOT_OPPOSITE"]);
    expect(disagreeing(report, built["rf-half"]!)).toEqual([["PRICE", -1_000]]);
    expect(drifted(report, built["sib-cf"]!)).toEqual([sibLine!.id]);
    expect(disagreeing(report, built["sib-cf"]!)).toEqual([["PRICE", 500]]);
    expect(drifted(report, built["sib-rf"]!)).toEqual([]);
    expect(disagreeing(report, built["sib-rf"]!)).toEqual([["OWED", -2_000]]);
    expect(drifted(report, built["cf-half"]!)).toEqual([]);
    expect(disagreeing(report, built["cf-half"]!)).toEqual([["PRICE", -2_500]]);
    expect(drifted(report, built["cf-full"]!)).toEqual([rogue!.id]);
    expect(disagreeing(report, built["cf-full"]!)).toEqual([["PRICE", 2_500]]);
    expect(report.verdict).toBe("GATE_CLOSED");
  }, 120_000);
  it("a dismissed sibling's re-price makes a give-back unattributable: the class until acknowledged to the cent, stale once the line goes", async () => {
    // K's $50 share given back on the covered booking, then its sibling D
    // dismissed after the strand was priced again, its re-base taking $50 off.
    const id = await creditPaidBooking("amb", "card");
    const dismissedTask = await raiseReview(id);
    const shareTask = await raiseReview(id, "2027-08-02" as CalendarDate);
    await completeShare(shareTask, 5_000);
    await repriceStrand(id);
    await dismiss(dismissedTask);
    expect((await reviewLines(id)).map((line) => line.amountCents)).toEqual([-5_000]);
    const AMBIGUOUS = "AMBIGUOUS_REVIEW_GIVE_BACK" as const;
    const instances = (report: BookingLedgerCensusReport) =>
      report.classes[AMBIGUOUS].instances.filter((instance) => instance.bookingId === id);
    const first = await census();
    expect(about(first, id)).toEqual({ ...NOTHING, classes: Array(3).fill(`${AMBIGUOUS}:null`) });
    expect(instances(first).map((instance) => [instance.detail, instance.cents, instance.acknowledged])).toEqual([
      ["agreed give-back lines", 5_000, false],
      ["review give-back rows", 5_000, false],
      ["re-price drops on reviews with no give-back line", 5_000, false],
    ]);

    const acknowledgements = instances(first).map((instance) => ({ bookingId: id, class: AMBIGUOUS, cents: instance.cents, reference: "owner, #3583" }));
    const signed = await censusStore.censusBookingLedgerProjection(prisma, { acknowledgements });
    expect(instances(signed).every((instance) => instance.acknowledged)).toBe(true);
    expect(signed.acknowledged.stale).toEqual([]);

    // Deleting K's line: every identity still agrees, so only the class can
    // say it, and the owner's sign-off no longer matches.
    await prisma.bookingLedgerLine.delete({ where: { id: (await reviewLines(id))[0]!.id } });
    const corrupted = await censusStore.censusBookingLedgerProjection(prisma, { acknowledgements });
    expect(about(corrupted, id).disagreements).toEqual([]);
    expect(corrupted.acknowledged.stale.filter((entry) => entry.bookingId === id).map((entry) => entry.foundCents)).toEqual([[0]]);
    expect(corrupted.verdict).toBe("GATE_CLOSED");
  }, 120_000);
});
