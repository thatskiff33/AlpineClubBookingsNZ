/**
 * Ledger M3c (#4628) against real PostgreSQL: a bank-transfer booking's charge
 * posts once at its binding moment, edits and cancellations before payment
 * re-state it, and the later legacy confirmation (the settle, the Xero receipt)
 * links its lines to that charge without a second one.
 *
 * The switch is the real `POST /api/payments/switch-to-internet-banking` route.
 * The internet-banking create is driven as `createConfirmedBooking` runs its
 * internet-banking arm (lock(1), the lodge key, the PENDING payment and its
 * transaction row, then the binding post), on a booking the shared history
 * support writes, because the full create needs the pricing engine's rate set.
 * Edits go through the real edit chokepoint, cancellations through the real
 * `cancelBooking`, the settle through the real mark-paid, the Xero receipt
 * through the real `syncInternetBankingPaymentsForPaidInvoice`. The judges are
 * the database's own deferred checks at each commit and the census's
 * `JOURNAL` / `JOURNAL_PENDING` comparison.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows and
 * restores the module settings it changes.
 */
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { cleanHistories, createHistoryBooking, historyNames, postHistoryEdit, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4628-";
const names = historyNames(PREFIX);
const JOURNAL = memberMoneyTestContext();
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes. */
const PRICE = 20_000;

let prisma: PrismaClient;
let pendingCharge: typeof import("@/lib/booking-ledger-pending-charge");
let census: typeof import("@/lib/booking-ledger-projection-census-store");
let lodgeLock: typeof import("@/lib/lodge-capacity-lock");
let switchRoute: typeof import("@/app/api/payments/switch-to-internet-banking/route");
let priorModules: { xeroIntegration: boolean; internetBankingPayments: boolean } | null = null;
let sequence = 0;

const nextId = () => `${PREFIX}b${++sequence}`;

/** The journal events a booking's charge posted, oldest first. */
async function events(bookingId: string) {
  return prisma.memberMoneyEvent.findMany({
    where: { sourceKind: "BOOKING", sourceIdentity: bookingId },
    orderBy: [{ recordedAt: "asc" }, { eventKey: "asc" }],
    select: { eventKey: true, kind: true, sourceVersion: true },
  });
}

/** Signed receivable on the booking (Dr positive). */
async function receivable(bookingId: string): Promise<number> {
  const legs = await prisma.memberMoneyLine.findMany({ where: { bookingId, account: "MEMBER_RECEIVABLE" }, select: { side: true, amountCents: true } });
  return legs.reduce((sum, leg) => sum + (leg.side === "DEBIT" ? leg.amountCents : -leg.amountCents), 0);
}

/** The census's journal identity and its unbridged-line findings, from the census's own row read. */
async function judged(bookingId: string) {
  const row = await census.readBookingLedgerCensusRow(prisma, bookingId);
  const evaluation = census.evaluateWithJournal(row!);
  return {
    identity: evaluation.identities.find((identity) => identity.identity === "JOURNAL" || identity.identity === "JOURNAL_PENDING")!,
    unbridged: evaluation.integrity.filter((finding) => finding.kind === "UNBRIDGED_CHARGE_LINE"),
  };
}

async function expectJudged(bookingId: string, identity: "JOURNAL" | "JOURNAL_PENDING", cents: number) {
  const result = await judged(bookingId);
  expect(result.identity, `${bookingId}: ${JSON.stringify(result.identity)}`).toMatchObject({ identity, status: "AGREE", columnCents: cents, ledgerCents: cents });
  expect(result.unbridged).toEqual([]);
}

/**
 * The internet-banking create's arm, as `createConfirmedBooking` runs it: lock(1), the lodge key,
 * the PENDING bank-transfer payment and its transaction row (the real writer), then the binding post.
 */
async function internetBankingCreate(bookingId: string, invoiceId?: string): Promise<void> {
  await createHistoryBooking(prisma, names, bookingId, { payment: null });
  const { recordInternetBankingPaymentTransaction } = await import("@/lib/payment-transactions");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lodgeLock.acquireLodgeCapacityLock(tx, names.lodgeId);
    const payment = await tx.payment.create({
      data: { id: `${bookingId}-payment`, bookingId, amountCents: PRICE, source: "INTERNET_BANKING", status: "PENDING", reference: `REF-${bookingId}`,
        ...(invoiceId ? { xeroInvoiceId: invoiceId, xeroInvoiceNumber: `INV-${bookingId}` } : {}) },
    });
    await recordInternetBankingPaymentTransaction({ paymentId: payment.id, amountCents: PRICE, status: "PENDING", reference: `REF-${bookingId}`, reason: "internet_banking_booking_payment", store: tx });
    await pendingCharge.postBindingCharge(tx, JOURNAL, bookingId, names.lodgeId);
  }, { maxWait: 30_000, timeout: 60_000 });
}

