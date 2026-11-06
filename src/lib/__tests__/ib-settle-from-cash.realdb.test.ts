/**
 * Real-PostgreSQL proof that a bank transfer settles at the cash its invoice
 * collected (#3979, `INV-PAY-125`), end to end through the REAL inbound settle
 * (`syncInternetBankingPaymentsForPaidInvoice`), the booking ledger's receipt
 * sync, the REAL cancel and the REAL refunded-total repair of the inbound
 * credit-note sync.
 *
 * The booking is written the way `booking-create.ts` writes an Internet
 * Banking booking: a PENDING payment and its PENDING PRIMARY row at the price
 * of the day. An edit before the invoice exists changes the booking's price
 * (and a recorded fee changes `Payment.changeFeeCents`) and nothing else, as
 * every edit door does; the invoice is then linked as the invoice job links it,
 * and Xero reports it paid. Those three writes are seeded here, in the shapes
 * their writers leave, because each has its own suite; what this file proves is
 * what the settle, the ledger, the cancel and the credit-note sync then do.
 *
 * The cases: the issue's worked example in both directions (a price cut and a
 * price rise before the invoice), the finished-stay fee, the late capacity
 * cancel's credit, the control (a rise AFTER the invoice stays on its own
 * supplementary invoice, so the primary keeps the first figure), and decision 2:
 * an invoice-correction credit note on a never-paid invoice is a price
 * correction, so the payment records the cash and nothing refunded, and a
 * recount from the ledger keeps it.
 *
 * Nothing is mocked: the race harness imports this file beside suites that
 * mock the email and Xero client modules, and a second mock of either here
 * would replace theirs. So the operator alerts are pinned by the unit suites
 * (`xero-inbound-reconciliation.test.ts`), and the credit-note sync is entered
 * after its Xero read, through the two calls it makes with what it read
 * (`resolveModificationRefundAmountsByPaymentId`, then
 * `repairRefundedPaymentBusinessState`).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3979-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { CreditNote, type Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3979-member";
// A lodge with no beds resolves to zero capacity (#1982): a booking holding
// its beds settles to PAID, and one that holds none takes the capacity cancel.
const LODGE_ID = "race-3979-lodge";
const BOOKING_ID = "race-3979-booking";
const PAYMENT_ID = "race-3979-payment";
const PRIMARY_ID = "race-3979-primary";
const GUEST_ID = "race-3979-guest";
const INVOICE_ID = "race-3979-invoice";
const MODIFICATION_ID = "race-3979-modification";
const NOTE_ID = "race-3979-note";
// A later edit's note, whose sync recounts the payment's refunded total.
const LATER_MODIFICATION_ID = "race-3979-modification-later";
const LATER_NOTE_ID = "race-3979-note-later";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");
// A stay already finished, for the #3955 finished-stay fee.
const PAST_CHECK_IN = new Date("2026-06-01T00:00:00.000Z");
const PAST_CHECK_OUT = new Date("2026-06-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeIbSettleFromCashRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("IB settle-from-cash proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run IB settle-from-cash proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("IB settle-from-cash proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("IB settle-from-cash proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let creditNoteRepairs: typeof import("@/lib/xero-inbound/credit-note-repairs");
let noteRefunds: typeof import("@/lib/xero-inbound/modification-note-refunds");
let paymentTransactions: typeof import("@/lib/payment-transactions");
let memberCredit: typeof import("@/lib/member-credit");

/**
 * A PAID invoice carrying `cashCents` of bank cash, as a fresh getInvoice reads
 * it: its total, when given, and the credit notes applied to it.
 */
function paidInvoice(
  cashCents: number,
  extra: { totalCents?: number; appliedNotes?: Array<{ id: string; cents: number }> } = {},
): Invoice {
  return {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-3979",
    status: "PAID",
    amountPaid: cashCents / 100,
    payments: [{ paymentID: "race-3979-xpay", amount: cashCents / 100, status: "AUTHORISED" }],
    ...(extra.totalCents !== undefined ? { total: extra.totalCents / 100 } : {}),
    ...(extra.appliedNotes
      ? { creditNotes: extra.appliedNotes.map((note) => ({ creditNoteID: note.id, appliedAmount: note.cents / 100 })) }
      : {}),
  } as unknown as Invoice;
}

