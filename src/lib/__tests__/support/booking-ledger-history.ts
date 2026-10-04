/**
 * BOOKING HISTORIES FROM BEFORE THE LEDGER, BUILT BY THE REAL WRITERS (#3583 PR 2).
 *
 * Each history is made the way production made it — the real settle, mark-paid,
 * internet-banking receipt, credit apply, card refund, cancel, hand-back
 * resolver, review raise and closure, and the edit doors' own posting — and then
 * its ledger lines (all of them, or only an edit's) are deleted, which leaves
 * exactly what a booking made before #3580–#3582 holds: its rows and columns,
 * and no lines. Shared by the back-post proof (`booking-ledger-back-post.realdb.test.ts`)
 * and the CI seed run (`booking-ledger-history-seed.realdb.test.ts`), so the
 * database CI back-posts is the one the proof reasons about.
 *
 * Test support only: it deletes ledger lines, which no application code may do
 * (`booking-ledger-append-only-census.test.ts`).
 */
import type { PrismaClient } from "@prisma/client";
import { expect, vi } from "vitest";

import type { CalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

export type HistoryNames = {
  officerId: string;
  lodgeId: string;
  roomId: string;
  memberId: string;
};

export function historyNames(prefix: string): HistoryNames {
  return { officerId: `${prefix}officer`, lodgeId: `${prefix}lodge`, roomId: `${prefix}room`, memberId: `${prefix}member` };
}

/**
 * Every suite runs on a frozen clock (`vitest.clock-setup.ts`). A history is a
 * sequence of events, and the census orders an edit against the confirmation by
 * their timestamps, so each event here happens a minute after the last.
 */
function tick(): void {
  vi.setSystemTime(new Date(Date.now() + 60_000));
}

type NightSpec = { priceCents: number | null; priceSource: "SOLD" | "EVEN_SPLIT" | "RATE_DERIVED" | "UNKNOWN" };

/** Two guests, two nights each; `nights` overrides a guest's night prices. */
async function createBooking(
  prisma: PrismaClient,
  names: HistoryNames,
  id: string,
  options: {
    payment: { amountCents: number; source: "STRIPE" | "INTERNET_BANKING"; intent?: string; xeroInvoiceId?: string } | null;
    guests?: Array<[NightSpec, NightSpec]>;
  },
): Promise<void> {
  const guests = options.guests ?? [
    [{ priceCents: 5_000, priceSource: "SOLD" }, { priceCents: 5_000, priceSource: "SOLD" }],
    [{ priceCents: 5_000, priceSource: "SOLD" }, { priceCents: 5_000, priceSource: "SOLD" }],
  ];
  const total = guests.flat().reduce((sum, night) => sum + (night.priceCents ?? 0), 0);
  await prisma.booking.create({
    // Admitted by an officer over capacity (#1771), so the settle's capacity
    // check passes on a lodge this support gives no capacity setting.
    data: {
      id,
      memberId: names.memberId,
      lodgeId: names.lodgeId,
      checkIn: D1,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: total,
      finalPriceCents: total,
      capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
      capacityOverriddenByMemberId: names.officerId,
    },
  });
  for (const [index, [first, second]] of guests.entries()) {
    await prisma.bookingGuest.create({
      data: {
        id: `${id}-g${index + 1}`,
        bookingId: id,
        firstName: "History",
        lastName: `g${index + 1}`,
        ageTier: "ADULT",
        isMember: true,
        stayStart: D1,
        stayEnd: CHECK_OUT,
        priceCents: (first.priceCents ?? 0) + (second.priceCents ?? 0),
        nights: { create: [{ stayDate: D1, ...first }, { stayDate: D2, ...second }] },
      },
    });
  }
  if (!options.payment) return;
  await prisma.payment.create({
    data: {
      id: `${id}-payment`,
      bookingId: id,
      amountCents: options.payment.amountCents,
      source: options.payment.source,
      status: "PENDING",
      stripePaymentIntentId: options.payment.intent ?? null,
      xeroInvoiceId: options.payment.xeroInvoiceId ?? null,
      reference: options.payment.source === "INTERNET_BANKING" ? `REF-${id}` : null,
    },
  });
}

/** The ledger as it stood before #3580: no lines at all. */
export async function stripAllLines(prisma: PrismaClient, bookingId: string): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId, reversesLineId: { not: null } } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId } });
}