/** The binding post alone, retried as a door's replay would: lock(1) and the lodge key, then the post. */
async function bindAgain(bookingId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lodgeLock.acquireLodgeCapacityLock(tx, names.lodgeId);
    await pendingCharge.postBindingCharge(tx, JOURNAL, bookingId, names.lodgeId);
  });
}

async function switchToInternetBanking(bookingId: string): Promise<number> {
  raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
  try {
    const response = await switchRoute.POST(new NextRequest("http://localhost/api/payments/switch-to-internet-banking", {
      method: "POST", body: JSON.stringify({ bookingId }), headers: { "content-type": "application/json" },
    }));
    return response.status;
  } finally {
    raceSession.current = null;
  }
}

async function markPaid(bookingId: string, expectedAmountCents = PRICE): Promise<void> {
  const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
  await markBookingPaymentManuallySettled({
    bookingId, actingAdminMemberId: names.officerId, note: "bank transfer seen", expectedAmountCents, notifyMember: false, format: CLUB_FORMAT_TEST,
  });
}

/** Every confirmation line is linked to the binding R01's journal, by a source link and a posting naming its receivable leg. */
async function expectLinkedToBinding(bookingId: string, lineCount: number): Promise<void> {
  const r01 = await prisma.memberMoneyEvent.findUniqueOrThrow({
    where: { eventKey: `booking-charge:${bookingId}` },
    select: { journal: { select: { id: true, lines: { where: { account: "MEMBER_RECEIVABLE" }, select: { id: true } } } } },
  });
  const lines = await prisma.bookingLedgerLine.findMany({
    where: { bookingId, side: "CHARGE", amountCents: { not: 0 } },
    select: { id: true, memberMoneySourceLink: { select: { journalId: true, postings: { select: { lineId: true } } } } },
  });
  expect(lines).toHaveLength(lineCount);
  for (const line of lines) {
    expect(line.memberMoneySourceLink?.journalId, line.id).toBe(r01.journal!.id);
    expect(line.memberMoneySourceLink?.postings.map((posting) => posting.lineId)).toEqual([r01.journal!.lines[0]!.id]);
  }
}

