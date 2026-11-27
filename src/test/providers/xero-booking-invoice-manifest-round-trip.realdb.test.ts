/**
 * The booking-invoice family's export manifests, proved by a round trip on the
 * provider fakes (#4525, Ledger M13; ALP-753) against real PostgreSQL.
 *
 * The app's own Xero session is served by `XeroFake` through `xeroTransport`
 * (`setXeroClientForTests`), so the production senders run unmocked: the
 * primary invoice (`createXeroInvoiceForBooking`), an edit's credit note
 * (`createXeroCreditNoteForModification`) and a supplementary invoice billing
 * an edit's change fee and a settled review share
 * (`createXeroSupplementaryInvoice`). The journal they are measured against is
 * posted by the real writers: the manual settle, the edit doors' posting and a
 * review closure. Each document is then read back through the app's client,
 * and the manifest its sender recorded must cover exactly the lines Xero holds
 * (`manifest-round-trip.ts`). A repeat send moves no manifest, and a second
 * note on the same slice is recorded as a conflict with no second cover.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL the race harness uses, and owns its `race-5253-` rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LineItem } from "xero-node";
import type { CalendarDate } from "@/lib/club-time";
import type { SuiteEnvironmentRoleDeclaration } from "@/lib/__tests__/helpers/environment-role";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { memberMoneyTestContext } from "@/lib/__tests__/support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import {
  cleanHistories,
  createHistoryBooking,
  historyNames,
  postHistoryEdit,
  seedHistoryFixtures,
  settleHistoryByCard,
} from "@/lib/__tests__/support/booking-ledger-history";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";
import { expectCoverageEqualsLines, readBackDocument, readManifest, readManifests } from "./manifest-round-trip";
import { XeroFake } from "./xero-fake";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-5253-";
const names = historyNames(PREFIX);
/** A bank-transfer booking, invoiced before any money arrives: an edit's note is allocated against its open invoice. */
const BOOKING_ID = `${PREFIX}transfer`;
/** A card booking, settled before it is invoiced: an edit with a review share is billed on a supplementary invoice. */
const CARD_ID = `${PREFIX}card`;
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const PRICE = 20_000;
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
/** The removal: the second guest's two nights. */
const REMOVED = 10_000;
/** The second edit: one night re-priced up 10.00, with a 5.00 change fee. */
const REPRICED = 1_000;
const CHANGE_FEE = 500;
/** The review settled against the second edit: another night re-priced up 15.00, charged to the member. */
const SHARE = 1_500;

let prisma: PrismaClient;
let xeroOverride: typeof import("@/lib/xero-test-client-override");
let xeroTransport: (typeof import("./xero-transport"))["xeroTransport"];
let doors: typeof import("@/lib/member-money/doors");
let role: SuiteEnvironmentRoleDeclaration | undefined;
/** The change-fee line's words (`xero-modification-line-items.ts`), loaded with the database: that module reaches `@/lib/prisma`. */
let changeFeeLineDescription: string;

const isFeeLine = (line: LineItem) => line.description === changeFeeLineDescription;
const stayAndFee = [
  { account: "BOOKING_REVENUE" as const, lines: (line: LineItem) => !isFeeLine(line) },
  { account: "FEE_REVENUE" as const, lines: isFeeLine },
];

/** Each event happens a minute after the last, as the census orders them. */
function tick(): void {
  vi.setSystemTime(new Date(Date.now() + 60_000));
}

/** Every manifest and coverage row the bookings hold, in a stable order: what a repeat must leave as it was. */
async function manifestState() {
  return prisma.memberMoneyExportManifest.findMany({
    where: { bookingId: { in: [BOOKING_ID, CARD_ID] } },
    orderBy: [{ documentRole: "asc" }, { legacyKey: "asc" }],
    select: {
      id: true, documentRole: true, legacyKey: true, outcome: true, reason: true, payloadHash: true, lineTotalCents: true, providerInvoiceId: true,
      coverage: { orderBy: [{ account: "asc" }, { sliceKey: "asc" }], select: { id: true, account: true, chargeIdentity: true, sliceKey: true, coveredCents: true, coverageGeneration: true } },
    },
  });
}