async function clean(): Promise<void> {
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroObjectLink.deleteMany({
    where: {
      OR: [
        { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID, LATER_MODIFICATION_ID] } },
        { xeroObjectId: { in: [INVOICE_ID, NOTE_ID, LATER_NOTE_ID] } },
      ],
    },
  });
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID, LATER_MODIFICATION_ID] } },
  });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }] } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * An Internet Banking booking as `booking-create.ts` writes it, at `bookedCents`:
 * the payment and its PRIMARY row both PENDING at that figure. `holdsBeds`
 * is the held (CONFIRMED) shape, which settles to PAID; without it the late
 * payment meets a lodge with no room.
 */
async function bookAt(bookedCents: number, options: { holdsBeds?: boolean; finished?: boolean } = {}): Promise<void> {
  const holdsBeds = options.holdsBeds ?? true;
  const checkIn = options.finished ? PAST_CHECK_IN : CHECK_IN;
  const checkOut = options.finished ? PAST_CHECK_OUT : CHECK_OUT;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn,
      checkOut,
      status: options.finished ? "COMPLETED" : holdsBeds ? "CONFIRMED" : "PAYMENT_PENDING",
      totalPriceCents: bookedCents,
      finalPriceCents: bookedCents,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Settle",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      stayStart: checkIn,
      stayEnd: checkOut,
      priceCents: bookedCents,
      nights: { create: [{ stayDate: checkIn, priceCents: bookedCents, priceSource: "SOLD" }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: bookedCents,
      source: "INTERNET_BANKING",
      status: "PENDING",
      reference: "BOOKING-RACE3979",
      internetBankingHoldSlots: holdsBeds && !options.finished,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: bookedCents,
          status: "PENDING",
          reference: "BOOKING-RACE3979",
          reason: "internet_banking_booking_payment",
        },
      },
    },
  });
}

/** An edit while no invoice exists: the price moves, the payment's figure does not. */
async function editPriceTo(priceCents: number): Promise<void> {
  await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: priceCents, totalPriceCents: priceCents } });
}

/** The invoice job's link: the invoice id on the payment and its PRIMARY row, and the active link. */
async function raiseInvoice(): Promise<void> {
  await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-3979" } });
  await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-3979" } });
  await prisma.xeroObjectLink.create({
    data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
  });
}

async function settle(cashCents: number, extra: Parameters<typeof paidInvoice>[1] = {}) {
  return paidEffects.syncInternetBankingPaymentsForPaidInvoice(paidInvoice(cashCents, extra), [PAYMENT_ID], CLUB_FORMAT_TEST);
}

async function figures() {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: PAYMENT_ID },
    select: { amountCents: true, refundedAmountCents: true, status: true },
  });
  const primary = await prisma.paymentTransaction.findUniqueOrThrow({
    where: { id: PRIMARY_ID },
    select: { amountCents: true, status: true },
  });
  const receipts = await prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID, kind: "BANK_RECEIPT" },
    select: { amountCents: true },
  });
  return { payment, primary, receipts: receipts.map((line) => line.amountCents) };
}

/**
 * The edit's invoice-correction note on the never-paid invoice (#3536,
 * `INV-PAY-116`), in the rows its builder leaves: the outbound operation that
 * recorded the wording, and the note's link to the edit.
 */
async function queueModificationNote(
  noteCents: number,
  wording: Record<string, unknown>,
  ids: { noteId: string; modificationId: string } = { noteId: NOTE_ID, modificationId: MODIFICATION_ID },
): Promise<void> {
  await prisma.bookingModification.create({
    data: {
      id: ids.modificationId,
      bookingId: BOOKING_ID,
      memberId: MEMBER_ID,
      modificationType: "BATCH_MODIFY",
      previousData: {},
      newData: {},
      priceDiffCents: -noteCents,
      changeFeeCents: 0,
    },
  });
  await prisma.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: ids.modificationId,
      idempotencyKey: `race-3979-mod-credit-note-${ids.noteId}`,
      correlationKey: `race-3979-mod-credit-note-${ids.noteId}`,
      status: "SUCCEEDED",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: ids.noteId,
      requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: noteCents, ...wording },
    },
  });
  await prisma.xeroObjectLink.create({
    data: { localModel: "BookingModification", localId: ids.modificationId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: ids.noteId, role: "MODIFICATION_CREDIT_NOTE", active: true },
  });
}