/** An edit made before #3582 posted nothing: its own lines go, reversals first. */
async function stripModificationLines(prisma: PrismaClient, bookingId: string, modificationId: string): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId, anchorKind: "MODIFICATION", anchorId: modificationId, reversesLineId: { not: null } } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId, anchorKind: "MODIFICATION", anchorId: modificationId } });
}

async function settleByCard(bookingId: string, amountCents: number): Promise<void> {
  tick();
  const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
  const settled = await markBookingPaymentSucceeded({ bookingId, paymentIntentId: `pi_${bookingId}`, amountCents, paymentMethodId: null, format: CLUB_FORMAT_TEST });
  expect(settled.outcome).toBe("paid");
}

async function markPaid(names: HistoryNames, bookingId: string, amountCents: number): Promise<void> {
  tick();
  const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
  await markBookingPaymentManuallySettled({
    bookingId,
    actingAdminMemberId: names.officerId,
    note: "cash at the lodge",
    expectedAmountCents: amountCents,
    notifyMember: false,
    format: CLUB_FORMAT_TEST,
  });
}

/**
 * A priced edit as the edit doors post it (#3582): the door's own history row and
 * night rows, then the door's posting call with its before and after.
 */
async function postedEdit(
  prisma: PrismaClient,
  names: HistoryNames,
  bookingId: string,
  modificationId: string,
  edit: { removeGuestId?: string; reprice?: { guestId: string; stayDate: Date; priceCents: number }; changeFeeCents: number },
): Promise<void> {
  tick();
  const before = await prisma.bookingGuest.findMany({
    where: { bookingId },
    orderBy: { id: "asc" },
    select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true, rateMembershipTypeId: true, nights: { select: { stayDate: true, priceCents: true } } },
  });
  const removed = before.find((guest) => guest.id === edit.removeGuestId);
  const repriced = edit.reprice
    ? before.find((guest) => guest.id === edit.reprice!.guestId)?.nights.find((night) => night.stayDate.getTime() === edit.reprice!.stayDate.getTime())
    : undefined;
  const priceDiffCents =
    -(removed?.nights.reduce((sum, night) => sum + (night.priceCents ?? 0), 0) ?? 0) +
    (edit.reprice && repriced ? edit.reprice.priceCents - (repriced.priceCents ?? 0) : 0);
  const { diffBookingPricing, modificationPriceLinesToStore, pricingSideFromWrittenGuests } = await import("@/lib/booking-modification-lines");
  const { postModificationLedgerLines } = await import("@/lib/booking-ledger-modification-sync");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    if (removed) await tx.bookingGuest.delete({ where: { id: removed.id } });
    if (edit.reprice) {
      await tx.bookingGuestNight.updateMany({
        where: { bookingGuestId: edit.reprice.guestId, stayDate: edit.reprice.stayDate },
        data: { priceCents: edit.reprice.priceCents, priceSource: "SOLD" },
      });
    }
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { totalPriceCents: true, finalPriceCents: true, lodgeId: true } });
    await tx.booking.update({
      where: { id: bookingId },
      data: { totalPriceCents: booking.totalPriceCents + priceDiffCents, finalPriceCents: booking.finalPriceCents + priceDiffCents },
    });
    await tx.payment.update({ where: { bookingId }, data: { changeFeeCents: { increment: edit.changeFeeCents } } });
    const after = await tx.bookingGuest.findMany({
      where: { bookingId },
      orderBy: { id: "asc" },
      select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true, rateMembershipTypeId: true, nights: { select: { stayDate: true, priceCents: true } } },
    });
    const sides = {
      before: pricingSideFromWrittenGuests(before, { promoAdjustmentCents: 0 }),
      after: pricingSideFromWrittenGuests(after, { promoAdjustmentCents: 0 }),
    };
    // The door's folded narration lines (#3530), as every priced edit stores them.
    const priceLines = modificationPriceLinesToStore(diffBookingPricing(sides.before, sides.after, priceDiffCents));
    const row = await tx.bookingModification.create({
      data: {
        id: modificationId,
        bookingId,
        memberId: names.officerId,
        modificationType: "GUEST_REMOVE",
        previousData: {},
        newData: {},
        priceDiffCents,
        changeFeeCents: edit.changeFeeCents,
        ...(priceLines ? { priceLines } : {}),
      },
    });
    await postModificationLedgerLines({
      store: tx,
      bookingId,
      lodgeId: booking.lodgeId,
      bookingModification: row,
      sides,
      site: "booking-ledger-history",
    });
  });
}

