/**
 * Real-PostgreSQL proof for #5288 (owner decision, 20 Nov 2026): an edit that
 * raises what a PAID Internet Banking booking is worth, before its primary Xero
 * invoice is linked, asks for the increase as a linked booking's edit does - the
 * "additional Internet Banking payment" email with the payment reference - and
 * bills it by raising the primary invoice now. That invoice bills the price plus
 * every recorded fee (`buildPrimaryInvoiceLines`), with the applied credit
 * allocated against it, so the increase is on one Xero document by
 * construction and no supplementary invoice is raised beside it.
 *
 * THE EDIT IS THE REAL DOOR: `modifyBookingDates` and `modifyBookingBatch`,
 * under their real locks and post-lock re-read. The invoice's provider leg is
 * stood in for as `primary-invoice-edit-race.realdb.test.ts` does: the create's
 * own snapshot read and line builder, then the real link save and gap check.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-5288-` fixtures and restores the module settings
 * it changes.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { memberMoneyTestContext } from "@/lib/__tests__/support/member-money-fixtures";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-5288-owner";
const OFFICER_ID = "race-5288-officer";
const LODGE_ID = "race-5288-lodge";
const SEASON_ID = "race-5288-season";
const BOOKING_ID = "race-5288-booking";
const GUEST_ID = "race-5288-guest";
const PAYMENT_ID = "race-5288-payment";
const PRIMARY_ID = "race-5288-primary";
const INVOICE_ID = "race-5288-xero-invoice";
const REFERENCE = "BOOKING-RACE5288";
// Nine days out against the frozen suite clock (1 July 2026): the 50% tier.
const CHECK_IN = new Date("2026-07-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-07-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-07-12T00:00:00.000Z");
// Nineteen days out, same length: the price is unchanged, so the fee alone is owed.
const MOVED = { checkIn: "2026-07-20", checkOut: "2026-07-22" };
// One night longer than MOVED, for a later edit of the moved stay.
const MOVED_LONGER = { checkIn: "2026-07-20", checkOut: "2026-07-23" };
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;
/** (100% - 50%) of the original price: the fee the policy sets for the move. */
const FEE_CENTS = PRICE_CENTS / 2;
const IB_ASK = /An additional Internet Banking payment of \$50\.00 is required\./;

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
let confirmationSync: typeof import("@/lib/booking-ledger-confirmation-sync");
let editSettlement: typeof import("@/lib/xero-booking-edit-settlement");
let outbox: typeof import("@/lib/xero-operation-outbox");
let ledgerAsk: typeof import("@/lib/additional-payment-ask");
let snapshot: typeof import("@/lib/xero-primary-invoice-read");
let primaryLines: typeof import("@/lib/xero-primary-invoice-lines");
let gap: typeof import("@/lib/xero-primary-invoice-fee-gap");
let invoices: typeof import("@/lib/xero-booking-invoices");
let paymentState: typeof import("@/lib/booking-payment-state");
let lineItems: typeof import("@/lib/xero-modification-line-items");
let mappings: typeof import("@/lib/xero-mappings");
let taxRendering: typeof import("@/lib/xero-tax-rendering");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;
let priorModules: { xeroIntegration: boolean } | null | undefined;

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function drainXeroWork(): Promise<void> {
  while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
}

async function clean(): Promise<void> {
  await drainXeroWork();
  const localIds = [BOOKING_ID, PAYMENT_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: INVOICE_ID }] } });
  await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
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
  await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: BOOKING_ID } } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

async function setXeroModule(on: boolean): Promise<void> {
  await prisma.clubModuleSettings.upsert({
    where: { id: "default" },
    create: { id: "default", xeroIntegration: on },
    update: { xeroIntegration: on },
    select: { id: true },
  });
}

/**
 * The #5288 shape: a PAID Internet Banking booking whose whole price account
 * credit settled, nothing captured, no primary invoice linked yet - one guest,
 * two nights, the credit on the ledger as the settle posted it.
 */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAID",
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Credit",
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
      amountCents: 0,
      creditAppliedCents: PRICE_CENTS,
      source: "INTERNET_BANKING",
      status: "SUCCEEDED",
      reference: REFERENCE,
      internetBankingHoldSlots: false,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: 0,
          status: "SUCCEEDED",
          reference: REFERENCE,
          reason: "internet_banking_booking_payment",
        },
      },
    },
  });
  await prisma.memberCredit.create({
    data: { memberId: OWNER_ID, amountCents: -PRICE_CENTS, type: "BOOKING_APPLIED", appliedToBookingId: BOOKING_ID, description: "Applied at booking" },
  });
  await prisma.$transaction((tx) =>
    confirmationSync.postStoredBookingConfirmationLedgerLines(tx, BOOKING_ID, memberMoneyTestContext()),
  );
}

/** The invoice job's link, as the create saves it: on the payment, its PRIMARY row, and the active link. */
async function linkInvoice(): Promise<void> {
  await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5288" } });
  await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5288" } });
  await prisma.xeroObjectLink.create({
    data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
  });
}

async function moveByDates(input: { checkIn: string; checkOut: string } = MOVED) {
  return dateService.modifyBookingDates({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
  });
}