/**
 * The inbound credit-note sync, after its Xero read of the AUTHORISED note,
 * fully allocated to the invoice: the links it writes (the note's status, and
 * its allocation, both on the edit), then the current note's contribution and
 * the payment's refunded total recomputed (`reconcileXeroCreditNote`).
 */
async function syncNote(
  noteCents: number,
  ids: { noteId: string; modificationId: string } = { noteId: NOTE_ID, modificationId: MODIFICATION_ID },
): Promise<void> {
  await prisma.xeroObjectLink.updateMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: ids.noteId, role: "MODIFICATION_CREDIT_NOTE" },
    data: { metadata: { status: "AUTHORISED", total: noteCents / 100 } },
  });
  const allocationId = `${ids.noteId}:${INVOICE_ID}:${noteCents}`;
  if (!(await prisma.xeroObjectLink.findFirst({ where: { xeroObjectId: allocationId } }))) {
    await prisma.xeroObjectLink.create({
      data: {
        localModel: "BookingModification",
        localId: ids.modificationId,
        xeroObjectType: "ALLOCATION",
        xeroObjectId: allocationId,
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        active: true,
        metadata: { creditNoteId: ids.noteId, invoiceId: INVOICE_ID, amountCents: noteCents },
      },
    });
  }
  const allocationTargets = [{ invoiceId: INVOICE_ID, amountCents: noteCents }];
  const modificationRefundAmountsByPaymentId = await noteRefunds.resolveModificationRefundAmountsByPaymentId({
    creditNoteId: ids.noteId,
    isModificationNote: true,
    allocationTargets,
  });
  await creditNoteRepairs.repairRefundedPaymentBusinessState({
    creditNoteId: ids.noteId,
    creditNote: { status: CreditNote.StatusEnum.AUTHORISED, total: noteCents / 100, appliedAmount: noteCents / 100, remainingCredit: 0 },
    directPaymentIds: [],
    modificationRefundAmountsByPaymentId,
  });
}