/** A parked edit's review, raised as every edit door raises it: under lock(1). */
async function raiseReview(prisma: PrismaClient, names: HistoryNames, bookingId: string, guestId: string, modificationId: string): Promise<string> {
  tick();
  const { raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review");
  const raised = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return raiseEditFinancialReviewTask({
      occurrence: {
        bookingId,
        bookingGuestId: guestId,
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: ["2027-08-02" as CalendarDate],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: null, nightPrices: [] },
      },
      guestMemberId: names.memberId,
      bookingCheckIn: "2027-08-01" as CalendarDate,
      bookingCheckOut: "2027-08-03" as CalendarDate,
      bookingModificationId: modificationId,
      paymentId: null,
      guestsAddedByEdit: null,
      store: tx,
    });
  });
  return raised.taskId;
}

/** A parked edit: its strand's nights carry no price, and its review is open. */
async function parkStrand(prisma: PrismaClient, names: HistoryNames, bookingId: string, guestId: string): Promise<string> {
  const modificationId = `${bookingId}-parked`;
  await prisma.bookingModification.create({
    data: { id: modificationId, bookingId, memberId: names.officerId, modificationType: "BATCH_MODIFY", previousData: {}, newData: {} },
  });
  await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: guestId }, data: { priceCents: null, priceSource: "UNKNOWN" } });
  return raiseReview(prisma, names, bookingId, guestId, modificationId);
}

export const HISTORIES = [
  "card-exact",
  "inexact",
  "ib-credit",
  "cash-cancel-handback",
  "card-refund-edits",
  "review-closure",
  "change-fee",
  "two-edits",
] as const;
export type HistoryName = (typeof HISTORIES)[number];

/**
 * Build every history under `prefix`, each with its lines stripped as the
 * history says. Returns the booking id of each. The un-postable booking is not
 * here: the CI seed run must reach the gate, and the proof builds it itself.
 */
