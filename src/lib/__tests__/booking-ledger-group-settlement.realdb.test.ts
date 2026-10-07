/**
 * Real-PostgreSQL proof that a group organiser's settlement posts its children's
 * money to the booking ledger (#3854, programme #3527 Stage 4; owner decision 2A
 * on #3583), driven through the real writers against the migrated schema:
 *
 *  - the card settle (`applyGroupSettlementSucceeded`, the webhook's door) and
 *    the Internet Banking invoice's inbound reconcile
 *    (`syncGroupSettlementForPaidInvoice`) each confirm every child on the
 *    ledger and post its share under the GROUP_SETTLEMENT anchor, and a replay
 *    posts nothing more;
 *  - a #3653 refund out of the combined card payment posts its card refund from
 *    the child's refund row, and a refund Stripe later fails is reversed;
 *  - the organiser's cancel keeps each child's share less every refund made or
 *    owed, and its refund plan's lines (the #3653 per-child debts for a card
 *    settlement, the frozen mirror plan for Internet Banking) bring owed(b) to
 *    zero; a re-run posts nothing more.
 *
 * At every step each child's ledger agrees with its columns: the charge side
 * with `finalPriceCents`, the settlement side with `Payment.amountCents -
 * refundedAmountCents`. Stripe is an in-memory double handed to the #3653
 * executor's seam; the organiser cancel's own inline attempt has no Stripe key
 * here, so its debts stay owed until the double makes them, as the recovery
 * runner would.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3854-`
 * fixtures.
 */
import type Stripe from "stripe";
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-3854";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const D1 = new Date("2027-09-01T00:00:00.000Z");
const D2 = new Date("2027-09-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-03T00:00:00.000Z");
const NIGHT_CENTS = 2_250;
const CHILD_CENTS = 2 * NIGHT_CENTS;

type Group = { organiser: string; group: string; settlement: string; children: string[] };
const group = (key: string, children: number): Group => ({
  organiser: `${P}-${key}-organiser`,
  group: `${P}-${key}-group`,
  settlement: `${P}-${key}-settlement`,
  children: Array.from({ length: children }, (_, index) => `${P}-${key}-child-${index + 1}`),
});
const CARD = { ...group("card", 2), pi: "pi_race_3854_card" };
const BANK = { ...group("bank", 2), invoice: `${P}-bank-invoice` };
const SWEEP = { ...group("sweep", 1), pi: "pi_race_3854_sweep" };
const LEGACY = { ...group("legacy", 1), pi: "pi_race_3854_legacy" };
const GROUPS = [CARD, BANK, SWEEP, LEGACY];
// Fix round A: two ordinary card bookings, reduced with credit back, then cancelled at 50% and at 100%.
const ORD = [
  { id: `${P}-ord-50`, pi: "pi_race_3854_ord_50", checkIn: D1, checkOut: CHECK_OUT, refundCents: 1_500 },
  { id: `${P}-ord-100`, pi: "pi_race_3854_ord_100", checkIn: new Date("2028-12-01T00:00:00.000Z"), checkOut: new Date("2028-12-03T00:00:00.000Z"), refundCents: 3_000 },
];
const ALL_BOOKINGS = [...GROUPS.flatMap((g) => [g.organiser, ...g.children]), ...ORD.map((booking) => booking.id)];

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeGroupSettlementLedgerDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Group-settlement ledger proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing to run group-settlement ledger proofs against port ${parsed.port || "(none)"}.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Group-settlement ledger proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Group-settlement ledger proof DB name must contain 'concurrency_race_1881'.");
  }
}