async function moveByBatch(input: { checkIn: string; checkOut: string } = MOVED) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

async function primaryInvoiceOps() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "INVOICE", operationType: "CREATE" },
    select: { id: true, status: true },
  });
}

async function allocationOps() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "ALLOCATION" },
    select: { status: true },
  });
}

async function supplementaryInvoiceOps() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "BookingModification", localId: { in: await modificationIds() }, queueType: "SUPPLEMENTARY_INVOICE" },
    select: { localId: true, status: true, requestPayload: true },
  });
}

/** The member's "Booking Modified" email, once the door's unawaited send has written it. */
async function modifiedEmailHtml(): Promise<string> {
  const row = await vi.waitFor(
    async () => {
      const found = await prisma.emailLog.findFirst({
        where: { bookingId: BOOKING_ID, templateName: "booking-modified" },
        orderBy: { createdAt: "desc" },
        select: { htmlBody: true, bookingRetryHtmlBody: true },
      });
      if (!found) throw new Error("no booking-modified email yet");
      return found;
    },
    { timeout: 10_000, interval: 50 },
  );
  return row.bookingRetryHtmlBody ?? row.htmlBody ?? "";
}

/** `INV-PAY-047`'s typed census and its SQL twin, for this booking. */
async function censusVerdicts() {
  const census = await import("@/lib/booking-ledger-census");
  const typed = (await census.loadBookingLedgerCensus()).find((row) => row.bookingId === BOOKING_ID);
  const raw = (await prisma.$queryRawUnsafe<Array<{ bookingId: string; residualCents: number; billedInXero: boolean }>>(
    ledgerAsk.bookingLedgerCensusSql(),
  )).find((row) => row.bookingId === BOOKING_ID);
  return { typed, raw };
}

/** The fee-only move's asks: the email, one primary invoice and its credit allocation, and the census. */
async function expectFeeAskedOnNewPrimaryInvoice(): Promise<void> {
  await drainXeroWork();
  const html = await modifiedEmailHtml();
  expect(html).toMatch(IB_ASK);
  expect(html).toContain(`Payment reference: ${REFERENCE}.`);

  expect(await primaryInvoiceOps()).toEqual([expect.objectContaining({ status: "PENDING" })]);
  expect(await allocationOps()).toEqual([{ status: "PENDING" }]);
  expect(await supplementaryInvoiceOps()).toEqual([]);

  const { typed, raw } = await censusVerdicts();
  expect(typed).toMatchObject({ residualCents: FEE_CENTS, verdict: "billedInXero" });
  expect(raw).toMatchObject({ residualCents: FEE_CENTS, billedInXero: true });
}

