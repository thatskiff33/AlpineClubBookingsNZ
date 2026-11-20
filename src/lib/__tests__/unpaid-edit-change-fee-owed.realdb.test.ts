/**
 * Real-PostgreSQL proof (owner decision, 10 Nov 2026; `INV-MOD-042`,
 * `INV-PAY-119`): moving the dates of a booking that has not been paid
 * reprices it and records no late-notice fee. A booking that has been paid
 * still records the policy fee once.
 *
 * THE EDIT IS THE REAL DOOR: `modifyBookingBatch` and `modifyBookingDates`,
 * under the real locks and post-lock re-read.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4661-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { memberMoneyTestContext } from "@/lib/__tests__/support/member-money-fixtures";

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
// Nineteen days out: the full-refund tier, so a paid booking is charged the gap.
const MOVED = { checkIn: "2026-07-20", checkOut: "2026-07-22" };
// The same tier move, one night longer, so the price itself changes.
const MOVED_LONGER = { checkIn: "2026-07-20", checkOut: "2026-07-23" };
// The same tier move, one night shorter: the price falls by the fee.
const MOVED_SHORTER = { checkIn: "2026-07-20", checkOut: "2026-07-21" };
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;
const NEW_PRICE_CENTS = 3 * NIGHT_CENTS;
/** (100% - 50%) of the original price: the fee the policy sets for the move. */
const FEE_CENTS = PRICE_CENTS / 2;

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let confirmationSync: typeof import("@/lib/booking-ledger-confirmation-sync");
let editSettlement: typeof import("@/lib/xero-booking-edit-settlement");
let amountOwed: typeof import("@/lib/booking-amount-owed");
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
  // #4735: the row an edit opens has its own id.
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
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
async function moveStay(input: { checkIn: string; checkOut: string } = MOVED) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

async function dropPayment(): Promise<void> {
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.delete({ where: { id: PAYMENT_ID } });
}

/**
 * A PAID booking settled at $0: account credit (or a promotion) covered the
 * whole price, so nothing was captured from `source` (#5039).
 */
async function paidAtZero(source: "STRIPE" | "INTERNET_BANKING", creditCents = PRICE_CENTS): Promise<void> {
  const reference = source === "STRIPE" ? null : "BOOKING-RACE4661";
  await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID" } });
  await prisma.payment.update({
    where: { id: PAYMENT_ID },
    data: { status: "SUCCEEDED", amountCents: 0, source, creditAppliedCents: creditCents, reference, internetBankingHoldSlots: false },
  });
  await prisma.paymentTransaction.update({
    where: { id: PRIMARY_ID },
    data: { status: "SUCCEEDED", amountCents: 0, source, reference },
  });
  await prisma.memberCredit.create({
    data: { memberId: OWNER_ID, amountCents: -creditCents, type: "BOOKING_APPLIED", appliedToBookingId: BOOKING_ID, description: "Applied at booking" },
  });
}

/** A PAID Internet Banking booking whose transfer was matched: the price captured, no card behind it. */
async function paidByBank(): Promise<void> {
  await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID" } });
  await prisma.payment.update({
    where: { id: PAYMENT_ID },
    data: { status: "SUCCEEDED", amountCents: PRICE_CENTS, internetBankingHoldSlots: false },
  });
  await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { status: "SUCCEEDED" } });
}

/** The confirmation's ledger lines, as the settle that made the booking PAID posts them. */
async function confirmOnLedger(): Promise<void> {
  await prisma.$transaction((tx) =>
    confirmationSync.postStoredBookingConfirmationLedgerLines(tx, BOOKING_ID, memberMoneyTestContext()),
  );
}

async function postedFeeLines() {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID, kind: "CHANGE_FEE" },
    select: { amountCents: true, anchorId: true },
  });
}