/** A review of `modificationId` settled by an officer as a charge of `SHARE`, re-pricing the first guest's first night: its task and its closure, as the review door posts them. */
async function settleReviewShare(bookingId: string, modificationId: string): Promise<string> {
  tick();
  const { raiseEditFinancialReviewTask } = await import("@/lib/edit-financial-review");
  const { postReviewClosureLedgerLines } = await import("@/lib/booking-ledger-modification-sync");
  const { taskId } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return raiseEditFinancialReviewTask({
      occurrence: {
        bookingId: bookingId,
        bookingGuestId: `${bookingId}-g1`,
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: [],
        addedNightDates: ["2027-08-01" as CalendarDate],
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
  tick();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { totalPriceCents: true, finalPriceCents: true } });
    await tx.bookingGuestNight.updateMany({ where: { bookingGuestId: `${bookingId}-g1`, stayDate: D1 }, data: { priceCents: 5_000 + SHARE, priceSource: "OFFICER_PRICED" } });
    await tx.bookingGuest.update({ where: { id: `${bookingId}-g1` }, data: { priceCents: { increment: SHARE } } });
    await tx.booking.update({ where: { id: bookingId }, data: { totalPriceCents: booking.totalPriceCents + SHARE, finalPriceCents: booking.finalPriceCents + SHARE } });
    const rebase = await tx.bookingModification.create({
      data: { bookingId: bookingId, memberId: names.officerId, modificationType: "PRICE_REBASE", previousData: {}, newData: {}, priceDiffCents: SHARE, changeFeeCents: 0 },
      select: { id: true },
    });
    await tx.manualRefundTask.update({
      where: { id: taskId },
      data: { status: "COMPLETED", amountCents: SHARE, settlementDirection: "CHARGE_TO_MEMBER", completedAt: new Date(), completedByMemberId: names.officerId },
    });
    await postReviewClosureLedgerLines({
      store: tx, journal: memberMoneyTestContext(), bookingId: bookingId, lodgeId: names.lodgeId, manualRefundTaskId: taskId,
      rebase: {
        previousTotalPriceCents: booking.totalPriceCents, previousDiscountCents: 0, previousPromoAdjustmentCents: 0, previousFinalPriceCents: booking.finalPriceCents,
        newTotalPriceCents: booking.totalPriceCents + SHARE, newDiscountCents: 0, newPromoAdjustmentCents: 0, newFinalPriceCents: booking.finalPriceCents + SHARE, promoRemoved: false,
      },
      rebaseHistoryId: rebase.id,
      settlement: { direction: "CHARGE_TO_MEMBER", amountCents: SHARE },
      note: "Agreed with the member",
      officerMemberId: names.officerId,
    });
  });
  return taskId;
}