export async function buildBookingLedgerHistories(prisma: PrismaClient, prefix: string): Promise<Record<HistoryName, string>> {
  const names = historyNames(prefix);
  const id = (name: HistoryName) => `${prefix}${name}`;

  // Confirmed and captured by card through the real settle; exact night prices.
  await createBooking(prisma, names, id("card-exact"), { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id("card-exact")}` } });
  await settleByCard(id("card-exact"), 20_000);
  await stripAllLines(prisma, id("card-exact"));

  // One strand evenly split (inexact, `INV-MOD-028`), one re-derived from the
  // rate table (#3531 3b): both post night by night (decision A).
  await createBooking(prisma, names, id("inexact"), {
    payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${id("inexact")}` },
    guests: [
      [{ priceCents: 6_667, priceSource: "EVEN_SPLIT" }, { priceCents: 6_666, priceSource: "EVEN_SPLIT" }],
      [{ priceCents: 3_000, priceSource: "RATE_DERIVED" }, { priceCents: 3_667, priceSource: "RATE_DERIVED" }],
    ],
  });
  await settleByCard(id("inexact"), 20_000);
  await stripAllLines(prisma, id("inexact"));

  // Account credit applied by the real writer, the rest received by internet
  // banking through the real Xero paid-invoice path.
  const ibCredit = id("ib-credit");
  await createBooking(prisma, names, ibCredit, { payment: { amountCents: 15_000, source: "INTERNET_BANKING", xeroInvoiceId: `${ibCredit}-invoice` } });
  await prisma.payment.update({ where: { id: `${ibCredit}-payment` }, data: { creditAppliedCents: 5_000 } });
  await prisma.memberCredit.create({ data: { memberId: names.memberId, amountCents: 5_000, type: "ADMIN_ADJUSTMENT", description: `${prefix} opening balance` } });
  const credit = await import("@/lib/member-credit");
  await prisma.$transaction((tx) => credit.applyCreditToBooking(names.memberId, 5_000, ibCredit, tx, CLUB_FORMAT_TEST));
  tick();
  const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
  await syncInternetBankingPaymentsForPaidInvoice(
    {
      invoiceID: `${ibCredit}-invoice`,
      invoiceNumber: `INV-${ibCredit}`,
      status: "PAID",
      amountPaid: 150,
      payments: [{ paymentID: `${ibCredit}-xpay`, amount: 150 }],
    } as never,
    [`${ibCredit}-payment`],
    CLUB_FORMAT_TEST,
  );
  await stripAllLines(prisma, ibCredit);

  // Cash marked paid, cancelled at the lodge's 50% tier by the real cancel, and
  // the hand-back completed by the real resolver.
  const cash = id("cash-cancel-handback");
  await createBooking(prisma, names, cash, { payment: { amountCents: 20_000, source: "INTERNET_BANKING" } });
  await markPaid(names, cash, 20_000);
  tick();
  const { cancelBooking } = await import("@/lib/booking-cancel");
  expect((await cancelBooking(cash, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);
  const handBack = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: cash }, select: { id: true } });
  tick();
  const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
  await resolveManualRefundTask(
    { taskId: handBack.id, resolution: "completed", note: null, actingMemberId: names.officerId, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
    CLUB_FORMAT_TEST,
  );
  await stripAllLines(prisma, cash);

  // Confirmed by card (C1), a guest removed before #3582 (its lines stripped), a
  // date shift after it (its lines kept), and a card refund.
  const edits = id("card-refund-edits");
  await createBooking(prisma, names, edits, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${edits}` } });
  await settleByCard(edits, 20_000);
  await postedEdit(prisma, names, edits, `${edits}-removal`, { removeGuestId: `${edits}-g2`, changeFeeCents: 0 });
  await stripModificationLines(prisma, edits, `${edits}-removal`);
  tick();
  const { adminShiftBookingDates } = await import("@/lib/booking-date-modification-service");
  await adminShiftBookingDates({
    bookingId: edits,
    actor: { id: names.officerId, role: "ADMIN" },
    input: { checkIn: "2027-08-08", checkOut: "2027-08-10", confirmOverCapacity: true, notifyMember: false },
    ipAddress: "127.0.0.1",
  });
  tick();
  const { recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions");
  const capture = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${edits}-payment`, kind: "PRIMARY" }, select: { id: true } });
  await recordStripeRefundsAgainstTransaction({
    paymentId: `${edits}-payment`,
    paymentTransactionId: capture.id,
    refunds: [{ id: `re_${edits}`, amount: 10_000, currency: "nzd", status: "succeeded", created: null }],
    store: prisma,
  });

  // Cash marked paid (C1), a parked edit's review closed by dismissal before
  // #3582: the real closure re-bases the price from the re-priced strand, and
  // its re-price lines go.
  const review = id("review-closure");
  await createBooking(prisma, names, review, { payment: { amountCents: 20_000, source: "INTERNET_BANKING" } });
  await markPaid(names, review, 20_000);
  const taskId = await parkStrand(prisma, names, review, `${review}-g2`);
  await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: `${review}-g2`, stayDate: D1 }, data: { priceCents: 5_000, priceSource: "OFFICER_PRICED" } });
  await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: `${review}-g2`, stayDate: D2 }, data: { priceCents: 2_000, priceSource: "OFFICER_PRICED" } });
  await prisma.bookingGuest.update({ where: { id: `${review}-g2` }, data: { priceCents: 7_000 } });
  tick();
  await resolveManualRefundTask(
    { taskId, resolution: "dismissed", note: "Settled with the member another way.", actingMemberId: names.officerId, recordedNightPrices: null },
    CLUB_FORMAT_TEST,
  );
  const rebase = await prisma.bookingModification.findFirstOrThrow({ where: { bookingId: review, modificationType: "PRICE_REBASE" }, select: { id: true } });
  await stripModificationLines(prisma, review, rebase.id);

  // A change fee charged by an edit before the booking was confirmed on the
  // ledger (#3611 V4), then a second, after it, before #3582.
  const fee = id("change-fee");
  await createBooking(prisma, names, fee, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${fee}` } });
  await settleByCard(fee, 20_000);
  await postedEdit(prisma, names, fee, `${fee}-fee`, { changeFeeCents: 1_500 });
  await stripAllLines(prisma, fee);

  // Confirmed by card (C1), then two edits before #3582: a guest removed (no
  // fee), then a night re-priced up $10 with a $5 fee. The back-post anchors
  // both edits' nights on the second; a second run must find nothing left
  // (#3583's review, M1).
  const two = id("two-edits");
  await createBooking(prisma, names, two, { payment: { amountCents: 20_000, source: "STRIPE", intent: `pi_${two}` } });
  await settleByCard(two, 20_000);
  await postedEdit(prisma, names, two, `${two}-e1`, { removeGuestId: `${two}-g2`, changeFeeCents: 0 });
  await postedEdit(prisma, names, two, `${two}-e2`, { reprice: { guestId: `${two}-g1`, stayDate: D2, priceCents: 6_000 }, changeFeeCents: 500 });
  await stripModificationLines(prisma, two, `${two}-e2`);
  await stripModificationLines(prisma, two, `${two}-e1`);

  return Object.fromEntries(HISTORIES.map((name) => [name, id(name)])) as Record<HistoryName, string>;
}

/** The members, lodge, room and policy every history uses. */
export async function seedHistoryFixtures(prisma: PrismaClient, prefix: string): Promise<void> {
  const names = historyNames(prefix);
  for (const memberId of [names.memberId, names.officerId]) {
    await prisma.member.create({
      data: {
        id: memberId,
        email: `${memberId}@example.invalid`,
        passwordHash: "not-a-real-password",
        firstName: "History",
        lastName: "Proof",
        ageTier: "ADULT",
        ...(memberId === names.officerId ? { role: "ADMIN" as const } : {}),
      },
    });
  }
  await prisma.lodge.create({ data: { id: names.lodgeId, name: `Lodge ${prefix}`, slug: prefix.replace(/[^a-z0-9]+/g, "-").replace(/-$/, "") } });
  await prisma.lodgeRoom.create({ data: { id: names.roomId, lodgeId: names.lodgeId, name: `Room ${prefix}` } });
  await prisma.lodgeBed.createMany({
    data: Array.from({ length: 8 }, (_, index) => ({ id: `${prefix}bed-${index}`, roomId: names.roomId, name: `Bed ${index}`, bedType: "SINGLE" as const })),
  });
  // One tier: half back, however far ahead.
  await prisma.cancellationPolicy.create({ data: { lodgeId: names.lodgeId, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
}

/** Everything under `prefix`, fixtures included. */
export async function cleanHistories(prisma: PrismaClient, prefix: string): Promise<void> {
  const names = historyNames(prefix);
  const rows = await prisma.booking.findMany({ where: { id: { startsWith: prefix } }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  const where = { bookingId: { in: ids } };
  const payments = await prisma.payment.findMany({ where, select: { id: true } });
  const paymentIds = payments.map((payment) => payment.id);
  await prisma.bookingLedgerLine.deleteMany({ where: { ...where, reversesLineId: { not: null } } });
  await prisma.bookingLedgerLine.deleteMany({ where });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...ids, ...paymentIds] } } });
  await prisma.bedAllocation.deleteMany({ where });
  await prisma.memberCredit.deleteMany({ where: { memberId: { in: [names.memberId, names.officerId] } } });
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
  await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: names.lodgeId } });
  await prisma.lodgeBed.deleteMany({ where: { roomId: names.roomId } });
  await prisma.lodgeRoom.deleteMany({ where: { id: names.roomId } });
  await prisma.lodge.deleteMany({ where: { id: names.lodgeId } });
  await prisma.member.deleteMany({ where: { id: { in: [names.memberId, names.officerId] } } });
}

export { postedEdit as postHistoryEdit, createBooking as createHistoryBooking, settleByCard as settleHistoryByCard, parkStrand as parkHistoryStrand };
