/**
 * #4069 (`INV-PAY-159`): the one cash-cover answer (`readBookingCashCover`)
 * over rows the REAL writers leave, against real PostgreSQL. The branch-by-branch
 * pure cases are `booking-cash-evidence.test.ts`; this file proves the reader
 * composes with what production actually writes (`docs/design/paid-from-cash.md`
 * §2):
 *
 * - what the cash proves: an unpaid card booking, the Internet Banking
 *   bed-holding switch (CONFIRMED, its PENDING face amount never counted), a
 *   captured card payment, paid then reduced then partly refunded by card, a
 *   zero-priced booking, a credit-only booking, and a paid primary beside an
 *   unpaid addition;
 * - organiser groups: the organiser has not paid, the real settle, a child
 *   refund out of the combined settlement, a share the frozen settlement cannot
 *   prove, and a dispute on the combined settlement intent; then two
 *   invalid-history inputs written directly onto a really settled child
 *   (refunds above its share, a backfilled row), which stay unknown;
 * - refunds counted once: an open card refund debt, the same refund recorded
 *   before and after its row closes, one Stripe accepted and failed later, an
 *   open bank hand-back and its completion;
 * - a superseded capture through the real hand-off, paused between its capture
 *   commit and its refund enqueue, then refunded, then failed later: the
 *   booking owes the same 25,000 cents in every state;
 * - legacy history, written by the real backfill;
 * - snapshot coherence: a capture, a refund, a credit application and a group
 *   settlement each land from outside an open `withReadOnlySnapshot`, which
 *   still answers as before; a fresh snapshot sees the write.
 *
 * Every answer is read through `withReadOnlySnapshot`, as a caller must. Only the
 * inert fixture rows (member, lodge, booking, guests, a pre-ledger payment's
 * columns) are seeded directly; each case says where a precondition stands in
 * for an upstream writer. Stripe is the harness's one shared double, so no
 * provider is called; no email transport opens on a non-production role.
 *
 * Ordinary Vitest runs skip the whole file. CI's real-PostgreSQL job runs it
 * against the guarded loopback race database; it owns and cleans its own
 * `race-4069-` fixtures, including the recovery operations and Xero rows its
 * writers queue.
 */
import type Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import type { BookingCashCover } from "@/lib/booking-cash-evidence";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  createGroupHistory,
  GROUP_CHILD_CENTS,
  GROUP_NIGHT_CENTS,
  groupHistory,
  groupHistoryStripe,
  reserveGroupChildReduction,
  runGroupChildRefund,
  settleGroupHistory,
} from "./support/booking-ledger-group-history";
import {
  cleanHistories,
  createHistoryBooking,
  historyNames,
  postHistoryEdit,
  seedHistoryFixtures,
  settleHistoryByCard,
} from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-4069-";
const names = historyNames(PREFIX);
/** Two guests, two nights each, at 50.00: what `createHistoryBooking` makes by default. */
const PRICE = 20_000;
/** The superseded-capture fixture (§2.7): worth 50,000, one ordinary and one superseded 25,000 capture. */
const HALF = 25_000;
/** The history support's nights. */
const D2 = new Date("2027-08-02T00:00:00.000Z");
/** The group history support's second night. */
const GROUP_D2 = new Date("2027-10-02T00:00:00.000Z");
const SEASON = `${PREFIX}season`;
/** When Stripe says each provider object was created: the frozen day, in seconds. */
const STRIPE_CREATED = Math.floor(Date.parse("2026-07-01T00:00:00.000Z") / 1000);
const DISPUTE_PREFIX = "dp_race_4069";

const id = (key: string) => `${PREFIX}${key}`;
const paymentOf = (bookingId: string) => `${bookingId}-payment`;
const intentOf = (bookingId: string) => `pi_${bookingId}`;
/** Two guests, two nights each, every night at `cents`. */
const nightsAt = (cents: number) =>
  Array.from({ length: 2 }, () => [
    { priceCents: cents, priceSource: "SOLD" as const },
    { priceCents: cents, priceSource: "SOLD" as const },
  ]) as Array<[{ priceCents: number; priceSource: "SOLD" }, { priceCents: number; priceSource: "SOLD" }]>;

const OWES = (cents: number): BookingCashCover => ({ kind: "owes", cents });
const COVERED: BookingCashCover = { kind: "covered" };
const ORGANISER_PAYS: BookingCashCover = { kind: "organiser_pays" };

let prisma: PrismaClient;
let snapshot: typeof import("@/lib/read-only-snapshot");
let reader: typeof import("@/lib/booking-cash-evidence");
let recovery: typeof import("@/lib/payment-recovery");
let ledger: typeof import("@/lib/payment-transactions");
let recoveryAlert: typeof import("@/lib/payment-recovery-alert");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let priorModules: { xeroIntegration: boolean; internetBankingPayments: boolean } | null | undefined;
let priorBankSettings: { holdBedSlots: boolean } | null | undefined;

/** THE answer, read as a caller must: one read-only snapshot. */
async function cover(bookingId: string): Promise<BookingCashCover | null> {
  return snapshot.withReadOnlySnapshot(prisma, (tx) => reader.readBookingCashCover(tx, bookingId));
}

/**
 * Open a snapshot, read once in it (which fixes the snapshot), land `write`
 * from OUTSIDE through the plain client, then ask the reader inside the still
 * open snapshot. Returns what the open snapshot answered.
 */