(RUN ? describe : describe.skip)("booking-invoice family manifests round-tripped through XeroFake - real PostgreSQL (#4525, ALP-753)", { timeout: 120_000 }, () => {
  let fake: XeroFake;

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking-invoice manifest round trip");
    process.env.DATABASE_URL = RACE_DB_URL;
    const { declareEnvironmentRoleForSuite } = await import("@/lib/__tests__/helpers/environment-role");
    role = declareEnvironmentRoleForSuite("non-production");
    ({ prisma } = await import("@/lib/prisma"));
    xeroOverride = await import("@/lib/xero-test-client-override");
    doors = await import("@/lib/member-money/doors");
    ({ CHANGE_FEE_LINE_DESCRIPTION: changeFeeLineDescription } = await import("@/lib/xero-modification-line-items"));
    // Loaded after DATABASE_URL points at the race database: the transport reaches `@/lib/prisma`.
    ({ xeroTransport } = await import("./xero-transport"));
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
    fake = new XeroFake(PREFIX);
    xeroOverride.setXeroClientForTests(xeroTransport(fake));
    // The bank-transfer booking's charge (R01) is journalled at the binding moment, as its door posts it, before any money.
    await createHistoryBooking(prisma, names, BOOKING_ID, { payment: { amountCents: PRICE, source: "INTERNET_BANKING" } });
    const { postBindingCharge } = await import("@/lib/booking-ledger-pending-charge");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await postBindingCharge(tx, memberMoneyTestContext(), BOOKING_ID, names.lodgeId);
    });
    // The card booking is confirmed and captured by the real settle.
    await createHistoryBooking(prisma, names, CARD_ID, { payment: { amountCents: PRICE, source: "STRIPE", intent: `pi_${CARD_ID}` } });
    await settleHistoryByCard(CARD_ID, PRICE);
  }, 120_000);

  afterAll(async () => {
    try {
      if (!prisma) return;
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { startsWith: PREFIX } } });
      await cleanHistories(prisma, PREFIX);
    } finally {
      xeroOverride?.resetXeroClientForTests();
      role?.restore();
    }
  }, 120_000);

  let invoiceId: string;
  let cardInvoiceId: string;

  it("each primary invoice's manifest covers exactly the lines Xero holds", async () => {
    const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
    for (const bookingId of [BOOKING_ID, CARD_ID]) {
      const id = await createXeroInvoiceForBooking(bookingId);
      expect(id, `the production push raised no invoice for ${bookingId}`).toBeTruthy();
      const document = await readBackDocument("INVOICE", id!);
      expect(document.totalCents).toBe(PRICE);
      const manifest = await readManifest(prisma, "PRIMARY_BOOKING_INVOICE", id!);
      expectCoverageEqualsLines(document, manifest, stayAndFee);
      expect(manifest.coverage).toEqual([{ account: "BOOKING_REVENUE", chargeIdentity: `booking:${bookingId}:charge`, sliceKey: "", coveredCents: PRICE }]);
      if (bookingId === BOOKING_ID) invoiceId = id!;
      else cardInvoiceId = id!;
    }
    // The bank transfer's invoice is open; the card booking's carries its capture.
    expect(fake.snapshot().invoices.map((i) => [i.invoiceID, i.amountDueCents])).toEqual([[invoiceId, PRICE], [cardInvoiceId, 0]]);
  });

  let noteId: string;
  const REMOVAL = `${BOOKING_ID}-removal`;

  it("an edit's credit note records a manifest covering the reduction its event posted, exactly as Xero holds the note", async () => {
    await postHistoryEdit(prisma, names, BOOKING_ID, REMOVAL, { removeGuestId: `${BOOKING_ID}-g2`, changeFeeCents: 0 });
    tick();
    const { createXeroCreditNoteForModification } = await import("@/lib/xero-modification-credit-notes");
    noteId = (await createXeroCreditNoteForModification({ bookingId: BOOKING_ID, refundAmountCents: REMOVED, bookingModificationId: REMOVAL, format: CLUB_FORMAT_TEST }))!;
    expect(noteId, "the production push raised no note").toBeTruthy();
    // The note went against the primary invoice, as an edit's reduction always does.
    expect(fake.snapshot().allocations).toEqual([expect.objectContaining({ creditNoteID: noteId, invoiceID: invoiceId, amountCents: REMOVED })]);
    const document = await readBackDocument("CREDIT_NOTE", noteId);
    expect(document.totalCents).toBe(REMOVED);
    const manifest = await readManifest(prisma, "MODIFICATION_CREDIT_NOTE", noteId);
    expectCoverageEqualsLines(document, manifest, stayAndFee);
    expect(manifest.coverage).toEqual([
      { account: "BOOKING_REVENUE", chargeIdentity: `booking:${BOOKING_ID}:charge`, sliceKey: `modification:${REMOVAL}`, coveredCents: REMOVED },
    ]);
  });

  let supplementaryId: string;
  const REPRICE = `${CARD_ID}-reprice`;

  it("a supplementary invoice's manifest covers the edit's slice, the settled review share's slice and the change fee, exactly as Xero holds them", async () => {
    await postHistoryEdit(prisma, names, CARD_ID, REPRICE, { reprice: { guestId: `${CARD_ID}-g1`, stayDate: D2, priceCents: 5_000 + REPRICED }, changeFeeCents: CHANGE_FEE });
    const taskId = await settleReviewShare(CARD_ID, REPRICE);
    tick();
    const { createXeroSupplementaryInvoice } = await import("@/lib/xero-supplementary-invoices");
    supplementaryId = (await createXeroSupplementaryInvoice({
      bookingId: CARD_ID, priceDiffCents: REPRICED + SHARE, changeFeeCents: CHANGE_FEE, bookingModificationId: REPRICE, recordPayment: false, format: CLUB_FORMAT_TEST,
    }))!;
    expect(supplementaryId, "the production push raised no supplementary invoice").toBeTruthy();
    const document = await readBackDocument("INVOICE", supplementaryId);
    expect(document.totalCents).toBe(REPRICED + SHARE + CHANGE_FEE);
    const manifest = await readManifest(prisma, "SUPPLEMENTARY_BOOKING_INVOICE", supplementaryId);
    expectCoverageEqualsLines(document, manifest, stayAndFee);
    const closure = manifest.coverage.find((row) => row.sliceKey.startsWith(`review-close:${taskId}:`));
    expect(manifest.coverage).toEqual(expect.arrayContaining([
      { account: "BOOKING_REVENUE", chargeIdentity: `booking:${CARD_ID}:charge`, sliceKey: `modification:${REPRICE}`, coveredCents: REPRICED },
      { account: "BOOKING_REVENUE", chargeIdentity: `booking:${CARD_ID}:charge`, sliceKey: closure?.sliceKey, coveredCents: SHARE },
      { account: "FEE_REVENUE", chargeIdentity: expect.any(String), sliceKey: "", coveredCents: CHANGE_FEE },
    ]));
    expect(manifest.coverage).toHaveLength(3);
  });

  it("a repeat of every send records nothing new, and a second note on the same slice is a conflict with no second cover", async () => {
    const before = await manifestState();
    // The card invoice's payment records its capture receipt beside the three documents proved above.
    expect(before.map((m) => m.documentRole).sort()).toEqual(["CAPTURE_RECEIPT", "MODIFICATION_CREDIT_NOTE", "PRIMARY_BOOKING_INVOICE", "PRIMARY_BOOKING_INVOICE", "SUPPLEMENTARY_BOOKING_INVOICE"]);

    // The same sends again: Xero answers each idempotency key with the document it already holds.
    tick();
    const { createXeroInvoiceForBooking } = await import("@/lib/xero-booking-invoices");
    const { createXeroCreditNoteForModification } = await import("@/lib/xero-modification-credit-notes");
    expect(await createXeroInvoiceForBooking(BOOKING_ID)).toBe(invoiceId);
    expect(await createXeroInvoiceForBooking(CARD_ID)).toBe(cardInvoiceId);
    expect(await createXeroCreditNoteForModification({ bookingId: BOOKING_ID, refundAmountCents: REMOVED, bookingModificationId: REMOVAL, format: CLUB_FORMAT_TEST }))
      .toBe(noteId);
    expect(fake.snapshot().creditNotes).toHaveLength(1);
    expect(await manifestState()).toEqual(before);

    // A reissue of the removal's note under another key, as a later export attempt of the same slice would record it.
    const sent = await readBackDocument("CREDIT_NOTE", noteId);
    await doors.recordModificationCreditNoteManifest({
      bookingId: BOOKING_ID, modificationId: REMOVAL, legacyKey: `${REMOVAL}:reissue`, lines: sent.lineItems,
      taxRendering: BASELINE_XERO_TAX_RENDERING, priceLines: null, itemisedShareTaskIds: [], providerCreditNoteId: `${PREFIX}credit-reissue`,
    });
    expect(await readManifest(prisma, "MODIFICATION_CREDIT_NOTE", `${PREFIX}credit-reissue`)).toMatchObject({ outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [] });
    const live = await prisma.memberMoneyExportCoverage.findMany({
      where: { documentRole: "MODIFICATION_CREDIT_NOTE", sliceKey: `modification:${REMOVAL}` },
      select: { manifest: { select: { providerInvoiceId: true } } },
    });
    expect(live).toEqual([{ manifest: { providerInvoiceId: noteId } }]);
    expect(await readManifests(prisma, "MODIFICATION_CREDIT_NOTE", noteId)).toHaveLength(1);
  });
});

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("ALP-753: the manifest round trip puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
    expect(role, "the suite declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(role!.before);
  });
});
