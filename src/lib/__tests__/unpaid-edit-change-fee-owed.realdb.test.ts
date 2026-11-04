/**
 * Real-PostgreSQL proof for #4661 (`INV-MOD-042`, `INV-PAY-119`): a change fee
 * an edit charges on an Internet Banking booking still to be paid is recorded
 * once, on its payment, and reaches the invoice and both ledgers through the
 * one fee planner ("Add fee to amount owed", #3750).
 *
 * THE EDIT IS THE REAL DOOR: `modifyBookingBatch`, under its real `lock(1)`,
 * lodge key and post-lock re-read, through `applyPaymentAdjustments` and its
 * claim on the Payment row. The settle is the real one too
 * (`syncInternetBankingPaymentsForPaidInvoice`), entered after its Xero read.
 *
 *  1. No invoice yet: moving the stay out of the late-notice tier records the
 *     fee on the payment and marks the edit's history row; the confirmation
 *     plan (which the journal's pending charge stands on) carries one
 *     CHANGE_FEE line under the edit's key, and the invoice paid at price plus
 *     fee settles to PAID with that line posted once.
 *  2. Invoice already issued: the fee is recorded on the payment once, and the
 *     edit's settlement queues a supplementary invoice for it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4661-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4661-owner";
const OFFICER_ID = "race-4661-officer";
const LODGE_ID = "race-4661-lodge";
const SEASON_ID = "race-4661-season";
const BOOKING_ID = "race-4661-booking";
const GUEST_ID = "race-4661-guest";
const PAYMENT_ID = "race-4661-payment";
const PRIMARY_ID = "race-4661-primary";
const INVOICE_ID = "race-4661-xero-invoice";
// Nine days out against the frozen suite clock (1 July 2026): the 50% tier.
const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-07-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-12T00:00:00.000Z");
// Nineteen days out: the full-refund tier, so the move charges the difference.
const MOVED = { checkIn: "2026-07-20", checkOut: "2026-07-22" };
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;
/** (100% - 50%) of the price: the fee the policy sets for the move. */
const FEE_CENTS = PRICE_CENTS / 2;

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let confirmationSync: typeof import("@/lib/booking-ledger-confirmation-sync");
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let editSettlement: typeof import("@/lib/xero-booking-edit-settlement");
const pendingXeroWork: Promise<unknown>[] = [];
const queuedForThisBooking: Array<Parameters<typeof import("@/lib/xero-booking-edit-settlement").queueXeroBookingEditSettlement>[0]> = [];
let restoreXeroQueue: (() => void) | undefined;

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function drainXeroWork(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
}

async function clean(): Promise<void> {
  await drainXeroWork();
  queuedForThisBooking.length = 0;
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: INVOICE_ID }] } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { entityId: { in: [BOOKING_ID, PAYMENT_ID] } },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { actorMemberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * A held (CONFIRMED) Internet Banking booking as `booking-create.ts` writes it:
 * one guest for two nights, the payment and its PRIMARY row PENDING at the
 * price, nothing captured.
 */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "CONFIRMED",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Owed",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: PRICE_CENTS,
      nights: {
        create: [
          { stayDate: CHECK_IN, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
          { stayDate: NIGHT_2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
        ],
      },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: PRICE_CENTS,
      source: "INTERNET_BANKING",
      status: "PENDING",
      reference: "BOOKING-RACE4661",
      internetBankingHoldSlots: true,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: PRICE_CENTS,
          status: "PENDING",
          reference: "BOOKING-RACE4661",
          reason: "internet_banking_booking_payment",
        },
      },
    },
  });
}

/** The invoice job's link: the invoice id on the payment and its PRIMARY row, and the active link. */
async function raiseInvoice(): Promise<void> {
  await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4661" } });
  await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4661" } });
  await prisma.xeroObjectLink.create({
    data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
  });
}