(RUN ? describe : describe.skip)("bank-transfer charges post before settlement — real PostgreSQL (#4628)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Booking ledger pending charge");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    pendingCharge = await import("@/lib/booking-ledger-pending-charge");
    census = await import("@/lib/booking-ledger-projection-census-store");
    lodgeLock = await import("@/lib/lodge-capacity-lock");
    switchRoute = await import("@/app/api/payments/switch-to-internet-banking/route");
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await prisma.member.update({ where: { id: names.memberId }, data: { canLogin: true } });
    priorModules = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { xeroIntegration: true, internetBankingPayments: true } });
    await prisma.clubModuleSettings.upsert({
      where: { id: "default" },
      create: { id: "default", xeroIntegration: true, internetBankingPayments: true },
      update: { xeroIntegration: true, internetBankingPayments: true },
      select: { id: true },
    });
  }, 120_000);

  async function cleanup() {
    const ids = (await prisma.booking.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: ids.map((id) => `${id}-payment`) } } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: ids.map((id) => `${id}-payment`) } } });
    await cleanHistories(prisma, PREFIX);
  }

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    // Restore the module settings this suite changed, as it found them.
    if (priorModules) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorModules, select: { id: true } });
    else await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
  }, 120_000);

  it("the real switch posts R01 once, as the confirmation planner prices it; a repeated switch posts nothing", async () => {
    const id = nextId();
    await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source: "STRIPE" } });
    expect(await events(id)).toEqual([]);
    expect(await switchToInternetBanking(id)).toBe(200);
    expect(await switchToInternetBanking(id)).toBe(200);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE", sourceVersion: "binding" }]);
    expect(await receivable(id)).toBe(PRICE);
    expect(await prisma.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: `booking-charge:${id}` }, select: { faceCents: true } }))
      .toEqual({ faceCents: PRICE });
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: id } })).toBe(0);
    await expectJudged(id, "JOURNAL_PENDING", PRICE);
  });

  it("the internet-banking create posts R01 at binding, and a replayed binding posts nothing", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    await bindAgain(id);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE", sourceVersion: "binding" }]);
    expect(await receivable(id)).toBe(PRICE);
    await expectJudged(id, "JOURNAL_PENDING", PRICE);
  });

  it("an edit before payment re-states the pending charge (R02) once, through the real edit chokepoint", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    await postHistoryEdit(prisma, names, id, `${id}-edit`, { removeGuestId: `${id}-g2`, changeFeeCents: 0, journal: JOURNAL });
    const row = await prisma.bookingModification.findUniqueOrThrow({ where: { id: `${id}-edit` } });
    // The door's retry: the same modification posted again is a no-op.
    const { postModificationLedgerLines } = await import("@/lib/booking-ledger-modification-sync");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await postModificationLedgerLines({ store: tx, journal: JOURNAL, bookingId: id, lodgeId: names.lodgeId, bookingModification: row, sides: null, site: "race-4628" });
    });
    expect((await events(id)).map((event) => [event.eventKey, event.kind])).toEqual([[`booking-charge:${id}`, "CHARGE"], [`modification:${id}-edit`, "ADJUSTMENT"]]);
    expect(await receivable(id)).toBe(PRICE / 2);
    expect(await prisma.bookingLedgerLine.count({ where: { bookingId: id } })).toBe(0);
    await expectJudged(id, "JOURNAL_PENDING", PRICE / 2);
  });

  it("a cancel before payment re-states the charge to what the club keeps (R04), once, through the real cancel", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    const { cancelBooking } = await import("@/lib/booking-cancel");
    expect((await cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST)).status).toBe(200);
    expect((await cancelBooking(id, names.officerId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST)).status).not.toBe(200);
    expect((await events(id)).map((event) => [event.eventKey, event.kind])).toEqual([[`booking-charge:${id}`, "CHARGE"], [`cancellation:${id}:0`, "ADJUSTMENT"]]);
    expect(await receivable(id)).toBe(0);
    await expectJudged(id, "JOURNAL_PENDING", 0);
  });

  it("the later settle links its lines to the binding charge, posting no second charge, and replays as nothing", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    await markPaid(id);
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE", sourceVersion: "binding" }]);
    expect(await prisma.memberMoneyEvent.count({ where: { eventKey: { startsWith: "charge-restatement:" }, sourceIdentity: id } })).toBe(0);
    await expectLinkedToBinding(id, 4);
    expect(await receivable(id)).toBe(PRICE);
    await expectJudged(id, "JOURNAL", PRICE);
    // The confirmation's own replay (the settle's fence) posts nothing more.
    const { postStoredBookingConfirmationLedgerLines } = await import("@/lib/booking-ledger-confirmation-sync");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await postStoredBookingConfirmationLedgerLines(tx, id, JOURNAL);
    });
    expect(await events(id)).toHaveLength(1);
  });

  it("an edit before payment, then the settle: the confirmation's lines equal the re-stated charge, so they only link", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    await postHistoryEdit(prisma, names, id, `${id}-edit`, { removeGuestId: `${id}-g2`, changeFeeCents: 0, journal: JOURNAL });
    await markPaid(id, PRICE / 2);
    expect((await events(id)).map((event) => event.eventKey)).toEqual([`booking-charge:${id}`, `modification:${id}-edit`]);
    await expectLinkedToBinding(id, 2);
    expect(await receivable(id)).toBe(PRICE / 2);
    await expectJudged(id, "JOURNAL", PRICE / 2);
  });

  it("a price a writer moved without posting is re-stated once at the confirmation, and the census agrees", async () => {
    const id = nextId();
    await internetBankingCreate(id);
    // A writer outside the posting doors re-prices a night before payment.
    await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: `${id}-g1`, stayDate: new Date("2027-08-01T00:00:00.000Z") }, data: { priceCents: 6_000 } });
    await prisma.booking.update({ where: { id }, data: { totalPriceCents: PRICE + 1_000, finalPriceCents: PRICE + 1_000 } });
    expect((await judged(id)).identity).toMatchObject({ identity: "JOURNAL_PENDING", status: "DISAGREE", deltaCents: -1_000 });
    await markPaid(id, PRICE + 1_000);
    expect((await events(id)).map((event) => [event.eventKey, event.kind])).toEqual([[`booking-charge:${id}`, "CHARGE"], [`charge-restatement:${id}`, "ADJUSTMENT"]]);
    await expectLinkedToBinding(id, 4);
    expect(await receivable(id)).toBe(PRICE + 1_000);
    await expectJudged(id, "JOURNAL", PRICE + 1_000);
  });

  it("the Xero receipt confirms the booking, links its lines to the binding charge, and replays as nothing", async () => {
    const id = nextId();
    const invoiceId = `${id}-invoice`;
    await internetBankingCreate(id, invoiceId);
    await prisma.paymentTransaction.updateMany({ where: { paymentId: `${id}-payment` }, data: { xeroInvoiceId: invoiceId, xeroInvoiceNumber: `INV-${id}` } });
    await prisma.xeroObjectLink.create({
      data: { localModel: "Payment", localId: `${id}-payment`, xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "PRIMARY_INVOICE", active: true },
    });
    const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
    const invoice = { invoiceID: invoiceId, invoiceNumber: `INV-${id}`, status: "PAID", amountPaid: PRICE / 100, payments: [{ paymentID: `${id}-xpay`, amount: PRICE / 100, status: "AUTHORISED" }] };
    const paid = invoice as unknown as Parameters<typeof syncInternetBankingPaymentsForPaidInvoice>[0];
    await syncInternetBankingPaymentsForPaidInvoice(paid, [`${id}-payment`], CLUB_FORMAT_TEST);
    await syncInternetBankingPaymentsForPaidInvoice(paid, [`${id}-payment`], CLUB_FORMAT_TEST);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).toEqual({ status: "PAID" });
    expect(await events(id)).toEqual([{ eventKey: `booking-charge:${id}`, kind: "CHARGE", sourceVersion: "binding" }]);
    await expectLinkedToBinding(id, 4);
    expect(await receivable(id)).toBe(PRICE);
    await expectJudged(id, "JOURNAL", PRICE);
  });

  it("a booking never bound posts nothing before settlement: a card booking's edit is not a sale", async () => {
    const id = nextId();
    await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source: "STRIPE" } });
    await postHistoryEdit(prisma, names, id, `${id}-edit`, { removeGuestId: `${id}-g2`, changeFeeCents: 0, journal: JOURNAL });
    expect(await events(id)).toEqual([]);
    expect((await judged(id)).identity).toMatchObject({ identity: "JOURNAL", status: "NOT_APPLICABLE" });
  });
});