async function coverAcross(bookingId: string, write: () => Promise<unknown>): Promise<BookingCashCover | null> {
  return snapshot.withReadOnlySnapshot(
    prisma,
    async (tx) => {
      expect(await tx.booking.findUnique({ where: { id: bookingId }, select: { id: true } })).toEqual({ id: bookingId });
      await write();
      return reader.readBookingCashCover(tx, bookingId);
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
}

/** A Stripe refund as the shared double's hook answers it, and as Stripe would list it. */
function stripeRefund(args: { paymentIntentId: string; amountCents: number; metadata?: Record<string, string> }, refundId: string, status = "succeeded") {
  return {
    id: refundId,
    object: "refund",
    amount: args.amountCents,
    currency: "nzd",
    status,
    reason: "requested_by_customer",
    created: STRIPE_CREATED,
    charge: `ch_${args.paymentIntentId}`,
    payment_intent: args.paymentIntentId,
    metadata: args.metadata ?? {},
  } as unknown as Stripe.Refund;
}

/** Every refund the double made, in order: Stripe succeeds each one. */
let made: Stripe.Refund[] = [];
function stripeMakesRefunds(): void {
  stripeRaceHooks.refund = async (args) => {
    // Made now, on the frozen clock as the fixtures' ticks have moved it: a refund
    // Stripe dates before the row that asked for it is never netted against that row.
    const refund = { ...stripeRefund(args, `re_race_4069_${made.length + 1}`), created: Math.floor(Date.now() / 1000) } as Stripe.Refund;
    made.push(refund);
    return refund;
  };
}

/** The booking's primary capture, as the real settle wrote it. */
async function primaryCapture(bookingId: string) {
  return prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId: paymentOf(bookingId), kind: "PRIMARY" }, select: { id: true, stripePaymentIntentId: true } });
}

/**
 * A card booking at `nightCents` a night, asked for by the pay step: the
 * booking and its PENDING payment (fixture rows), then the pay step's own ledger
 * write for the intent it minted. Without that row the payment is pre-ledger
 * shaped and the settle's rebuild backfills a legacy row, which the reader
 * rightly reads as unknown.
 */
async function cardAsk(bookingId: string, nightCents = 5_000): Promise<number> {
  const worth = nightCents * 4;
  await createHistoryBooking(prisma, names, bookingId, {
    payment: { amountCents: worth, source: "STRIPE", intent: intentOf(bookingId) },
    guests: nightsAt(nightCents),
  });
  await ledger.upsertPaymentIntentTransaction({ paymentId: paymentOf(bookingId), kind: "PRIMARY", paymentIntentId: intentOf(bookingId), amountCents: worth, status: "PENDING" });
  return worth;
}

/** That booking captured in full by the real settle (the card webhook's door). */
async function paidCardBooking(bookingId: string, nightCents = 5_000): Promise<number> {
  const worth = await cardAsk(bookingId, nightCents);
  await settleHistoryByCard(bookingId, worth);
  return worth;
}

/**
 * Pause the real runner where it closes `operationId` (its status-guarded
 * SUCCEEDED write on the plain client), run `probe`, then let the close go.
 */
function pauseAtClose(operationId: string, probe: () => Promise<void>): MockInstance {
  const delegate = prisma.paymentRecoveryOperation;
  const updateMany = delegate.updateMany.bind(delegate);
  return vi.spyOn(delegate, "updateMany").mockImplementation((async (args: Parameters<typeof updateMany>[0]) => {
    const where = args.where as { id?: unknown } | undefined;
    const data = args.data as { status?: unknown };
    if (where?.id === operationId && data.status === "SUCCEEDED") await probe();
    return updateMany(args);
  }) as unknown as typeof updateMany);
}