/** The officer's date move through the real batch door. */
async function moveStay() {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: MOVED as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

/** The real settle, after its read of a PAID invoice carrying `cashCents` of bank cash. */
async function settle(cashCents: number) {
  const invoice = {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-4661",
    status: "PAID",
    amountPaid: cashCents / 100,
    total: cashCents / 100,
    payments: [{ paymentID: "race-4661-xpay", amount: cashCents / 100, status: "AUTHORISED" }],
  } as unknown as Invoice;
  return paidEffects.syncInternetBankingPaymentsForPaidInvoice(invoice, [PAYMENT_ID], CLUB_FORMAT_TEST);
}

async function theEdit() {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true, changeFeeCents: true, newData: true },
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

(RUN ? describe : describe.skip)("an edit's change fee on a booking still to be paid, on PostgreSQL (#4661)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Unpaid edit change fee");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    confirmationSync = await import("@/lib/booking-ledger-confirmation-sync");
    paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
    editSettlement = await import("@/lib/xero-booking-edit-settlement");
    const queue = editSettlement.queueXeroBookingEditSettlement;
    // Pass-through: the harness imports every suite into one process.
    const spy = vi.spyOn(editSettlement, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (input.bookingId === BOOKING_ID) {
        queuedForThisBooking.push(input);
        pendingXeroWork.push(pending);
      }
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();

    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });

    for (const [id, firstName, role] of [
      [OWNER_ID, "Owner", Role.USER],
      [OFFICER_ID, "Officer", Role.ADMIN],
    ] as const) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName,
          lastName: "Proof",
          ageTier: "ADULT",
          canLogin: true,
          role,
        },
      });
    }
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4661 Lodge", slug: "race-4661" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.createMany({
      data: [
        { lodgeId: LODGE_ID, daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100 },
        { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 },
      ],
    });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 4661 winter",
        type: "WINTER",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        membershipTypeRates: {
          create: [
            { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
            { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
          ],
        },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
    } finally {
      restoreXeroQueue?.();
    }
  });

  it("before its invoice: the fee goes on the payment once, the plan carries it under the edit, and the settle at price plus fee posts it", async () => {
    await moveStay();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(FEE_CENTS);
    expect(edit.newData).toMatchObject({ changeFeeAddedToAmountOwed: true });
    const recorded = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } });
    expect(recorded.changeFeeCents).toBe(FEE_CENTS);

    // The one plan the legacy confirmation writes and the journal's pending charge re-states.
    const planned = await prisma.$transaction(async (tx) =>
      confirmationSync.planConfirmationPostings(tx, await confirmationSync.readConfirmationBooking(tx, BOOKING_ID), "pending charge"),
    );
    expect(planned.filter((posting) => posting.kind === "CHANGE_FEE")).toEqual([
      expect.objectContaining({ anchorKind: "MODIFICATION", anchorId: edit.id, unitCents: FEE_CENTS, sign: 1 }),
    ]);

    await drainXeroWork();
    await raiseInvoice();
    await settle(PRICE_CENTS + FEE_CENTS);

    expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { amountCents: true, status: true, changeFeeCents: true } }))
      .toEqual({ amountCents: PRICE_CENTS + FEE_CENTS, status: "SUCCEEDED", changeFeeCents: FEE_CENTS });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("PAID");
    const feeLines = await prisma.bookingLedgerLine.findMany({
      where: { bookingId: BOOKING_ID, kind: "CHANGE_FEE" },
      select: { amountCents: true, anchorId: true },
    });
    expect(feeLines).toEqual([{ amountCents: FEE_CENTS, anchorId: edit.id }]);

    // A replay of the same PAID invoice posts nothing again.
    await settle(PRICE_CENTS + FEE_CENTS);
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "CHANGE_FEE" } })).toBe(1);
  }, 60_000);

  it("after its invoice: the fee goes on the payment once and on the edit's own supplementary invoice", async () => {
    await raiseInvoice();

    await moveStay();
    await drainXeroWork();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(FEE_CENTS);
    expect(edit.newData).toMatchObject({ changeFeeAddedToAmountOwed: true });
    const recorded = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } });
    expect(recorded.changeFeeCents).toBe(FEE_CENTS);

    expect(queuedForThisBooking).toHaveLength(1);
    expect(editSettlement.classifyXeroBookingEditSettlement(queuedForThisBooking[0]).financialAction).toMatchObject({
      type: "supplementary-invoice",
      priceDiffCents: 0,
      changeFeeCents: FEE_CENTS,
    });
  }, 60_000);
});