(RUN ? describe : describe.skip)("#5288: an unlinked Internet Banking booking's edit increase is asked for, on PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "IB unlinked fee ask");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    dateService = await import("@/lib/booking-date-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");
    confirmationSync = await import("@/lib/booking-ledger-confirmation-sync");
    editSettlement = await import("@/lib/xero-booking-edit-settlement");
    outbox = await import("@/lib/xero-operation-outbox");
    ledgerAsk = await import("@/lib/additional-payment-ask");
    snapshot = await import("@/lib/xero-primary-invoice-read");
    primaryLines = await import("@/lib/xero-primary-invoice-lines");
    gap = await import("@/lib/xero-primary-invoice-fee-gap");
    invoices = await import("@/lib/xero-booking-invoices");
    paymentState = await import("@/lib/booking-payment-state");
    lineItems = await import("@/lib/xero-modification-line-items");
    mappings = await import("@/lib/xero-mappings");
    taxRendering = await import("@/lib/xero-tax-rendering");
    const queue = editSettlement.queueXeroBookingEditSettlement;
    // Pass-through: the harness imports every suite into one process.
    const spy = vi.spyOn(editSettlement, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();

    priorModules = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { xeroIntegration: true } });
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5288 Lodge", slug: "race-5288" } });
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
        name: "Race 5288 winter",
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
    await setXeroModule(true);
    await seed();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      await clean();
      if (priorModules) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorModules, select: { id: true } });
      else if (priorModules === null) await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
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

  it("a fee-only date move sends the Internet Banking ask and raises the primary invoice", async () => {
    await moveByDates();

    await expectFeeAskedOnNewPrimaryInvoice();
  }, 60_000);

  it("the batch door asks for the fee the same way", async () => {
    await moveByBatch();

    await expectFeeAskedOnNewPrimaryInvoice();
  }, 60_000);

  it("a primary invoice already queued is not queued twice", async () => {
    const before = await outbox.enqueueXeroBookingInvoiceOperation(BOOKING_ID, { invoiceEmailDelivery: null });
    expect(before.queueOperationId).not.toBeNull();

    await moveByDates();
    await drainXeroWork();

    expect(await primaryInvoiceOps()).toEqual([{ id: before.queueOperationId, status: "PENDING" }]);
    expect(await supplementaryInvoiceOps()).toEqual([]);
  }, 60_000);

  it("the primary invoice raised later bills the fee once, and its gap check queues nothing", async () => {
    await moveByDates();
    await drainXeroWork();
    const [operation] = await primaryInvoiceOps();

    // The create, up to Xero and back: its own read and line builder.
    const { booking: read, markedModificationIdsAtBuild } = await snapshot.readBookingForPrimaryInvoice(BOOKING_ID);
    const booking = read!;
    const built = primaryLines.buildPrimaryInvoiceLines({
      guests: booking.guests.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        priceCents: guest.priceCents,
        nights: guest.nights.map((night) => ({ stayDate: night.stayDate, priceCents: night.priceCents })),
      })),
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      nights: 2,
      hutFeeMapping: { code: "200", itemCode: null, codeExplicitlyConfigured: false },
      hutFeeItemCodeMap: await mappings.getHutFeeItemCodeMap(),
      seasonType: "WINTER",
      promo: { aggregateCents: 0, redemptions: [], adjustmentRows: [], firstGuest: null },
      changeFeeCents: paymentState.recordedChangeFeeCents(booking.payment),
      taxRendering: taxRendering.BASELINE_XERO_TAX_RENDERING,
    });
    expect(built.feeLines).toHaveLength(1);
    expect(lineItems.invoiceLineItemsTotalCents(built.feeLines)).toBe(FEE_CENTS);
    expect(lineItems.invoiceLineItemsTotalCents(built.lines)).toBe(PRICE_CENTS + FEE_CENTS);

    const atLink = await gap.persistPrimaryInvoiceLink({
      operationId: operation.id,
      paymentId: PAYMENT_ID,
      xeroInvoiceNumber: "INV-5288",
      billed: gap.primaryInvoiceBilledFee(INVOICE_ID, built.lines),
      built: {
        worthCents: paymentState.bookingWorthCents({ finalPriceCents: booking.finalPriceCents, changeFeeCents: booking.payment!.changeFeeCents }),
        lineTotalCents: lineItems.invoiceLineItemsTotalCents(built.lines),
        markedModificationIdsAtBuild,
      },
      primaryInvoiceCashCents: 0,
      primaryInvoiceAttemptedCashCents: 0,
    });
    if (!atLink) throw new Error("expected the first save of this link");
    const worthGap = await gap.queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink });
    expect(worthGap).toMatchObject({ gapCents: 0, queueOperationId: null });
    await prisma.xeroSyncOperation.update({ where: { id: operation.id }, data: { status: "SUCCEEDED" } });

    // The create's replay takes its "invoice already exists" exit: nothing more.
    await expect(invoices.createXeroInvoiceForBooking(BOOKING_ID)).resolves.toBe(INVOICE_ID);
    await drainXeroWork();
    expect(await supplementaryInvoiceOps()).toEqual([]);
    expect(await primaryInvoiceOps()).toHaveLength(1);
    // Linked now: still billed in Xero, never unasked.
    expect((await censusVerdicts()).typed).toMatchObject({ verdict: "billedInXero" });
  }, 60_000);

  it("a later edit after the link bills only its own increase, on a supplementary invoice", async () => {
    await moveByDates();
    await drainXeroWork();
    await linkInvoice();

    await moveByDates(MOVED_LONGER);
    await drainXeroWork();

    const later = await prisma.bookingModification.findFirstOrThrow({
      where: { bookingId: BOOKING_ID },
      orderBy: { createdAt: "desc" },
      select: { id: true, changeFeeCents: true },
    });
    const supplementary = await supplementaryInvoiceOps();
    expect(supplementary).toHaveLength(1);
    expect(supplementary[0]).toMatchObject({
      localId: later.id,
      requestPayload: expect.objectContaining({ priceDiffCents: NIGHT_CENTS, changeFeeCents: later.changeFeeCents }),
    });
    // The first edit's fee stays on the primary invoice alone.
    expect(later.changeFeeCents).not.toBe(FEE_CENTS);
    expect(await primaryInvoiceOps()).toHaveLength(1);
  }, 60_000);

  it("a booking whose primary invoice is linked is billed on a supplementary invoice, as before", async () => {
    await linkInvoice();

    await moveByDates();
    await drainXeroWork();

    const html = await modifiedEmailHtml();
    expect(html).toMatch(IB_ASK);
    expect(html).toContain("Xero invoice INV-5288 will be used for payment.");
    expect(await primaryInvoiceOps()).toEqual([]);
    const supplementary = await supplementaryInvoiceOps();
    expect(supplementary).toHaveLength(1);
    expect(supplementary[0].requestPayload).toMatchObject({ priceDiffCents: 0, changeFeeCents: FEE_CENTS });
  }, 60_000);

  it("with the Xero module off the member is still asked, and nothing is queued for Xero", async () => {
    await setXeroModule(false);

    await moveByDates();
    await drainXeroWork();

    const html = await modifiedEmailHtml();
    expect(html).toMatch(IB_ASK);
    expect(html).toContain(`Payment reference: ${REFERENCE}.`);
    expect(await primaryInvoiceOps()).toEqual([]);
    expect(await allocationOps()).toEqual([]);
    expect(await supplementaryInvoiceOps()).toEqual([]);
  }, 60_000);
});