(RUN ? describe : describe.skip)("the cash-cover reader over real writers — real PostgreSQL (#4069)", { timeout: 180_000 }, () => {
  let alertSpy: MockInstance;

  async function seedPricing() {
    await prisma.lodgeSettings.create({ data: { id: names.lodgeId, lodgeId: names.lodgeId, capacity: 10 } });
    const fullMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "FULL" } });
    await prisma.seasonalMembershipAssignment.create({ data: { memberId: names.memberId, seasonYear: 2027, membershipTypeId: fullMember.id } });
    await prisma.memberSubscription.create({ data: { memberId: names.memberId, seasonYear: 2027, status: "PAID", paidAt: new Date("2026-06-01T00:00:00.000Z") } });
    await prisma.season.create({
      data: {
        id: SEASON, name: "Race 4069 season", lodgeId: names.lodgeId, type: "WINTER", active: true,
        startDate: new Date("2027-06-01T00:00:00.000Z"), endDate: new Date("2027-10-31T00:00:00.000Z"),
        membershipTypeRates: { create: [
          { membershipTypeId: fullMember.id, ageTier: "ADULT", pricePerNightCents: 5_000 },
          { membershipTypeId: fullMember.id, ageTier: null, pricePerNightCents: 5_000 },
        ] },
      },
    });
  }

  /** Everything under the prefix, and every row its writers queued or raised beside it. */
  async function cleanup() {
    const bookings = await prisma.booking.findMany({ where: { OR: [{ id: { startsWith: PREFIX } }, { lodgeId: names.lodgeId }] }, select: { id: true } });
    const bookingIds = bookings.map((row) => row.id);
    const payments = await prisma.payment.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } });
    const credits = await prisma.memberCredit.findMany({ where: { memberId: { in: [names.memberId, names.officerId] } }, select: { id: true } });
    const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } });
    const modifications = await prisma.bookingModification.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } });
    const operations = await prisma.paymentRecoveryOperation.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } });
    const owned = [
      ...bookingIds,
      ...payments.map((row) => row.id),
      ...credits.map((row) => row.id),
      ...tasks.map((row) => row.id),
      ...modifications.map((row) => row.id),
      ...operations.map((row) => row.id),
    ];
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: owned } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: owned } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: owned } }, { entityId: { in: owned } }] } });
    await prisma.emailLog.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.stripeDispute.deleteMany({ where: { stripeDisputeId: { startsWith: DISPUTE_PREFIX } } });
    await prisma.alertCooldown.deleteMany({
      where: { OR: [{ key: { contains: DISPUTE_PREFIX } }, ...owned.map((ownedId) => ({ key: { contains: ownedId } }))] },
    });
    await prisma.payment.updateMany({ where: { id: { in: payments.map((row) => row.id) } }, data: { settledByTransactionId: null } });
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON } });
    await prisma.season.deleteMany({ where: { id: SEASON } });
    await prisma.lodgeSettings.deleteMany({ where: { lodgeId: names.lodgeId } });
    await prisma.seasonalMembershipAssignment.deleteMany({ where: { memberId: names.memberId } });
    await prisma.memberSubscription.deleteMany({ where: { memberId: names.memberId } });
    await cleanHistories(prisma, PREFIX);
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "#4069 cash cover");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
    harnessRole = declareEnvironmentRoleForSuite("non-production");
    snapshot = await import("@/lib/read-only-snapshot");
    reader = await import("@/lib/booking-cash-evidence");
    recovery = await import("@/lib/payment-recovery");
    ledger = await import("@/lib/payment-transactions");
    recoveryAlert = await import("@/lib/payment-recovery-alert");

    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await prisma.member.update({ where: { id: names.memberId }, data: { canLogin: true } });
    await seedPricing();
    priorModules = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { xeroIntegration: true, internetBankingPayments: true } });
    await prisma.clubModuleSettings.upsert({
      where: { id: "default" },
      create: { id: "default", xeroIntegration: true, internetBankingPayments: true },
      update: { xeroIntegration: true, internetBankingPayments: true },
      select: { id: true },
    });
    priorBankSettings = await prisma.internetBankingPaymentSettings.findUnique({ where: { id: "default" }, select: { holdBedSlots: true } });
    await prisma.internetBankingPaymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", holdBedSlots: true },
      update: { holdBedSlots: true },
      select: { id: true },
    });
  }, 180_000);

  beforeEach(() => {
    resetStripeRaceHooks();
    made = [];
    alertSpy = vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    resetStripeRaceHooks();
  });

  afterAll(async () => {
    try {
      resetStripeRaceHooks();
      if (!prisma) return;
      await cleanup();
      // Put back the settings this suite changed, as it found them.
      if (priorModules) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: priorModules, select: { id: true } });
      else if (priorModules === null) await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
      if (priorBankSettings) await prisma.internetBankingPaymentSettings.update({ where: { id: "default" }, data: priorBankSettings, select: { id: true } });
      else if (priorBankSettings === null) await prisma.internetBankingPaymentSettings.deleteMany({ where: { id: "default" } });
    } finally {
      harnessRole?.restore();
    }
  }, 180_000);

  describe("what the cash proves", () => {
    it("an unpaid card booking owes its whole worth; the pending intent's face amount is not cash", async () => {
      const bookingId = id("card-unpaid");
      await cardAsk(bookingId);

      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } })).toEqual({ status: "PAYMENT_PENDING" });
      expect(await cover(bookingId)).toEqual(OWES(PRICE));
    });

    it("the Internet Banking bed-holding switch leaves the booking CONFIRMED and owing all of it: the PENDING bank face amount never counts", async () => {
      const bookingId = id("bank-switch");
      await createHistoryBooking(prisma, names, bookingId, { payment: { amountCents: PRICE, source: "STRIPE" } });
      raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
      try {
        const { POST } = await import("@/app/api/payments/switch-to-internet-banking/route");
        const response = await POST(new NextRequest("http://localhost/api/payments/switch-to-internet-banking", {
          method: "POST", body: JSON.stringify({ bookingId }), headers: { "content-type": "application/json" },
        }));
        expect(response.status, JSON.stringify(await response.clone().json().catch(() => null))).toBe(200);
      } finally {
        raceSession.current = null;
      }

      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, payment: { select: { source: true, status: true, amountCents: true } } } });
      expect(booking).toEqual({ status: "CONFIRMED", payment: { source: "INTERNET_BANKING", status: "PENDING", amountCents: PRICE } });
      expect(await cover(bookingId)).toEqual(OWES(PRICE));
    });

    it("a captured card payment covers the booking", async () => {
      const bookingId = id("card-paid");
      await paidCardBooking(bookingId);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } })).toEqual({ status: "PAID" });
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("paid, then reduced, then partly refunded by card (PAID, PARTIALLY_REFUNDED) is covered at the lower price", async () => {
      const bookingId = id("card-reduced");
      await paidCardBooking(bookingId);
      await postHistoryEdit(prisma, names, bookingId, `${bookingId}-removal`, { removeGuestId: `${bookingId}-g2`, changeFeeCents: 0 });
      const capture = await primaryCapture(bookingId);
      await ledger.recordStripeRefundsAgainstTransaction({
        paymentId: paymentOf(bookingId),
        paymentTransactionId: capture.id,
        refunds: [stripeRefund({ paymentIntentId: intentOf(bookingId), amountCents: PRICE / 2, metadata: { bookingId, reason: "date_change_price_decrease" } }, `re_${bookingId}`)],
        store: prisma,
      });

      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, finalPriceCents: true, payment: { select: { status: true, refundedAmountCents: true } } } });
      expect(booking).toEqual({ status: "PAID", finalPriceCents: PRICE / 2, payment: { status: "PARTIALLY_REFUNDED", refundedAmountCents: PRICE / 2 } });
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("a zero-priced booking confirmed through the real draft confirm is covered", async () => {
      const bookingId = id("zero");
      await createHistoryBooking(prisma, names, bookingId, { payment: null });
      // A saved draft whose promotion takes its priced nights to $0 (#4738's shape).
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: "DRAFT", draftExpiresAt: new Date("2026-07-08T00:00:00.000Z"), promoAdjustmentCents: -PRICE, discountCents: PRICE,
          finalPriceCents: 0, capacityOverriddenAt: null, capacityOverriddenByMemberId: null,
        },
      });
      raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
      try {
        const { POST } = await import("@/app/api/bookings/[id]/confirm-draft/route");
        const response = await POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/confirm-draft`, { method: "POST" }), { params: Promise.resolve({ id: bookingId }) });
        expect(response.status).toBe(200);
      } finally {
        raceSession.current = null;
      }
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true, finalPriceCents: true } })).toEqual({ status: "PAID", finalPriceCents: 0 });
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("a booking its stored credit election covers, settled by the real pay step, is covered by credit alone", async () => {
      const bookingId = id("credit-only");
      await createHistoryBooking(prisma, names, bookingId, { payment: null });
      await prisma.booking.update({ where: { id: bookingId }, data: { creditElectionCents: PRICE } });
      await prisma.memberCredit.create({ data: { memberId: names.memberId, amountCents: PRICE, type: "ADMIN_ADJUSTMENT", description: "#4069 proof" } });
      expect(await cover(bookingId)).toEqual(OWES(PRICE));

      raceSession.current = { user: { id: names.memberId, role: "MEMBER", accessRoles: [], canLogin: true } };
      try {
        const { POST } = await import("@/app/api/payments/create-payment-intent/route");
        const response = await POST(new NextRequest("http://localhost/api/payments/create-payment-intent", {
          method: "POST", body: JSON.stringify({ bookingId }), headers: { "content-type": "application/json" },
        }));
        expect(response.status).toBe(200);
      } finally {
        raceSession.current = null;
      }
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } })).toEqual({ status: "PAID" });
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("a paid primary beside a pending, unpaid addition owes exactly the addition", async () => {
      const bookingId = id("addition");
      await paidCardBooking(bookingId);
      // An edit raises a night by 50.00, and its ask is minted: the ADDITIONAL row the mint writes, PENDING.
      await postHistoryEdit(prisma, names, bookingId, `${bookingId}-rise`, { reprice: { guestId: `${bookingId}-g1`, stayDate: D2, priceCents: 10_000 }, changeFeeCents: 0 });
      await ledger.upsertPaymentIntentTransaction({
        paymentId: paymentOf(bookingId), kind: "ADDITIONAL", paymentIntentId: `${intentOf(bookingId)}_addition`, amountCents: 5_000,
        carriedAskCents: 0, status: "PENDING", bookingModificationId: `${bookingId}-rise`,
      });

      expect(await prisma.paymentTransaction.count({ where: { paymentId: paymentOf(bookingId), kind: "ADDITIONAL", status: "PENDING", amountCents: 5_000 } })).toBe(1);
      expect(await cover(bookingId)).toEqual(OWES(5_000));
    });

    it("legacy history written by the real backfill is unknown, never a guess", async () => {
      const bookingId = id("legacy");
      // A pre-ledger payment: its columns say SUCCEEDED and no transaction row exists (what code before the ledger left).
      await createHistoryBooking(prisma, names, bookingId, { payment: null });
      await prisma.booking.update({ where: { id: bookingId }, data: { status: "PAID" } });
      await prisma.payment.create({
        data: { id: paymentOf(bookingId), bookingId, amountCents: PRICE, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: intentOf(bookingId) },
      });
      await ledger.ensurePaymentTransactionsBackfilled(prisma, paymentOf(bookingId));

      const { LEGACY_BACKFILL_REASONS } = await import("@/lib/payment-transaction-status");
      const rows = await prisma.paymentTransaction.findMany({ where: { paymentId: paymentOf(bookingId) }, select: { reason: true } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.reason !== null && LEGACY_BACKFILL_REASONS.includes(row.reason))).toBe(true);
      expect(await cover(bookingId)).toEqual({ kind: "unknown", reason: "legacy-history" });
    });
  });

  describe("organiser groups", () => {
    const G = groupHistory(PREFIX, "group", "STRIPE", 2);
    const [child1, child2] = G.children as [string, string];
    const stripe = groupHistoryStripe();

    it("before the organiser pays, each child is the organiser's to pay", async () => {
      await createGroupHistory(prisma, names, G);
      expect(await cover(child1)).toEqual(ORGANISER_PAYS);
      expect(await cover(child2)).toEqual(ORGANISER_PAYS);
    });

    it("after the real card settle, a share the frozen settlement proves covers each child", async () => {
      await settleGroupHistory(G);
      expect(await cover(child1)).toEqual(COVERED);
      expect(await cover(child2)).toEqual(COVERED);
    });

    it("a zero-priced child stays covered after the whole combined settlement is refunded", async () => {
      const g = groupHistory(PREFIX, "group-full-refund", "STRIPE", 1);
      const childId = g.children[0]!;
      await createGroupHistory(prisma, names, g);
      await settleGroupHistory(g);
      // Reprice the first night through the real edit writer; the existing
      // refund helper reprices the second and reserves the full share back.
      await postHistoryEdit(prisma, names, childId, `${childId}-first-night`, {
        reprice: { guestId: `${childId}-g1`, stayDate: new Date("2027-10-01T00:00:00.000Z"), priceCents: 0 },
        changeFeeCents: 0,
      });
      const debt = await reserveGroupChildReduction(prisma, names, g, childId, GROUP_NIGHT_CENTS);
      // The first edit also reduced worth; reserve the remaining obligation
      // through the same production reservation writer.
      const { reserveOrganiserChildModificationRefund } = await import("@/lib/organiser-child-refund");
      const firstDebt = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: childId } });
        return reserveOrganiserChildModificationRefund(tx, {
          plan: { settlement: { id: g.settlement, stripePaymentIntentId: g.pi!, amountCents: GROUP_CHILD_CENTS }, amountCents: GROUP_NIGHT_CENTS },
          bookingId: childId, payment, bookingModificationId: `${childId}-first-night`,
        });
      });
      await runGroupChildRefund(prisma, debt.id, stripe);
      await runGroupChildRefund(prisma, firstDebt!.id, stripe);
      expect(await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement }, select: { status: true } })).toEqual({ status: "REFUNDED" });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: childId }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: 0 });
      expect(await cover(childId)).toEqual(COVERED);
    });

    it("a child refund attributed out of the combined settlement is still covered at the lower price", async () => {
      const debt = await reserveGroupChildReduction(prisma, names, G, child1, 1_500);
      await runGroupChildRefund(prisma, debt.id, stripe);
      expect(await prisma.payment.findUniqueOrThrow({ where: { bookingId: child1 }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: 1_500 });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: child1 }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: GROUP_CHILD_CENTS - 1_500 });
      expect(await cover(child1)).toEqual(COVERED);
    });

    it("a card child's rise after the settle is a share the frozen settlement cannot prove", async () => {
      await postHistoryEdit(prisma, names, child2, `${child2}-rise`, {
        reprice: { guestId: `${child2}-g1`, stayDate: GROUP_D2, priceCents: GROUP_NIGHT_CENTS + 1_000 },
        changeFeeCents: 0,
      });
      expect(await cover(child2)).toEqual({ kind: "unknown", reason: "organiser-share-unproven" });
    });

    it("an open dispute on the combined settlement intent, recorded by the real dispute writer, leaves a covered child unknown: disputed", async () => {
      expect(await cover(child1)).toEqual(COVERED);
      const { recordStripeDispute, StripeDisputeAlertNotSentError } = await import("@/lib/stripe-dispute");
      const dispute = {
        id: `${DISPUTE_PREFIX}_group`, object: "dispute", amount: GROUP_CHILD_CENTS * 2, currency: "nzd", charge: `ch_${G.pi}`,
        payment_intent: G.pi, reason: "fraudulent", status: "needs_response", created: STRIPE_CREATED, balance_transactions: [], livemode: false,
      } as unknown as Stripe.Dispute;
      const event = { id: "evt_race_4069_dispute", object: "event", type: "charge.dispute.created", created: STRIPE_CREATED, livemode: false, data: { object: dispute } } as unknown as Stripe.Event;
      // The row is written before the officers' alert; with no mail transport the alert may refuse, which is not this case's question.
      await recordStripeDispute(dispute, event, CLUB_FORMAT_TEST).catch((err: unknown) => {
        if (!(err instanceof StripeDisputeAlertNotSentError)) throw err;
      });
      expect(await prisma.stripeDispute.findUniqueOrThrow({ where: { stripeDisputeId: dispute.id }, select: { status: true, stripePaymentIntentId: true, bookingId: true } }))
        .toEqual({ status: "OPEN", stripePaymentIntentId: G.pi, bookingId: G.organiser });

      expect(await cover(child1)).toEqual({ kind: "unknown", reason: "disputed" });
    });
  });

  // INVALID-HISTORY INPUTS. The group is settled by the real settle, then the
  // child's mirror is written to directly, to a state no current writer leaves.
  // The reader must refuse it all the same: shares that add up prove the share,
  // not the child's refunds or its rows.
  describe("organiser groups: a proved share with history it cannot carry (invalid-history inputs)", () => {
    const G = groupHistory(PREFIX, "group-unproven", "STRIPE", 2);
    const [child1, child2] = G.children as [string, string];

    it("the real settle's own child, no rows of its own, is covered", async () => {
      await createGroupHistory(prisma, names, G);
      await settleGroupHistory(G);
      expect(await prisma.paymentTransaction.count({ where: { payment: { bookingId: { in: [child1, child2] } } } })).toBe(0);
      expect(await cover(child1)).toEqual(COVERED);
      expect(await cover(child2)).toEqual(COVERED);
    });

    it("refunds above the child's share are unknown, even on a booking worth nothing", async () => {
      // Direct write: no writer refunds a child more than the settlement paid for it.
      await prisma.payment.update({ where: { bookingId: child1 }, data: { refundedAmountCents: GROUP_CHILD_CENTS + 1_500 } });
      await prisma.booking.update({ where: { id: child1 }, data: { finalPriceCents: 0 } });
      expect(await cover(child1)).toEqual({ kind: "unknown", reason: "refunds-unproven" });
      // The sibling's share still adds up, and its own history is clean.
      expect(await cover(child2)).toEqual(COVERED);
    });

    it("a backfilled row on the child is unknown, whatever the share proves", async () => {
      // Direct write: the settle writes a child's mirror with no rows, so nothing backfills one.
      const { LEGACY_PRIMARY_BACKFILL_REASON } = await import("@/lib/payment-transaction-status");
      const mirror = await prisma.payment.findUniqueOrThrow({ where: { bookingId: child2 }, select: { id: true } });
      await prisma.paymentTransaction.create({
        data: { paymentId: mirror.id, kind: "PRIMARY", source: "STRIPE", status: "SUCCEEDED", amountCents: GROUP_CHILD_CENTS, reason: LEGACY_PRIMARY_BACKFILL_REASON },
      });
      expect(await cover(child2)).toEqual({ kind: "unknown", reason: "legacy-history" });
    });
  });

  describe("a refund comes off exactly once", () => {
    const bookingId = id("refund-once");
    let debtId = "";

    it("an open card refund debt is money gone: the booking re-raised to its old worth owes the refund", async () => {
      const worth = await paidCardBooking(bookingId, 12_500);
      expect(worth).toBe(2 * HALF);
      expect(await cover(bookingId)).toEqual(COVERED);

      // An edit removes a guest (25,000 off) and reserves its card refund (the door's own reservation).
      const cut = `${bookingId}-cut`;
      await postHistoryEdit(prisma, names, bookingId, cut, { removeGuestId: `${bookingId}-g2`, changeFeeCents: 0 });
      const { reserveModificationRefundDebts } = await import("@/lib/booking-modification-settlement");
      const ownCardRefund = await prisma.$transaction((tx) => reserveModificationRefundDebts(tx, {
        door: "dateChange", plan: null, bookingId, bookingModificationId: cut, pendingRefundAmountCents: HALF,
        // Only its id is read for an own-card refund.
        payment: { id: paymentOf(bookingId) } as never,
      }));
      expect(ownCardRefund).not.toBeNull();
      const debt = await prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { bookingId, type: "REFUND_BOOKING_MODIFICATION" }, select: { id: true, status: true, amountCents: true } });
      expect(debt).toMatchObject({ status: "PENDING", amountCents: HALF });
      debtId = debt.id;
      expect(await cover(bookingId)).toEqual(COVERED);

      // A later edit puts 25,000 back on a night: the refund still owed is not cover.
      await postHistoryEdit(prisma, names, bookingId, `${bookingId}-back`, { reprice: { guestId: `${bookingId}-g1`, stayDate: D2, priceCents: 12_500 + HALF }, changeFeeCents: 0 });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: 2 * HALF });
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });

    it("the same 25,000 refund, recorded before its row closes and after, comes off once in each state", async () => {
      stripeMakesRefunds();
      const seen: Array<{ cover: BookingCashCover | null; status: string; recorded: number }> = [];
      const probe = async () => {
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debtId }, select: { status: true } });
        const recorded = await prisma.paymentRefund.aggregate({ where: { paymentId: paymentOf(bookingId) }, _sum: { amountCents: true } });
        seen.push({ cover: await cover(bookingId), status: row.status, recorded: recorded._sum.amountCents ?? 0 });
      };
      const close = pauseAtClose(debtId, probe);
      try {
        expect(await recovery.runPaymentRecoveryOperationNow(debtId, CLUB_FORMAT_TEST)).toBe("succeeded");
      } finally {
        close.mockRestore();
      }

      expect(made.map((refund) => refund.amount)).toEqual([HALF]);
      // Recorded, its row still PROCESSING: once.
      expect(seen).toEqual([{ cover: OWES(HALF), status: "PROCESSING", recorded: HALF }]);
      // Recorded and closed: once.
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: debtId }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });

    it("a refund Stripe accepted and failed later stays gone: owed by its own row, counted once", async () => {
      const failedId = id("failed-later");
      await paidCardBooking(failedId);
      const capture = await primaryCapture(failedId);
      const refund = stripeRefund({ paymentIntentId: intentOf(failedId), amountCents: 5_000, metadata: { bookingId: failedId, reason: "date_change_price_decrease" } }, `re_${failedId}`, "pending");
      // The door's own write of the refund Stripe answered `pending`.
      await ledger.recordStripeRefundsAgainstTransaction({ paymentId: paymentOf(failedId), paymentTransactionId: capture.id, refunds: [refund], fallbackPaymentIntentId: intentOf(failedId) });
      expect(await cover(failedId)).toEqual(OWES(5_000));

      // Stripe fails it days later (the refund webhook's recorder).
      const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
      expect(await recordRefusedCardRefund({ ...refund, status: "failed" } as Stripe.Refund)).toBe("recorded");
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentOf(failedId) }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: 0 });
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: failedId, idempotencyKey: { startsWith: "card_refund_failed_later_" } } })).toBe(1);
      expect(await cover(failedId)).toEqual(OWES(5_000));
    });

    it("an open bank hand-back is not cover; once completed it is counted once, through the recorded refund", async () => {
      const bankId = id("bank-hand-back");
      const invoiceId = `${bankId}-invoice`;
      await createHistoryBooking(prisma, names, bankId, { payment: { amountCents: PRICE, source: "INTERNET_BANKING", xeroInvoiceId: invoiceId } });
      // Paid by bank transfer, read from Xero's cash by the real inbound reconcile.
      const { syncInternetBankingPaymentsForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
      await syncInternetBankingPaymentsForPaidInvoice(
        { invoiceID: invoiceId, invoiceNumber: `INV-${bankId}`, status: "PAID", amountPaid: PRICE / 100, payments: [{ paymentID: `${bankId}-xpay`, amount: PRICE / 100 }] } as never,
        [paymentOf(bankId)],
        CLUB_FORMAT_TEST,
      );
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bankId }, select: { status: true } })).toEqual({ status: "PAID" });
      expect(await cover(bankId)).toEqual(COVERED);

      // An edit takes 10,000 off; paid by bank transfer, its refund is promised back by hand (the real raiser).
      const cut = `${bankId}-cut`;
      await postHistoryEdit(prisma, names, bankId, cut, { removeGuestId: `${bankId}-g2`, changeFeeCents: 0 });
      const { raiseEditRefundHandBackIfOwed } = await import("@/lib/edit-refund-hand-back");
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const booking = await tx.booking.findUniqueOrThrow({ where: { id: bankId }, include: { payment: true } });
        expect(await raiseEditRefundHandBackIfOwed(tx, {
          bookingId: bankId, paymentId: paymentOf(bankId), bookingModificationId: cut,
          adjusted: { refundAmountCents: PRICE / 2, hasSucceededPayment: false, refundHeldForDispute: false },
          editLabel: "guest removal", booking,
        })).toBe(true);
      });
      expect(await cover(bankId)).toEqual(COVERED);
      // A later edit puts the 10,000 back: the hand-back still open is money promised away.
      await postHistoryEdit(prisma, names, bankId, `${bankId}-back`, { reprice: { guestId: `${bankId}-g1`, stayDate: D2, priceCents: 5_000 + PRICE / 2 }, changeFeeCents: 0 });
      expect(await cover(bankId)).toEqual(OWES(PRICE / 2));

      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: bankId, status: "OPEN" }, select: { id: true } });
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        { taskId: task.id, resolution: "completed", note: null, actingMemberId: names.officerId, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentOf(bankId) }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: PRICE / 2 });
      expect(await cover(bankId)).toEqual(OWES(PRICE / 2));
    });
  });

  describe("a superseded capture awaiting its refund is never cover (§2.7)", () => {
    const bookingId = id("superseded");
    const SUPERSEDED_INTENT = `pi_race_4069_superseded`;
    let supersededTxn = "";
    let refundRowId = "";
    /** The superseded refund Stripe made, which it later fails. */
    let supersededRefund: Stripe.Refund | undefined;

    async function operations() {
      return prisma.paymentRecoveryOperation.findMany({
        where: { bookingId, type: { in: ["CANCEL_PAYMENT_INTENT", "REFUND_SUPERSEDED_PAYMENT", "REFUND_BOOKING_MODIFICATION"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, type: true, status: true },
      });
    }

    it("before the superseded intent captures: one ordinary 25,000 capture on a 50,000 booking owes 25,000", async () => {
      // 25,000 captured by the real settle; an edit then adds 25,000 (one night up).
      await paidCardBooking(bookingId, 6_250);
      await postHistoryEdit(prisma, names, bookingId, `${bookingId}-rise`, { reprice: { guestId: `${bookingId}-g1`, stayDate: D2, priceCents: 6_250 + HALF }, changeFeeCents: 0 });
      // Its ask minted (the mint's ledger write), then superseded by a later ask, which queues the cancel of this
      // intent (the real cancel enqueue). The later ask itself is not needed for the cover question.
      await ledger.upsertPaymentIntentTransaction({
        paymentId: paymentOf(bookingId), kind: "ADDITIONAL", paymentIntentId: SUPERSEDED_INTENT, amountCents: HALF,
        carriedAskCents: 0, status: "PENDING", bookingModificationId: `${bookingId}-rise`,
      });
      supersededTxn = (await prisma.paymentTransaction.findFirstOrThrow({ where: { stripePaymentIntentId: SUPERSEDED_INTENT }, select: { id: true } })).id;
      await recovery.enqueuePaymentIntentCancellationRecovery({
        bookingId, paymentId: paymentOf(bookingId), paymentTransactionId: supersededTxn, paymentIntentId: SUPERSEDED_INTENT, amountCents: HALF,
      });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { finalPriceCents: true } })).toEqual({ finalPriceCents: 2 * HALF });
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });

    it("the real hand-off, paused after its capture commit and before its refund enqueue, and again after the enqueue: owes 25,000 throughout", async () => {
      const seen: Array<{ at: string; cover: BookingCashCover | null; captured: string; operations: Array<{ type: string; status: string }> }> = [];
      const look = async (at: string) => {
        const txn = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: supersededTxn }, select: { status: true } });
        seen.push({ at, cover: await cover(bookingId), captured: txn.status, operations: (await operations()).map(({ type, status }) => ({ type, status })) });
      };
      const delegate = prisma.paymentRecoveryOperation;
      const upsert = delegate.upsert.bind(delegate);
      const enqueue = vi.spyOn(delegate, "upsert").mockImplementation((async (args: Parameters<typeof upsert>[0]) => {
        const refundRow = (args.create as { type?: unknown }).type === "REFUND_SUPERSEDED_PAYMENT";
        if (refundRow) await look("capture committed, refund not yet enqueued");
        const row = await upsert(args);
        if (refundRow) await look("refund enqueued, cancel not yet closed");
        return row;
      }) as unknown as typeof upsert);
      try {
        // Stripe says the cancelled intent captured anyway: the webhook's door hands it to its refund.
        expect(await recovery.queueSupersededPaymentIntentRefundRecovery({ id: SUPERSEDED_INTENT, amount: HALF, payment_method: null, created: STRIPE_CREATED })).toBe(true);
      } finally {
        enqueue.mockRestore();
      }
      refundRowId = (await operations()).find((row) => row.type === "REFUND_SUPERSEDED_PAYMENT")?.id ?? "";

      expect(seen).toEqual([
        {
          at: "capture committed, refund not yet enqueued",
          cover: OWES(HALF),
          captured: "SUCCEEDED",
          operations: [{ type: "CANCEL_PAYMENT_INTENT", status: "PROCESSING" }],
        },
        {
          at: "refund enqueued, cancel not yet closed",
          cover: OWES(HALF),
          captured: "SUCCEEDED",
          operations: [{ type: "CANCEL_PAYMENT_INTENT", status: "PROCESSING" }, { type: "REFUND_SUPERSEDED_PAYMENT", status: "PENDING" }],
        },
      ]);
      expect((await operations()).map(({ type, status }) => ({ type, status }))).toEqual([
        { type: "CANCEL_PAYMENT_INTENT", status: "SUCCEEDED" },
        { type: "REFUND_SUPERSEDED_PAYMENT", status: "PENDING" },
      ]);
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });

    it("its refund recorded before the row closes, and after: owes 25,000 in both", async () => {
      stripeMakesRefunds();
      const seen: Array<{ cover: BookingCashCover | null; status: string; refunded: number }> = [];
      const close = pauseAtClose(refundRowId, async () => {
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: refundRowId }, select: { status: true } });
        const txn = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: supersededTxn }, select: { refundedAmountCents: true } });
        seen.push({ cover: await cover(bookingId), status: row.status, refunded: txn.refundedAmountCents });
      });
      try {
        expect(await recovery.runPaymentRecoveryOperationNow(refundRowId, CLUB_FORMAT_TEST)).toBe("succeeded");
      } finally {
        close.mockRestore();
      }
      supersededRefund = made[0];
      expect(made.map((refund) => ({ intent: refund.payment_intent, amount: refund.amount }))).toEqual([{ intent: SUPERSEDED_INTENT, amount: HALF }]);
      expect(seen).toEqual([{ cover: OWES(HALF), status: "PROCESSING", refunded: HALF }]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: refundRowId }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });

    it("Stripe fails that refund later and it is owed again: still owes 25,000, once", async () => {
      expect(supersededRefund).toBeDefined();
      const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
      expect(await recordRefusedCardRefund({ ...supersededRefund!, status: "failed" } as Stripe.Refund)).toBe("recorded");
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: supersededTxn }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: 0 });
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId, idempotencyKey: { startsWith: "card_refund_failed_later_" } } })).toBe(1);
      expect(await cover(bookingId)).toEqual(OWES(HALF));
    });
  });

  describe("a superseded capture behind a dead cancel is cash the club holds (§2.7)", () => {
    it("the hand-off commits the capture, its refund row is never written and the cancel dies: owed while in flight, then covered", async () => {
      const bookingId = id("superseded-dead");
      const intent = "pi_race_4069_superseded_dead";
      await paidCardBooking(bookingId, 6_250);
      await postHistoryEdit(prisma, names, bookingId, `${bookingId}-rise`, { reprice: { guestId: `${bookingId}-g1`, stayDate: D2, priceCents: 6_250 + HALF }, changeFeeCents: 0 });
      await ledger.upsertPaymentIntentTransaction({
        paymentId: paymentOf(bookingId), kind: "ADDITIONAL", paymentIntentId: intent, amountCents: HALF,
        carriedAskCents: 0, status: "PENDING", bookingModificationId: `${bookingId}-rise`,
      });
      const txn = await prisma.paymentTransaction.findFirstOrThrow({ where: { stripePaymentIntentId: intent }, select: { id: true } });
      await recovery.enqueuePaymentIntentCancellationRecovery({
        bookingId, paymentId: paymentOf(bookingId), paymentTransactionId: txn.id, paymentIntentId: intent, amountCents: HALF,
      });
      // The real hand-off commits the capture; its refund row's write fails.
      const delegate = prisma.paymentRecoveryOperation;
      const upsert = delegate.upsert.bind(delegate);
      const enqueue = vi.spyOn(delegate, "upsert").mockImplementation(((args: Parameters<typeof upsert>[0]) => {
        if ((args.create as { type?: unknown }).type === "REFUND_SUPERSEDED_PAYMENT") throw new Error("refund row not written");
        return upsert(args);
      }) as unknown as typeof upsert);
      try {
        await recovery.queueSupersededPaymentIntentRefundRecovery({ id: intent, amount: HALF, payment_method: null, created: STRIPE_CREATED }).catch(() => undefined);
      } finally {
        enqueue.mockRestore();
      }
      const rows = () => prisma.paymentRecoveryOperation.findMany({ where: { bookingId }, select: { type: true, status: true } });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: txn.id }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      expect((await rows()).map((row) => row.type)).toEqual(["CANCEL_PAYMENT_INTENT"]);
      // Its cancel row is still in flight: the machinery owns the charge.
      expect(await cover(bookingId)).toEqual(OWES(HALF));

      // The runner gives up on the cancel (fixture write: attempts spent, no retry). It now hands the money to
      // nobody, so the club holds both captures - the Xero reading's rule, which would otherwise hide a double payment.
      await prisma.paymentRecoveryOperation.updateMany({
        where: { bookingId, type: "CANCEL_PAYMENT_INTENT" },
        data: { status: "FAILED", nextRetryAt: null, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      });
      expect(await cover(bookingId)).toEqual(COVERED);
    });
  });

  describe("snapshot coherence: a write from outside an open snapshot is not seen in it", () => {
    it("a capture", async () => {
      const bookingId = id("snap-capture");
      await cardAsk(bookingId);
      expect(await coverAcross(bookingId, () => settleHistoryByCard(bookingId, PRICE))).toEqual(OWES(PRICE));
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("a refund", async () => {
      const bookingId = id("snap-refund");
      await paidCardBooking(bookingId);
      const capture = await primaryCapture(bookingId);
      const refund = stripeRefund({ paymentIntentId: intentOf(bookingId), amountCents: 5_000, metadata: { bookingId, reason: "date_change_price_decrease" } }, `re_${bookingId}`);
      expect(await coverAcross(bookingId, () =>
        ledger.recordStripeRefundsAgainstTransaction({ paymentId: paymentOf(bookingId), paymentTransactionId: capture.id, refunds: [refund], store: prisma }),
      )).toEqual(COVERED);
      expect(await cover(bookingId)).toEqual(OWES(5_000));
    });

    it("a credit application", async () => {
      const bookingId = id("snap-credit");
      await createHistoryBooking(prisma, names, bookingId, { payment: null });
      await prisma.memberCredit.create({ data: { memberId: names.memberId, amountCents: PRICE, type: "ADMIN_ADJUSTMENT", description: "#4069 snapshot proof" } });
      const { applyCreditToBooking } = await import("@/lib/member-credit");
      expect(await coverAcross(bookingId, () =>
        prisma.$transaction((tx) => applyCreditToBooking(names.memberId, PRICE, bookingId, tx, CLUB_FORMAT_TEST)),
      )).toEqual(OWES(PRICE));
      expect(await cover(bookingId)).toEqual(COVERED);
    });

    it("a group settlement", async () => {
      const g = groupHistory(PREFIX, "snap-group", "STRIPE", 1);
      await createGroupHistory(prisma, names, g);
      const [child] = g.children as [string];
      expect(await coverAcross(child, () => settleGroupHistory(g))).toEqual(ORGANISER_PAYS);
      expect(await cover(child)).toEqual(COVERED);
    });
  });
});

// Runs after the describe above has finished, its `afterAll` included, so a
// declaration that outlived it fails here rather than arming the next suite.
(RUN ? describe : describe.skip)("#4069: the cash-cover suite puts the environment role back", () => {
  it("leaves the environment role as it found it", () => {
    expect(harnessRole, "the suite declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(harnessRole!.before);
  });
});