async function plannedFeeLines() {
  const planned = await prisma.$transaction(async (tx) =>
    confirmationSync.planConfirmationPostings(tx, await confirmationSync.readConfirmationBooking(tx, BOOKING_ID), "pending charge"),
  );
  return planned.filter((posting) => posting.kind === "CHANGE_FEE").map((posting) => ({ unitCents: posting.unitCents, anchorId: posting.anchorId }));
}

async function paymentFeeCents(): Promise<number> {
  return (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } })).changeFeeCents;
}

async function theEdit() {
  const rows = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true, changeFeeCents: true, newData: true },
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

(RUN ? describe : describe.skip)("a late-notice fee is charged only once the booking is paid, on PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Unpaid edit change fee");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    dateService = await import("@/lib/booking-date-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    confirmationSync = await import("@/lib/booking-ledger-confirmation-sync");
    editSettlement = await import("@/lib/xero-booking-edit-settlement");
    amountOwed = await import("@/lib/booking-amount-owed");
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

  async function owedCents(): Promise<number> {
    return (
      await amountOwed.readBookingAmountOwed(
        await prisma.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: { id: true, finalPriceCents: true, payment: { select: { changeFeeCents: true } } },
        }),
      )
    ).owedCents;
  }

  it("before its invoice: the price changes and no late-notice fee is recorded", async () => {
    await moveStay(MOVED_LONGER);

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(0);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } }),
    ).toEqual({ changeFeeCents: 0 });
    expect(
      (await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } })).finalPriceCents,
    ).toBe(NEW_PRICE_CENTS);
    expect(await owedCents()).toBe(NEW_PRICE_CENTS);

    const planned = await prisma.$transaction(async (tx) =>
      confirmationSync.planConfirmationPostings(tx, await confirmationSync.readConfirmationBooking(tx, BOOKING_ID), "pending charge"),
    );
    expect(planned.filter((posting) => posting.kind === "CHANGE_FEE")).toEqual([]);
  }, 60_000);

  it("after its invoice: a price increase is invoiced without a fee", async () => {
    await raiseInvoice();
    await moveStay(MOVED_LONGER);
    await drainXeroWork();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(0);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } }),
    ).toEqual({ changeFeeCents: 0 });

    expect(queuedForThisBooking).toHaveLength(1);
    expect(editSettlement.classifyXeroBookingEditSettlement(queuedForThisBooking[0]).financialAction).toMatchObject({
      type: "supplementary-invoice",
      priceDiffCents: NIGHT_CENTS,
      changeFeeCents: 0,
    });
  }, 60_000);

  it("a card booking still at its pay step gains no fee", async () => {
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAYMENT_PENDING" } });
    await prisma.payment.update({
      where: { id: PAYMENT_ID },
      data: { source: "STRIPE", reference: null, internetBankingHoldSlots: false },
    });
    await prisma.paymentTransaction.update({
      where: { id: PRIMARY_ID },
      data: { source: "STRIPE", reference: null, reason: null, stripePaymentIntentId: "pi_race4661" },
    });

    await dateService.modifyBookingDates({
      bookingId: BOOKING_ID,
      actor: { id: OFFICER_ID, role: Role.ADMIN },
      input: MOVED as never,
      ipAddress: "127.0.0.1",
    });

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(0);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } }),
    ).toEqual({ changeFeeCents: 0 });
    expect(await owedCents()).toBe(PRICE_CENTS);
  }, 60_000);

  it("before a card booking's pay step: no fee-only payment row is opened", async () => {
    await dropPayment();
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAYMENT_PENDING" } });

    await moveStay();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(0);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(await prisma.payment.findUnique({ where: { bookingId: BOOKING_ID } })).toBeNull();
    expect(await owedCents()).toBe(PRICE_CENTS);
  }, 60_000);

  it("an unpaid whole-lodge booking keeps no payment row and no fee", async () => {
    await dropPayment();
    await prisma.booking.update({
      where: { id: BOOKING_ID },
      data: { status: "CONFIRMED", wholeLodgeHold: true },
    });

    await moveStay();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(0);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(await prisma.payment.findUnique({ where: { bookingId: BOOKING_ID } })).toBeNull();
  }, 60_000);

  it("a paid booking still records the policy fee once", async () => {
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAID" } });
    await prisma.payment.update({
      where: { id: PAYMENT_ID },
      data: { status: "SUCCEEDED", amountCents: PRICE_CENTS },
    });
    await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { status: "SUCCEEDED" } });

    await moveStay();

    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(FEE_CENTS);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } }),
    ).toEqual({ changeFeeCents: FEE_CENTS });
  }, 60_000);

  /**
   * #5039 (`INV-MOD-042`, `INV-PAY-119`): a paid edit's fee is on the edit, the
   * payment, the queued invoice work and the ledger exactly once - the edit
   * posts its own `CHANGE_FEE` line, and the confirmation plan adds none.
   */
  async function expectFeeRecordedOnce(): Promise<{ id: string }> {
    await drainXeroWork();
    const edit = await theEdit();
    expect(edit.changeFeeCents).toBe(FEE_CENTS);
    expect(edit.newData).not.toHaveProperty("changeFeeAddedToAmountOwed");
    expect(await paymentFeeCents()).toBe(FEE_CENTS);
    expect(queuedForThisBooking.map((queued) => queued.changeFeeCents)).toEqual([FEE_CENTS]);
    expect(await postedFeeLines()).toEqual([{ amountCents: FEE_CENTS, anchorId: edit.id }]);
    expect(await plannedFeeLines()).toEqual([]);
    return edit;
  }

  async function finalPriceCents(): Promise<number> {
    return (await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } })).finalPriceCents;
  }

  // A card source's fee-only move is the zero-dollar card increase (#3502),
  // which recorded its fee before #5039; every other row here did not.
  describe.each(["STRIPE", "INTERNET_BANKING"] as const)("#5039: a booking credit settled in full, paid from %s", (source) => {
    it.each([
      ["made one night cheaper", MOVED_SHORTER, false],
      ["made one night cheaper after its invoice", MOVED_SHORTER, true],
      ["moved for the fee alone", MOVED, false],
    ] as const)("records the fee on its payment once when %s", async (_name, move, invoiced) => {
      if (invoiced) await raiseInvoice();
      await paidAtZero(source);
      await confirmOnLedger();

      await moveStay(move);

      await expectFeeRecordedOnce();
      // The charge is the new price plus the fee, against the credit applied.
      expect(await owedCents()).toBe((await finalPriceCents()) + FEE_CENTS - PRICE_CENTS);
    }, 60_000);
  });

  it.each([
    ["made one night cheaper", MOVED_SHORTER],
    ["made one night longer", MOVED_LONGER],
  ] as const)("#5039: a booking paid by bank transfer and %s records the fee once", async (_name, move) => {
    await paidByBank();
    await confirmOnLedger();

    await moveStay(move);

    await expectFeeRecordedOnce();
    expect(await owedCents()).toBe((await finalPriceCents()) + FEE_CENTS);
  }, 60_000);

  it("#5039: a fee an earlier edit added to the amount owed keeps its one line beside a later paid edit's", async () => {
    // The #4661-era shape: an edit of the unpaid booking added its fee to the
    // amount owed, then credit settled the price and that fee.
    const earlier = await prisma.bookingModification.create({
      data: {
        bookingId: BOOKING_ID,
        memberId: OFFICER_ID,
        modificationType: "DATE_CHANGE",
        previousData: {},
        newData: { changeFeeAddedToAmountOwed: true },
        changeFeeCents: FEE_CENTS,
      },
    });
    await paidAtZero("INTERNET_BANKING", PRICE_CENTS + FEE_CENTS);
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: FEE_CENTS } });
    const earlierLine = { unitCents: FEE_CENTS, anchorId: earlier.id };
    expect(await plannedFeeLines()).toEqual([earlierLine]);
    await confirmOnLedger();
    expect(await postedFeeLines()).toEqual([{ amountCents: FEE_CENTS, anchorId: earlier.id }]);

    await moveStay(MOVED_SHORTER);

    const later = await prisma.bookingModification.findFirstOrThrow({
      where: { bookingId: BOOKING_ID, id: { not: earlier.id } },
      select: { id: true, changeFeeCents: true },
    });
    expect(later.changeFeeCents).toBe(FEE_CENTS);
    expect(await paymentFeeCents()).toBe(2 * FEE_CENTS);
    expect(await plannedFeeLines()).toEqual([earlierLine]);
    const posted = await postedFeeLines();
    expect(posted).toHaveLength(2);
    expect(posted).toEqual(expect.arrayContaining([
      { amountCents: FEE_CENTS, anchorId: earlier.id },
      { amountCents: FEE_CENTS, anchorId: later.id },
    ]));
  }, 60_000);

  it("#5039: a held bank-transfer booking still gains no fee on a late-notice move", async () => {
    await moveStay(MOVED_SHORTER);

    expect((await theEdit()).changeFeeCents).toBe(0);
    expect(await paymentFeeCents()).toBe(0);
  }, 60_000);

  it("#5039: a card booking at its pay step still gains no fee on a late-notice move through the batch door", async () => {
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAYMENT_PENDING" } });
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { source: "STRIPE", reference: null, internetBankingHoldSlots: false } });
    await prisma.paymentTransaction.update({
      where: { id: PRIMARY_ID },
      data: { source: "STRIPE", reference: null, reason: null, stripePaymentIntentId: "pi_race4661" },
    });

    await moveStay(MOVED_SHORTER);

    expect((await theEdit()).changeFeeCents).toBe(0);
    expect(await paymentFeeCents()).toBe(0);
  }, 60_000);

  /**
   * #5039: a PENDING booking with a captured card part-payment and account
   * credit for the rest is charged the fee, and the edit's own fee write lands
   * after the door read the payment. Both doors keep the credit that pays that
   * fee: the clamp sizes credit to the price plus every recorded fee, this
   * edit's included, so no credit is handed back and the card part still
   * covers the rest exactly.
   */
  it.each(["batch", "dates"] as const)(
    "#5039: a PENDING part-captured, credit-paid booking keeps the credit that pays this edit's fee (%s door)",
    async (door) => {
      const capturedCents = 2_000;
      const creditCents = PRICE_CENTS - capturedCents;
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PENDING" } });
      await prisma.payment.update({
        where: { id: PAYMENT_ID },
        data: { status: "SUCCEEDED", amountCents: capturedCents, source: "STRIPE", creditAppliedCents: creditCents, reference: null, internetBankingHoldSlots: false },
      });
      await prisma.paymentTransaction.update({
        where: { id: PRIMARY_ID },
        data: { status: "SUCCEEDED", amountCents: capturedCents, source: "STRIPE", reference: null, reason: null, stripePaymentIntentId: "pi_race4661" },
      });
      await prisma.memberCredit.create({
        data: { memberId: OWNER_ID, amountCents: -creditCents, type: "BOOKING_APPLIED", appliedToBookingId: BOOKING_ID, description: "Applied at booking" },
      });

      if (door === "batch") {
        await moveStay(MOVED_SHORTER);
      } else {
        await dateService.modifyBookingDates({
          bookingId: BOOKING_ID,
          actor: { id: OFFICER_ID, role: Role.ADMIN },
          input: MOVED_SHORTER as never,
          ipAddress: "127.0.0.1",
        });
      }

      // The new price (one night) plus the fee equals the old price, so the
      // credit applied still pays exactly its share.
      expect(await finalPriceCents()).toBe(NIGHT_CENTS);
      expect((await theEdit()).changeFeeCents).toBe(FEE_CENTS);
      expect(await paymentFeeCents()).toBe(FEE_CENTS);
      const credit = await prisma.memberCredit.aggregate({
        where: { memberId: OWNER_ID, appliedToBookingId: BOOKING_ID },
        _sum: { amountCents: true },
      });
      expect(credit._sum.amountCents).toBe(-creditCents);
    },
    60_000,
  );
});