/** A bank transfer settled BEFORE #3979: the receipt captured at the stored figure. */
async function settledBeforeThisChange(refundedCents: number): Promise<void> {
  await prisma.paymentTransaction.update({
    where: { id: PRIMARY_ID },
    data: { status: "SUCCEEDED", reason: "xero_invoice_paid_reconciliation" },
  });
  await prisma.payment.update({
    where: { id: PAYMENT_ID },
    data: { status: refundedCents > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED", refundedAmountCents: refundedCents },
  });
  await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID" } });
}

/** The backend ids queued behind `blockerPid` (`pg_blocking_pids`), polled on the real clock. */
async function untilQueuedBehind(blockerPid: number): Promise<number[]> {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < 20_000) {
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (rows.length > 0) return rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Nothing queued behind backend ${blockerPid}`);
}

/** The payment's net: what it holds after refunds. */
async function netCents(): Promise<number> {
  const { payment } = await figures();
  return payment.amountCents - payment.refundedAmountCents;
}

async function cancellationCreditCents(): Promise<number> {
  const credits = await prisma.memberCredit.findMany({
    where: { memberId: MEMBER_ID, sourceBookingId: BOOKING_ID, type: "CANCELLATION_REFUND" },
    select: { amountCents: true },
  });
  return credits.reduce((sum, credit) => sum + credit.amountCents, 0);
}

(RUN ? describe : describe.skip)("a bank transfer settles at the cash its invoice collected, against PostgreSQL (#3979)", () => {
  beforeAll(async () => {
    assertSafeIbSettleFromCashRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
    creditNoteRepairs = await import("@/lib/xero-inbound/credit-note-repairs");
    noteRefunds = await import("@/lib/xero-inbound/modification-note-refunds");
    paymentTransactions = await import("@/lib/payment-transactions");
    memberCredit = await import("@/lib/member-credit");

    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Settle", lastName: "Proof", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3979 Lodge", slug: "race-3979" } });
    // Everything back, no fee: the cancel's credit IS its cap.
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
  }, 60_000); // cold imports of the reconcile's module graph, on a loaded machine

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("THE WORKED EXAMPLE: booked at $300, cut to $200 before its invoice, paid $200: the row, the payment and the bank receipt are $200, and the cancel's cap is $200", async () => {
    await bookAt(30_000);
    await editPriceTo(20_000);
    await raiseInvoice();

    await settle(20_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("PAID");

    // A replay of the same PAID invoice decides nothing again.
    await settle(20_000);
    expect((await figures()).receipts).toEqual([20_000]);

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(result.status).toBe(200);
    expect(await cancellationCreditCents()).toBe(20_000);
  }, 60_000);

  it("RAISED before its invoice: booked at $200, raised to $300, paid $300: everything is $300, and the cancel credits $300 back where the stale $200 used to cap it", async () => {
    await bookAt(20_000);
    await editPriceTo(30_000);
    await raiseInvoice();

    await settle(30_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, status: "SUCCEEDED" },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
      receipts: [30_000],
    });

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(result.status).toBe(200);
    expect(await cancellationCreditCents()).toBe(30_000);
  }, 60_000);

  it("A FINISHED-STAY FEE recorded before the invoice: the invoice bills price and fee, and the settle records both", async () => {
    await bookAt(20_000, { finished: true });
    // #3955: the approved change on the finished stay records its fee on the payment.
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });
    await raiseInvoice();

    await settle(22_500);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 22_500, status: "SUCCEEDED" },
      primary: { amountCents: 22_500, status: "SUCCEEDED" },
      receipts: [22_500],
    });
    // The cash is exactly what the booking owes (worth = price + fee).
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("COMPLETED");
  }, 60_000);

  it("THE LATE CAPACITY CANCEL: raised to $300 before its invoice, paid $300 after the beds went: the member's credit is the $300 the invoice collected", async () => {
    await bookAt(20_000, { holdsBeds: false });
    await editPriceTo(30_000);
    await raiseInvoice();

    await settle(30_000);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000 },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
      receipts: [30_000],
    });
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(30_000);
    // The cancel arm's own alert, for the whole cash; never a "partial" one.
  }, 60_000);

  it("A CORRECTION ON A LATE CAPACITY CANCEL: invoice $300 less a $100 invoice-correction note, paid $200: the whole cash is credited, never as a mixed invoice's portion (#4095 item 2)", async () => {
    await bookAt(30_000, { holdsBeds: false });
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });

    const result = await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    // The correction lowered what the invoice asked for: the $200 is all of it.
    expect(result.partialCashCreditedInternetBankingBookings).toBe(0);
    const credited = await prisma.bookingEvent.findMany({
      where: { bookingId: BOOKING_ID, type: "CREDITED" },
      select: { reason: true },
    });
    expect(credited.map((event) => event.reason)).toEqual(["Paid Internet Banking amount held as account credit."]);
  }, 60_000);

  it("A CORRECTION ON A KEPT LATE CAPACITY CANCEL: the stored $300 kept on incomplete cash, $200 paid against $300 less a $100 correction: never a mixed invoice's portion (#4095 item 2)", async () => {
    await bookAt(30_000, { holdsBeds: false });
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });

    const result = await paidEffects.syncInternetBankingPaymentsForPaidInvoice(
      { ...paidInvoice(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] }), amountPaid: "degraded" } as unknown as Invoice,
      [PAYMENT_ID],
      CLUB_FORMAT_TEST,
    );

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(20_000);
    expect(result.partialCashCreditedInternetBankingBookings).toBe(0);
  }, 60_000);

  it("CONTROL: a rise AFTER the invoice stays on its supplementary invoice, so the primary keeps $200", async () => {
    await bookAt(20_000);
    await raiseInvoice();
    await editPriceTo(30_000);
    // The edit's supplementary invoice for the $100 increase, as its writer links it.
    await prisma.bookingModification.create({
      data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: 10_000, changeFeeCents: 0 },
    });
    await prisma.xeroObjectLink.create({
      data: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "INVOICE", xeroObjectId: "race-3979-supplementary", role: "SUPPLEMENTARY_INVOICE", active: true },
    });

    await settle(20_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: "race-3979-supplementary" } });
  }, 60_000);

  it("DECISION 2: invoice $300, an invoice-correction note of $100, paid $200: $200 paid and $0 refunded, and a recount keeps it", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });

    // The note reaches the inbound sync before the bank transfer: a correction
    // folds nothing into the never-paid payment.
    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 0, status: "PENDING" });

    await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });

    // The same note read again AFTER the capture is still a correction.
    await syncNote(10_000);
    // And a recount from the ledger rows keeps it.
    await paymentTransactions.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
  }, 60_000);

  it("A CORRECTION SYNCED BEFORE A KEPT SETTLE: the settle keeps the stored $300 and recounts the correction after its commit, so the net is the $200 of cash, never $300 (#4095 items 5 and 12)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });

    // Synced before the transfer: against an uncaptured receipt it counts nothing.
    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 0, status: "PENDING" });

    // Xero's amount paid reads unquantifiable, so the cash is incomplete and the
    // settle keeps the stored figure, captured at $300.
    await paidEffects.syncInternetBankingPaymentsForPaidInvoice(
      { ...paidInvoice(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] }), amountPaid: "degraded" } as unknown as Invoice,
      [PAYMENT_ID],
      CLUB_FORMAT_TEST,
    );
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, refundedAmountCents: 10_000 },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
    });
    expect(await netCents()).toBe(20_000);

    // The note's own later sync counts it once, not twice.
    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 10_000 });
  }, 60_000);

  it("A WRITER QUEUED BEHIND A KEPT SETTLE reads the corrected net at its commit, never the stored figure before the recount after it (#4095 review, item 1)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });
    await syncNote(10_000);

    // Hold the receipt row, so the settle stops at its receipt write with the
    // Payment row (`lockPaymentForRefundedTotal`) already taken.
    let releaseReceipt!: () => void;
    const receiptHeld = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    let holderPid = 0;
    const holder = prisma.$transaction(
      async (tx) => {
        holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        await tx.$queryRaw`SELECT id FROM "PaymentTransaction" WHERE id = ${PRIMARY_ID} FOR UPDATE`;
        await receiptHeld;
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    const startedAt = process.hrtime.bigint();
    while (holderPid === 0 && realElapsedMs(startedAt) < 10_000) await new Promise((resolve) => setTimeout(resolve, 10));

    const settling = paidEffects.syncInternetBankingPaymentsForPaidInvoice(
      { ...paidInvoice(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] }), amountPaid: "degraded" } as unknown as Invoice,
      [PAYMENT_ID],
      CLUB_FORMAT_TEST,
    );
    try {
      const [settlePid] = await untilQueuedBehind(holderPid);

      // A writer queued on the settle's Payment row, as a cancel queues on its
      // locks: its read is answered the moment the settle commits, before the
      // recount after the commit can run.
      const queuedRead = prisma.$transaction(
        async (tx) =>
          (await tx.$queryRaw<Array<{ refundedAmountCents: number }>>`
            SELECT "refundedAmountCents" FROM "Payment" WHERE id = ${PAYMENT_ID} FOR UPDATE
          `)[0].refundedAmountCents,
        { maxWait: 10_000, timeout: 60_000 },
      );
      await untilQueuedBehind(settlePid);
      releaseReceipt();

      expect(await queuedRead).toBe(10_000);
    } finally {
      releaseReceipt();
      await holder;
      await settling;
    }
    expect(await netCents()).toBe(20_000);
  }, 60_000);

  it("A NOTE WORDED AS A REFUND still counts as refunded, so the settle keeps the stored figure rather than count the reduction twice", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    // An older note raised before #3536's wording existed: a bank-transfer refund.
    await queueModificationNote(10_000, { refundMethod: "internet-banking" });

    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 10_000 });

    await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, refundedAmountCents: 10_000 },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
    });
    expect(await netCents()).toBe(20_000);
  }, 60_000);

  it("SYNCED AFTER THE SETTLE: a refund-worded note applied before payment keeps the stored figure, and its later fold leaves the net at the cash (review D)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { refundMethod: "internet-banking" });

    // The invoice lists the note applied; the note itself has not synced yet.
    await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
    });

    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 10_000 });
    expect(await netCents()).toBe(20_000);
  }, 60_000);

  it("A CORRECTION FOLDED BEFORE #3979: its re-sync changes nothing, and the settle clears the fold the invoice exactly explains and records the cash (review A)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });
    // What the sync wrote before this change: the correction counted as refunded.
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" } });

    // The note now contributes nothing to a never-paid payment, so its re-sync
    // names no payment and writes nothing: no backfill, and no un-refund.
    await syncNote(10_000);
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });

    await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
  }, 60_000);

  it("GUEST REMOVAL AFTER, the fold cleared at the settle: a later note's recount leaves $50 refunded and the net at the true $150 (review A)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" } });
    await syncNote(10_000);
    await settle(20_000, { totalCents: 30_000, appliedNotes: [{ id: NOTE_ID, cents: 10_000 }] });

    // A guest removed later: a $50 reduction refunded by bank transfer.
    const later = { noteId: LATER_NOTE_ID, modificationId: LATER_MODIFICATION_ID };
    await queueModificationNote(5_000, { refundMethod: "internet-banking" }, later);
    await syncNote(5_000, later);

    expect((await figures()).payment).toMatchObject({ amountCents: 20_000, refundedAmountCents: 5_000 });
    expect(await netCents()).toBe(15_000);
  }, 60_000);

  it("GUEST REMOVAL AFTER, settled before #3979 at the stored $300: the recount keeps counting the correction, so the net is the true $150, never $250 (review A)", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });
    // Before this change: the correction folded in, and the receipt settled at $300.
    await syncNote(10_000);
    await settledBeforeThisChange(10_000);
    expect(await netCents()).toBe(20_000);

    const later = { noteId: LATER_NOTE_ID, modificationId: LATER_MODIFICATION_ID };
    await queueModificationNote(5_000, { refundMethod: "internet-banking" }, later);
    await syncNote(5_000, later);

    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 15_000 });
    expect(await netCents()).toBe(15_000);
    // And the correction's own re-sync leaves it so.
    await syncNote(10_000);
    expect(await netCents()).toBe(15_000);
  }, 60_000);

  it("A CARD REFUNDED BEFORE THE SWITCH (#1765): the receipt is the cash, the payment's figure and status are what the ledger projects, and the cancel credits the $200 back (review B)", async () => {
    await bookAt(30_000);
    await prisma.paymentTransaction.create({
      data: {
        paymentId: PAYMENT_ID,
        kind: "PRIMARY",
        source: "STRIPE",
        stripePaymentIntentId: "pi_race_3979_refunded",
        amountCents: 30_000,
        refundedAmountCents: 30_000,
        status: "REFUNDED",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 30_000, status: "REFUNDED" } });
    await editPriceTo(20_000);
    await raiseInvoice();

    await settle(20_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 50_000, refundedAmountCents: 30_000, status: "PARTIALLY_REFUNDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    // The ledger's own projection agrees.
    await paymentTransactions.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    expect((await figures()).payment).toMatchObject({ amountCents: 50_000, refundedAmountCents: 30_000, status: "PARTIALLY_REFUNDED" });

    // Left REFUNDED, the cancel would have refunded nothing.
    const { cancelBooking } = await import("@/lib/booking-cancel");
    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(result.status).toBe(200);
    expect(await cancellationCreditCents()).toBe(20_000);
  }, 60_000);

  it("ACCOUNT CREDIT FROM ANOTHER EDIT: an $80 credit kept from another booking's edit, spent here, is the member's own credit, never a refund-worded note (#3979 final review)", async () => {
    await bookAt(30_000);
    // Booking A's reduction kept as account credit: the lot carries its own
    // account-credit note, raised by A's edit (no refund method on its payload).
    const lot = await prisma.memberCredit.create({
      data: {
        memberId: MEMBER_ID,
        amountCents: 8_000,
        type: "BOOKING_MODIFICATION_REFUND",
        description: "race 3979 credit kept from another booking's edit",
        xeroCreditNoteId: NOTE_ID,
      },
    });
    await prisma.xeroSyncOperation.create({
      data: {
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: MODIFICATION_ID,
        idempotencyKey: "race-3979-other-booking-account-credit",
        correlationKey: "race-3979-other-booking-account-credit",
        status: "SUCCEEDED",
        queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: NOTE_ID,
        requestPayload: { queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE", refundAmountCents: 8_000 },
      },
    });
    // Spent on this booking: $220 left to pay by bank transfer.
    await prisma.$transaction((tx) => memberCredit.applyCreditToBooking(MEMBER_ID, 8_000, BOOKING_ID, tx, CLUB_FORMAT_TEST));
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { amountCents: 22_000, creditAppliedCents: 8_000 } });
    await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { amountCents: 22_000 } });
    // Cut by $50 before the invoice exists; the invoice bills $250 and carries
    // the $80 credit as an applied note; the member pays $170.
    await editPriceTo(25_000);
    await raiseInvoice();

    await settle(17_000, { totalCents: 25_000, appliedNotes: [{ id: NOTE_ID, cents: 8_000 }] });

    expect(await figures()).toMatchObject({
      payment: { amountCents: 17_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 17_000, status: "SUCCEEDED" },
      receipts: [17_000],
    });
    expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, reason: { contains: "needs checking" } } })).toBe(0);
    await prisma.memberCredit.deleteMany({ where: { id: lot.id } });
  }, 60_000);
});