/** An in-memory Stripe: refunds by idempotency key, listable by intent, with a settable live status. */
function fakeStripe() {
  const byKey = new Map<string, Stripe.Refund>();
  const liveStatus = new Map<string, string>();
  const live = (refund: Stripe.Refund) => ({ ...refund, status: liveStatus.get(refund.id) ?? refund.status }) as Stripe.Refund;
  let seq = 0;
  let pendNext = false;
  return {
    pendNextRefund() {
      pendNext = true;
    },
    setStatus(refundId: string, status: string) {
      liveStatus.set(refundId, status);
    },
    async retrieveRefund(refundId: string) {
      const refund = [...byKey.values()].find((candidate) => candidate.id === refundId);
      if (!refund) throw new Error(`No such refund: ${refundId}`);
      return live(refund);
    },
    async processRefund(input: { paymentIntentId: string; amountCents: number; metadata?: Record<string, string>; idempotencyKey?: string }) {
      const key = input.idempotencyKey ?? `nokey-${seq}`;
      let refund = byKey.get(key);
      if (!refund) {
        seq += 1;
        refund = {
          id: `re_race_3854_${seq}`,
          amount: input.amountCents,
          currency: "nzd",
          status: pendNext ? "pending" : "succeeded",
          reason: null,
          created: Math.floor(Date.now() / 1000),
          charge: "ch_race_3854",
          payment_intent: input.paymentIntentId,
          metadata: input.metadata ?? {},
        } as unknown as Stripe.Refund;
        byKey.set(key, refund);
        pendNext = false;
      }
      return refund;
    },
    async listRefundsForPaymentIntent(paymentIntentId: string) {
      return [...byKey.values()].filter((refund) => refund.payment_intent === paymentIntentId).map(live);
    },
  };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let settle: typeof import("@/lib/group-settlement");
let inbound: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let groupCancel: typeof import("@/lib/group-cancel");
let core: typeof import("@/lib/organiser-child-refund");
let executor: typeof import("@/lib/organiser-child-refund-executor");
let groupSync: typeof import("@/lib/booking-ledger-group-settlement-sync");
let census: typeof import("@/lib/booking-ledger-projection-census-store");

(RUN ? describe : describe.skip)(
  "a group organiser's settlement on its children's ledgers — real PostgreSQL (#3854)",
  { timeout: 120_000 },
  () => {
    const stripe = fakeStripe();

    async function deleteFixtures() {
      const payments = await prisma.payment.findMany({ where: { bookingId: { in: ALL_BOOKINGS } }, select: { id: true } });
      const paymentIds = payments.map((payment) => payment.id);
      const settlementIds = GROUPS.map((g) => g.settlement);
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...paymentIds, ...ALL_BOOKINGS, ...settlementIds] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: ALL_BOOKINGS } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: { in: settlementIds } } });
      await prisma.groupBooking.deleteMany({ where: { id: { in: GROUPS.map((g) => g.group) } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.booking.deleteMany({ where: { id: { in: [...GROUPS.flatMap((g) => g.children), ...ORD.map((booking) => booking.id)] } } });
      await prisma.booking.deleteMany({ where: { id: { in: GROUPS.map((g) => g.organiser) } } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** An organiser-pays group with its children committed (CONFIRMED) and an open settlement. */
    async function createGroup(
      g: Group,
      settlement: { source: "STRIPE"; stripePaymentIntentId: string } | { source: "INTERNET_BANKING"; xeroInvoiceId: string },
    ) {
      const stay = { memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, totalPriceCents: CHILD_CENTS, finalPriceCents: CHILD_CENTS };
      await prisma.booking.create({ data: { ...stay, id: g.organiser, status: "PAID" } });
      await prisma.groupBooking.create({
        data: { id: g.group, organiserBookingId: g.organiser, organiserMemberId: MEMBER_ID, joinCode: g.group, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({
        data: { id: g.settlement, groupBookingId: g.group, amountCents: CHILD_CENTS * g.children.length, status: "PENDING", ...settlement },
      });
      for (const id of g.children) {
        await prisma.booking.create({ data: { ...stay, id, status: "CONFIRMED", parentBookingId: g.organiser, organiserSettled: true } });
        await prisma.bookingGuest.create({
          data: {
            id: `${id}-guest`,
            bookingId: id,
            firstName: "Joiner",
            lastName: id,
            ageTier: "ADULT",
            isMember: true,
            stayStart: D1,
            stayEnd: CHECK_OUT,
            priceCents: CHILD_CENTS,
            nights: {
              create: [
                { stayDate: D1, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
                { stayDate: D2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
              ],
            },
          },
        });
      }
    }

    async function lines(bookingId: string) {
      return prisma.bookingLedgerLine.findMany({
        where: { bookingId },
        orderBy: [{ postedAt: "asc" }, { id: "asc" }],
        select: { kind: true, side: true, amountCents: true, anchorKind: true, anchorId: true, settlementMethod: true, postingKey: true },
      });
    }

    async function lineCount(bookingIds: string[]) {
      return prisma.bookingLedgerLine.count({ where: { bookingId: { in: bookingIds } } });
    }

    /** The child's ledger, and what its columns say the same figures are. */
    async function ledgerAndColumns(bookingId: string) {
      const balance = bookingLedgerBalance(await lines(bookingId));
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { payment: true } });
      const payment = booking.payment!;
      return { balance, booking, columnsSettledCents: payment.amountCents - payment.refundedAmountCents };
    }

    /** Claim a debt as the recovery runner does, then run it through the executor with the double. */
    async function run(operationId: string) {
      const claimed = await prisma.paymentRecoveryOperation.update({
        where: { id: operationId },
        data: { status: "PROCESSING", attempts: { increment: 1 }, nextRetryAt: new Date() },
      });
      return executor.processOrganiserChildRefundOperation(claimed, CLUB_FORMAT_TEST, stripe);
    }

    /** An edit door's reduction debt on a child, written as the door writes it: under lock(1). */
    async function reserveReduction(g: typeof CARD, childId: string, modificationId: string, amountCents: number) {
      const row = await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement } });
      const plan = { settlement: { id: row.id, stripePaymentIntentId: g.pi, amountCents: row.amountCents }, amountCents };
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: childId } });
        return core.reserveOrganiserChildModificationRefund(tx, { plan, bookingId: childId, payment, bookingModificationId: modificationId });
      });
    }

    beforeAll(async () => {
      assertSafeGroupSettlementLedgerDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      settle = await import("@/lib/group-settlement");
      inbound = await import("@/lib/xero-inbound/invoice-paid-effects");
      groupCancel = await import("@/lib/group-cancel");
      core = await import("@/lib/organiser-child-refund");
      executor = await import("@/lib/organiser-child-refund-executor");
      groupSync = await import("@/lib/booking-ledger-group-settlement-sync");
      census = await import("@/lib/booking-ledger-projection-census-store");

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Group", lastName: "Ledger", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3854 Lodge", slug: P } });
      // One tier, however far ahead: half back, no fee.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      // Two years out, everything back: only the 100% ordinary booking stays that far ahead.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 600, refundPercentage: 100, fixedFeeCents: 0 } });
      await createGroup(CARD, { source: "STRIPE", stripePaymentIntentId: CARD.pi });
      await createGroup(BANK, { source: "INTERNET_BANKING", xeroInvoiceId: BANK.invoice });
      // Fix round D: a payment row that already existed (at a stale figure) takes the share on the settle.
      await prisma.payment.create({ data: { bookingId: BANK.children[1]!, amountCents: 1, status: "PENDING", source: "INTERNET_BANKING" } });
      await createGroup(SWEEP, { source: "STRIPE", stripePaymentIntentId: SWEEP.pi });
      await createGroup(LEGACY, { source: "STRIPE", stripePaymentIntentId: LEGACY.pi });
    }, 120_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 120_000);

    it("CARD: the real settle confirms each child on the ledger and posts its share under the settlement; owed(b) is zero", async () => {
      const result = await settle.applyGroupSettlementSucceeded({ id: CARD.pi, amount: 2 * CHILD_CENTS }, CLUB_FORMAT_TEST);
      expect(result).toMatchObject({ outcome: "settled" });
      expect([...result.settledBookingIds].sort()).toEqual([...CARD.children].sort());

      for (const childId of CARD.children) {
        const all = await lines(childId);
        expect(all.filter((line) => line.anchorKind === "CONFIRMATION").map((line) => line.amountCents)).toEqual([NIGHT_CENTS, NIGHT_CENTS]);
        expect(all.filter((line) => line.side === "SETTLEMENT")).toEqual([
          expect.objectContaining({
            kind: "CARD_CAPTURE",
            settlementMethod: "CARD",
            amountCents: CHILD_CENTS,
            anchorKind: "GROUP_SETTLEMENT",
            anchorId: CARD.settlement,
            postingKey: `group-settlement:${CARD.settlement}:child:${childId}`,
          }),
        ]);
        const { balance, booking, columnsSettledCents } = await ledgerAndColumns(childId);
        expect(booking.status).toBe("PAID");
        expect(balance).toMatchObject({ chargedCents: booking.finalPriceCents, settledCents: columnsSettledCents, owedCents: 0 });
      }
      // The shares sum exactly to what the settlement collected.
      const shares = await prisma.bookingLedgerLine.aggregate({
        where: { anchorKind: "GROUP_SETTLEMENT", anchorId: CARD.settlement },
        _sum: { amountCents: true },
      });
      expect(shares._sum.amountCents).toBe(2 * CHILD_CENTS);
    });

    it("CARD: a replayed webhook, and the poster run again in its own transaction, post nothing more", async () => {
      const before = await lineCount(CARD.children);
      expect(await settle.applyGroupSettlementSucceeded({ id: CARD.pi, amount: 2 * CHILD_CENTS }, CLUB_FORMAT_TEST)).toMatchObject({
        outcome: "already_settled",
      });
      // The confirmation fences per booking, not by key alone (§4.1a): a guest
      // removed and re-added has a new id, so its nights' keys are new, and the
      // child is still confirmed once.
      const [child1] = CARD.children;
      const guest = await prisma.bookingGuest.findUniqueOrThrow({ where: { id: `${child1}-guest` }, include: { nights: true } });
      await prisma.bookingGuest.delete({ where: { id: guest.id } });
      await prisma.bookingGuest.create({
        data: {
          id: `${child1}-guest-readded`,
          bookingId: child1!,
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          isMember: true,
          stayStart: guest.stayStart,
          stayEnd: guest.stayEnd,
          priceCents: guest.priceCents,
          nights: { create: guest.nights.map((night) => ({ stayDate: night.stayDate, priceCents: night.priceCents, priceSource: "SOLD" as const })) },
        },
      });
      const children = await prisma.booking.findMany({
        where: { id: { in: CARD.children } },
        select: { id: true, lodgeId: true, finalPriceCents: true },
      });
      const written = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        return groupSync.postGroupSettlementLedgerLines({
          store: tx,
          settlement: { id: CARD.settlement, source: "STRIPE", amountCents: 2 * CHILD_CENTS },
          children,
        });
      });
      expect(written).toBe(0);
      expect(await lineCount(CARD.children)).toBe(before);
    });

    it("#3653: a refund out of the combined card payment posts its card refund from the child's refund row, once", async () => {
      const [child1] = CARD.children;
      const debt = await reserveReduction(CARD, child1!, `${P}-mod-1`, 1_500);
      await run(debt!.id);

      const refundLines = (await lines(child1!)).filter((line) => line.kind === "CARD_REFUND");
      const refundRow = await prisma.paymentRefund.findFirstOrThrow({ where: { payment: { bookingId: child1! } } });
      expect(refundLines).toEqual([
        expect.objectContaining({ amountCents: -1_500, anchorKind: "PAYMENT_REFUND", anchorId: refundRow.id, postingKey: `refund:${refundRow.id}` }),
      ]);
      const { balance, columnsSettledCents } = await ledgerAndColumns(child1!);
      expect(balance.settledCents).toBe(columnsSettledCents);
      expect(balance.settledCents).toBe(CHILD_CENTS - 1_500);

      // A replay of the recorder posts nothing more.
      const before = await lineCount([child1!]);
      await run(debt!.id);
      expect(await lineCount([child1!])).toBe(before);
    });

    it("#3653: a refund Stripe accepted as pending and then failed is reversed on the ledger with its row", async () => {
      const result = await settle.applyGroupSettlementSucceeded({ id: SWEEP.pi, amount: CHILD_CENTS }, CLUB_FORMAT_TEST);
      expect(result).toMatchObject({ outcome: "settled" });
      const [child] = SWEEP.children;
      stripe.pendNextRefund();
      const debt = await reserveReduction(SWEEP, child!, `${P}-sweep-mod-1`, 2_000);
      const refundId = await run(debt!.id);
      expect((await ledgerAndColumns(child!)).balance.settledCents).toBe(CHILD_CENTS - 2_000);

      stripe.setStatus(refundId, "failed");
      expect((await executor.reconcilePendingOrganiserChildRefunds(stripe)).reversed).toBe(1);

      const refunds = (await lines(child!)).filter((line) => line.kind === "CARD_REFUND").map((line) => line.amountCents);
      expect(refunds.sort((a, b) => a - b)).toEqual([-2_000, 2_000]);
      const { balance, columnsSettledCents } = await ledgerAndColumns(child!);
      expect(balance).toMatchObject({ settledCents: CHILD_CENTS, owedCents: 0 });
      expect(balance.settledCents).toBe(columnsSettledCents);
    });

    it("CARD: the organiser's cancel keeps each share less every refund made or owed; once its debts are made, owed(b) is zero", async () => {
      const [child1, child2] = CARD.children;
      await groupCancel.settleGroupBookingOnOrganiserCancel(CARD.organiser, MEMBER_ID, "127.0.0.1", CLUB_FORMAT_TEST);

      // 50%: child 1 had 3000 of its 4500 left after its reduction, so 1500 back
      // and 1500 kept; child 2 had all 4500, so 2250 back and 2250 kept.
      const kept = async (bookingId: string) =>
        (await lines(bookingId)).filter((line) => line.kind === "CANCELLATION_FEE").map((line) => line.amountCents);
      expect(await kept(child1!)).toEqual([1_500]);
      expect(await kept(child2!)).toEqual([2_250]);

      const owed = await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: { in: CARD.children }, status: { not: "SUCCEEDED" } },
      });
      expect(owed.map((debt) => debt.amountCents).sort((a, b) => a - b)).toEqual([1_500, 2_250]);
      for (const debt of owed) await run(debt.id);

      for (const childId of CARD.children) {
        const { balance, booking, columnsSettledCents } = await ledgerAndColumns(childId);
        expect(booking.status).toBe("CANCELLED");
        expect(balance.owedCents).toBe(0);
        expect(balance.settledCents).toBe(columnsSettledCents);
      }

      // A re-run of the cancel, and of every debt, posts nothing more.
      const before = await lineCount(CARD.children);
      await groupCancel.settleGroupBookingOnOrganiserCancel(CARD.organiser, MEMBER_ID, "127.0.0.1", CLUB_FORMAT_TEST);
      for (const debt of owed) await run(debt.id);
      expect(await lineCount(CARD.children)).toBe(before);
    });

    it("INTERNET BANKING: the inbound reconcile of the paid combined invoice posts each child's bank receipt; a re-fetch posts nothing more", async () => {
      const invoice = { invoiceID: BANK.invoice, status: "PAID", amountPaid: (2 * CHILD_CENTS) / 100 } as unknown as Invoice;
      const result = await inbound.syncGroupSettlementForPaidInvoice(invoice, CLUB_FORMAT_TEST);
      expect(result).toMatchObject({ settledGroupSettlements: 1, settledChildBookings: 2 });

      for (const childId of BANK.children) {
        expect((await lines(childId)).filter((line) => line.side === "SETTLEMENT")).toEqual([
          expect.objectContaining({
            kind: "BANK_RECEIPT",
            settlementMethod: "INTERNET_BANKING",
            amountCents: CHILD_CENTS,
            anchorKind: "GROUP_SETTLEMENT",
            anchorId: BANK.settlement,
          }),
        ]);
        const { balance, booking, columnsSettledCents } = await ledgerAndColumns(childId);
        expect(balance).toMatchObject({ chargedCents: booking.finalPriceCents, settledCents: columnsSettledCents, owedCents: 0 });
      }

      const before = await lineCount(BANK.children);
      expect(await inbound.syncGroupSettlementForPaidInvoice(invoice, CLUB_FORMAT_TEST)).toMatchObject({ settledGroupSettlements: 0 });
      expect(await lineCount(BANK.children)).toBe(before);
    });

    it("FIX ROUND A: an Internet Banking group child cannot take a reduction as account credit; the real credit writer refuses it, so nothing commits", async () => {
      const [child] = BANK.children;
      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      const edit = await prisma.bookingModification.create({
        data: { bookingId: child!, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -1_500, changeFeeCents: 0 },
        select: { id: true },
      });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: child! } });
      // The edit doors hand the credit writer the booking's payment, and it
      // allocates the credit against the payment's captured transactions: a
      // group child has none, so the whole edit rolls back.
      await expect(
        prisma.$transaction((tx) => createBookingModificationCredit(MEMBER_ID, 1_500, child!, edit.id, undefined, tx, payment.id)),
      ).rejects.toThrow("Refund amount exceeds captured payments");
      expect(await prisma.memberCredit.count({ where: { sourceBookingId: child! } })).toBe(0);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmountCents).toBe(0);
      await prisma.bookingModification.delete({ where: { id: edit.id } });
    });

    it("INTERNET BANKING: the organiser's cancel posts its frozen plan's bank refund beside each mirror and keeps the rest; owed(b) is zero, and a re-run posts nothing", async () => {
      await groupCancel.settleGroupBookingOnOrganiserCancel(BANK.organiser, MEMBER_ID, "127.0.0.1", CLUB_FORMAT_TEST);
      expect((await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: BANK.settlement } })).refundPlan).toEqual(
        Object.fromEntries(BANK.children.map((id) => [id, CHILD_CENTS / 2])),
      );

      for (const childId of BANK.children) {
        const all = await lines(childId);
        expect(all.filter((line) => line.kind === "BANK_REFUND")).toEqual([
          expect.objectContaining({
            amountCents: -CHILD_CENTS / 2,
            settlementMethod: "INTERNET_BANKING",
            anchorKind: "GROUP_SETTLEMENT",
            anchorId: BANK.settlement,
            postingKey: `group-settlement:${BANK.settlement}:refund:${childId}`,
          }),
        ]);
        expect(all.filter((line) => line.kind === "CANCELLATION_FEE").map((line) => line.amountCents)).toEqual([CHILD_CENTS / 2]);
        const { balance, booking, columnsSettledCents } = await ledgerAndColumns(childId);
        expect(booking.status).toBe("CANCELLED");
        expect(balance.owedCents).toBe(0);
        expect(balance.settledCents).toBe(columnsSettledCents);
      }

      const before = await lineCount(BANK.children);
      await groupCancel.settleGroupBookingOnOrganiserCancel(BANK.organiser, MEMBER_ID, "127.0.0.1", CLUB_FORMAT_TEST);
      expect(await lineCount(BANK.children)).toBe(before);
    });

    it("FIX ROUND F: the pre-#3653 plan's replay posts a mirrored child's refund line by the plan, once", async () => {
      const [child] = LEGACY.children;
      expect(await settle.applyGroupSettlementSucceeded({ id: LEGACY.pi, amount: CHILD_CENTS }, CLUB_FORMAT_TEST)).toMatchObject({ outcome: "settled" });
      // What a colour before #3854 left: the plan frozen, the group refunded,
      // the child cancelled and its mirror written, but no ledger line.
      await prisma.groupBookingSettlement.update({
        where: { id: LEGACY.settlement },
        data: { refundPlan: { [child!]: CHILD_CENTS / 2 }, status: "PARTIALLY_REFUNDED" },
      });
      await prisma.booking.update({ where: { id: child! }, data: { status: "CANCELLED" } });
      await prisma.payment.update({ where: { bookingId: child! }, data: { refundedAmountCents: CHILD_CENTS / 2, status: "PARTIALLY_REFUNDED" } });

      expect(await groupCancel.executeGroupSettlementRefundPlan(LEGACY.settlement, CLUB_FORMAT_TEST)).toEqual({ outcome: "already_refunded", mirroredChildren: 0 });
      expect((await lines(child!)).filter((line) => line.kind === "CARD_REFUND")).toEqual([
        expect.objectContaining({ amountCents: -CHILD_CENTS / 2, anchorKind: "GROUP_SETTLEMENT", postingKey: `group-settlement:${LEGACY.settlement}:refund:${child}` }),
      ]);
      const { balance, columnsSettledCents } = await ledgerAndColumns(child!);
      expect(balance.settledCents).toBe(columnsSettledCents);

      const before = await lineCount([child!]);
      await groupCancel.executeGroupSettlementRefundPlan(LEGACY.settlement, CLUB_FORMAT_TEST);
      expect(await lineCount([child!])).toBe(before);
    });

    it.each(ORD)("FIX ROUND A: an ordinary card booking reduced with credit back, then the REAL paid cancel: the kept figure already nets the credit, and owed(b) is zero ($id)", async (ord) => {
      const { planConfirmationChargeLines } = await import("@/lib/booking-ledger-confirmation-posting");
      const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      const { postModificationLedgerLines } = await import("@/lib/booking-ledger-modification-sync");
      const { createBookingModificationCredit } = await import("@/lib/member-credit");
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const night2 = new Date(ord.checkIn.getTime() + 24 * 60 * 60 * 1000);
      const guestId = `${ord.id}-guest`;
      await prisma.booking.create({
        data: { id: ord.id, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: ord.checkIn, checkOut: ord.checkOut, status: "PAID", totalPriceCents: CHILD_CENTS, finalPriceCents: CHILD_CENTS },
      });
      await prisma.bookingGuest.create({
        data: {
          id: guestId, bookingId: ord.id, firstName: "Ordinary", lastName: ord.id, ageTier: "ADULT", isMember: true, stayStart: ord.checkIn, stayEnd: ord.checkOut, priceCents: CHILD_CENTS,
          nights: { create: [{ stayDate: ord.checkIn, priceCents: NIGHT_CENTS, priceSource: "SOLD" }, { stayDate: night2, priceCents: NIGHT_CENTS, priceSource: "SOLD" }] },
        },
      });
      const payment = await prisma.payment.create({
        data: {
          bookingId: ord.id, amountCents: CHILD_CENTS, status: "SUCCEEDED", source: "STRIPE", stripePaymentIntentId: ord.pi,
          transactions: { create: { kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: ord.pi, amountCents: CHILD_CENTS, status: "SUCCEEDED" } },
        },
      });
      // Confirmed on the ledger as the settle body confirms it, and its capture converged from its transaction.
      const guests = await prisma.bookingGuest.findMany({
        where: { bookingId: ord.id },
        select: { id: true, firstName: true, lastName: true, ageTier: true, rateMembershipTypeId: true, nights: { select: { stayDate: true, priceCents: true } } },
      });
      await prisma.$transaction(async (tx) => {
        await postBookingLedgerLines(tx, planConfirmationChargeLines({ id: ord.id, lodgeId: LODGE_ID, totalPriceCents: CHILD_CENTS, promoAdjustmentCents: 0, guests }).postings);
        await reconcilePaymentAggregates({ paymentId: payment.id, store: tx });
      });

      // An edit takes $15 off the second night and gives it back as account credit, through the real writers.
      const side = (second: number) => ({
        guests: [{
          guestKey: guestId, ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: null, name: "Ordinary",
          nights: [{ stayDate: ord.checkIn, priceCents: NIGHT_CENTS, priceSource: "SOLD" as const }, { stayDate: night2, priceCents: second, priceSource: "SOLD" as const }],
        }],
        promoAdjustmentCents: 0,
      });
      const edit = await prisma.bookingModification.create({
        data: { bookingId: ord.id, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -1_500, changeFeeCents: 0 },
        select: { id: true },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await postModificationLedgerLines({
          store: tx, bookingId: ord.id, lodgeId: LODGE_ID,
          bookingModification: { id: edit.id, priceDiffCents: -1_500, changeFeeCents: 0 },
          sides: { before: side(NIGHT_CENTS), after: side(NIGHT_CENTS - 1_500) },
          site: "race-3854",
        });
        await tx.bookingGuestNight.updateMany({ where: { bookingGuestId: guestId, stayDate: night2 }, data: { priceCents: NIGHT_CENTS - 1_500 } });
        await tx.bookingGuest.update({ where: { id: guestId }, data: { priceCents: CHILD_CENTS - 1_500 } });
        await tx.booking.update({ where: { id: ord.id }, data: { totalPriceCents: CHILD_CENTS - 1_500, finalPriceCents: CHILD_CENTS - 1_500 } });
        await createBookingModificationCredit(MEMBER_ID, 1_500, ord.id, edit.id, undefined, tx, payment.id);
      });
      // The credit's allocation raised the refunded column: the payment says $30 paid, net.
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ amountCents: CHILD_CENTS, refundedAmountCents: 1_500 });
      expect(bookingLedgerBalance(await lines(ord.id)).owedCents).toBe(0);

      const result = await cancelBooking(ord.id, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      expect(result.status).toBe(200);
      const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: ord.id, type: "CANCELLED" } });
      const snapshot = event.snapshot as { settledAmountCents: number; ledger: { keptCents: number } };
      // 50%: $15 back, $15 kept. 100%: $30 back, nothing kept. Never the credit counted twice.
      expect(snapshot).toMatchObject({ settledAmountCents: ord.refundCents, ledger: { keptCents: CHILD_CENTS - 1_500 - ord.refundCents } });
      // The card refund has not posted (no Stripe here): owed(b) is exactly what it will return.
      expect(bookingLedgerBalance(await lines(ord.id)).owedCents).toBe(-ord.refundCents);
      await prisma.$transaction((tx) =>
        postBookingLedgerLines(tx, [{
          bookingId: ord.id, lodgeId: LODGE_ID, side: "SETTLEMENT", kind: "CARD_REFUND", sign: -1, quantity: 1, unitCents: ord.refundCents,
          anchorKind: "PAYMENT_REFUND", anchorId: `${ord.id}-refund`, settlementMethod: "CARD", narration: "Card refund", postingKey: `refund:${ord.id}-refund`,
        }]),
      );
      expect(bookingLedgerBalance(await lines(ord.id)).owedCents).toBe(0);
    }, 120_000);

    it("FIX ROUND H: the census reads AGREE on every group history above, and a corrupted share or plan refund disagrees", async () => {
      const subjects = [...CARD.children, ...BANK.children, ...SWEEP.children];
      const evaluate = async () => {
        const evaluations = await prisma.$transaction((tx) => census.evaluateBookingLedgerPages(tx), { isolationLevel: "RepeatableRead", timeout: 120_000 });
        return new Map(evaluations.filter((evaluation) => subjects.includes(evaluation.bookingId)).map((evaluation) => [evaluation.bookingId, evaluation]));
      };
      const clean = await evaluate();
      expect([...clean.keys()].sort()).toEqual([...subjects].sort());
      for (const [bookingId, evaluation] of clean) {
        const notAgreeing = evaluation.identities.filter((identity) => identity.status !== "AGREE" && identity.status !== "NOT_APPLICABLE");
        expect({ bookingId, notAgreeing, integrity: evaluation.integrity, coverage: evaluation.coverage, bookingClass: evaluation.bookingClass }).toEqual({
          bookingId, notAgreeing: [], integrity: [], coverage: [], bookingClass: null,
        });
      }

      // A share that no longer matches its child's payment.
      const [cardChild] = CARD.children;
      const cardPayment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: cardChild! } });
      await prisma.payment.update({ where: { id: cardPayment.id }, data: { amountCents: cardPayment.amountCents - 1 } });
      // A plan refund line that no longer matches the frozen plan.
      const [bankChild] = BANK.children;
      const plan = (await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: BANK.settlement } })).refundPlan as Record<string, number>;
      await prisma.groupBookingSettlement.update({ where: { id: BANK.settlement }, data: { refundPlan: { ...plan, [bankChild!]: plan[bankChild!]! - 1 } } });
      try {
        const corrupted = await evaluate();
        const card = corrupted.get(cardChild!)!;
        expect(card.identities.find((identity) => identity.identity === "CAPTURED")?.status).toBe("DISAGREE");
        expect(card.integrity.map((finding) => finding.kind)).toContain("SOURCE_DRIFT");
        expect(corrupted.get(bankChild!)!.integrity.map((finding) => finding.kind)).toContain("SOURCE_DRIFT");
      } finally {
        await prisma.payment.update({ where: { id: cardPayment.id }, data: { amountCents: cardPayment.amountCents } });
        await prisma.groupBookingSettlement.update({ where: { id: BANK.settlement }, data: { refundPlan: plan } });
      }
    });
  },
);
