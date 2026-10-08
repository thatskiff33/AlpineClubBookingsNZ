/**
 * Real-PostgreSQL proof for #3809: a price reduction on a booking paid ENTIRELY
 * with account credit gives back what a card-paid booking's would - `min(
 * reduction, applied credit)` tiered by the card tier - through the one
 * give-back (`giveBackAppliedCredit`), its Xero deallocation step included.
 *
 * Through the REAL guest removal (`removeBookingGuestInTransaction`, the
 * reduction door every removal takes, and its Xero leg) and the REAL `cancelBooking`, on real
 * rows: the member-credit ledger, the booking ledger, the queued Xero
 * documents. The lock-order case is FORCED, not raced: a third connection holds
 * the member's credit-ledger key, PostgreSQL reports the removal queued behind
 * it, and only then is the Payment row probed with `NOWAIT`.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-paid-reduction.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3809-member";
const LODGE_ID = "race-3809-lodge";
const BOOKING_ID = "race-3809-booking";
const STAYING_GUEST_ID = "race-3809-guest-stays";
const LEAVING_GUEST_ID = "race-3809-guest-leaves";
const PAYMENT_ID = "race-3809-payment";
const XERO_INVOICE_ID = "race-3809-xero-invoice";
const CREDIT_NOTE_ID = "race-3809-credit-note";

/** The frozen test clock's day; the stay is permanently in the future. */
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
/** $150 stays, $50 leaves: removing the second guest is a $50 reduction on a $200 booking. */
const GUESTS = [
  { id: STAYING_GUEST_ID, firstName: "Staying", nightCents: 7_500 },
  { id: LEAVING_GUEST_ID, firstName: "Leaving", nightCents: 2_500 },
];
/** The card-and-credit case: the $150 guest leaves, a $150 reduction. */
const MIXED_GUESTS = [
  { id: STAYING_GUEST_ID, firstName: "Staying", nightCents: 2_500 },
  { id: LEAVING_GUEST_ID, firstName: "Leaving", nightCents: 7_500 },
];

const TIERS = [
  { tier: "100%", rule: { refundPercentage: 100, fixedFeeCents: 0 }, givenBackCents: 5_000 },
  { tier: "50% with a $20 fee", rule: { refundPercentage: 50, fixedFeeCents: 2_000 }, givenBackCents: 500 },
  { tier: "0%", rule: { refundPercentage: 0, fixedFeeCents: 0 }, givenBackCents: 0 },
];
const FIFTY_LESS_TWENTY = TIERS[1]!.rule;

const LOCK_POLL_TIMEOUT_MS = 2_000;

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let credit: typeof import("@/lib/member-credit");
let ledger: typeof import("@/lib/booking-ledger-balance");
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "#3809: a credit-paid booking's price reduction gives back like a card refund - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, ...modifications.map((row) => row.id)] } } });
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { id: true } });
      await prisma.xeroObjectLink.deleteMany({ where: { localModel: "MemberCreditNoteAllocation", localId: { in: slices.map((slice) => slice.id) } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: BOOKING_ID }] } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * A $200 PAID booking, confirmed on the ledger, paid entirely by $200 of
     * account credit: nothing captured. `ib-allocated` is a bank-transfer
     * booking whose credit is allocated against its Xero invoice;
     * `card-invoiced` is the card path's, whose credit was never allocated before #3836 (the repair pass now queues it).
     */
    async function creditPaidBooking(shape: "ib-allocated" | "card-invoiced" | "card-and-credit", rule: (typeof TIERS)[number]["rule"]) {
      const mixed = shape === "card-and-credit";
      const appliedCents = mixed ? 10_000 : 20_000;
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-3809@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3809 Lodge", slug: "race-3809" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, ...rule } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
      for (const guest of mixed ? MIXED_GUESTS : GUESTS) {
        await prisma.bookingGuest.create({
          data: {
            id: guest.id, bookingId: BOOKING_ID, firstName: guest.firstName, lastName: "Guest", ageTier: "ADULT",
            stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: guest.nightCents * 2,
          },
        });
        await prisma.bookingGuestNight.createMany({
          data: NIGHTS.map((stayDate) => ({ bookingGuestId: guest.id, stayDate, priceCents: guest.nightCents, priceSource: "SOLD" as const })),
        });
        for (const [index, night] of NIGHTS.entries()) {
          await prisma.bookingLedgerLine.create({ data: {
            bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: guest.nightCents, amountCents: guest.nightCents,
            bookingGuestId: guest.id, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
            guestNames: [`${guest.firstName} Guest`], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 3809 confirmation",
            lodgeId: LODGE_ID, postingKey: `race-3809-confirm-${guest.id}-${index}`,
          } });
        }
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000 - appliedCents, status: "SUCCEEDED", creditAppliedCents: appliedCents,
          source: shape === "ib-allocated" ? "INTERNET_BANKING" : "STRIPE", xeroInvoiceId: XERO_INVOICE_ID,
        },
      });
      await prisma.memberCredit.create({
        data: {
          memberId: MEMBER_ID, amountCents: appliedCents, type: "ADMIN_ADJUSTMENT", description: "race 3809 opening balance",
          // A spent credit carries a note (#2717); the card path never allocated it before #3836.
          ...(shape !== "card-invoiced" ? { xeroCreditNoteId: CREDIT_NOTE_ID } : {}),
        },
      });
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, appliedCents, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      if (shape !== "card-invoiced") {
        await prisma.memberCredit.updateMany({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED" }, data: { xeroCreditNoteId: CREDIT_NOTE_ID } });
      }
      // A bank-transfer booking's credit is allocated at creation (#1620), a card
      // booking's after its capture (#1641): either way the same working slice.
      if (shape === "ib-allocated" || mixed) {
        const { repairLegacyAppliedCreditNoteAllocationsForBooking } = await import("@/lib/xero-applied-credit-allocation-repair");
        await prisma.$transaction((tx) => repairLegacyAppliedCreditNoteAllocationsForBooking(BOOKING_ID, XERO_INVOICE_ID, tx, CLUB_FORMAT_TEST));
      }
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
      if (!mixed) expect(await owed()).toBe(0);
    }

    const ledgerLines = () => prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID } });
    const owed = async () => ledger.bookingLedgerBalance(await ledgerLines()).owedCents;

    /** The REAL removal of the $50 guest, then the Xero leg exactly as the DELETE route queues it. */
    async function removeLeavingGuest(settlementMethod?: "card" | "credit") {
      const { removeBookingGuestInTransaction } = await import("@/lib/booking-guest-removal-service");
      const result = await prisma.$transaction(
        (tx) => removeBookingGuestInTransaction({
          tx, bookingId: BOOKING_ID, guestId: LEAVING_GUEST_ID, actorMemberId: MEMBER_ID, actorRole: "ADMIN", today: TODAY, format: CLUB_FORMAT_TEST,
          ...(settlementMethod ? { settlementMethod } : {}),
        }),
        { maxWait: 10_000, timeout: 20_000 },
      );
      // The DELETE route's own Xero leg, shared with the consent doors.
      const { guestRemovalXeroSettlement, queueGuestRemovalXeroSettlement } = await import("@/lib/booking-guest-removal-xero");
      await queueGuestRemovalXeroSettlement(guestRemovalXeroSettlement(result), {
        createdByMemberId: MEMBER_ID,
        additionalPaymentIntentId: null,
      });
      return result;
    }

    async function queuedNotes(bookingModificationId: string) {
      const operations = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: bookingModificationId, entityType: "CREDIT_NOTE" },
        select: { queueType: true, requestPayload: true },
      });
      return operations.map((operation) => {
        const payload = operation.requestPayload as { refundAmountCents: number; refundMethod?: string };
        return { queueType: operation.queueType, cents: payload.refundAmountCents, refundMethod: payload.refundMethod ?? null };
      });
    }

    async function deallocationTarget(): Promise<number | null> {
      const deallocation = await prisma.xeroSyncOperation.findFirst({
        where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_DEALLOCATION" },
        select: { correlationKey: true },
      });
      return deallocation ? Number(deallocation.correlationKey?.split(":").at(-2)) : null;
    }

    /** The worker's deallocation, landed: the slices at its target, the row COMPLETED. */
    async function deallocationConverges() {
      const target = await deallocationTarget();
      if (target === null) return;
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: BOOKING_ID }, select: { id: true } });
      await prisma.memberCreditNoteAllocation.updateMany({ where: { appliedToBookingId: BOOKING_ID }, data: { amountCents: target } });
      // ...and its provenance, as the worker re-records it.
      const links = await prisma.xeroObjectLink.findMany({
        where: { localModel: "MemberCreditNoteAllocation", localId: { in: slices.map((slice) => slice.id) }, active: true },
        select: { id: true, metadata: true },
      });
      for (const link of links) {
        await prisma.xeroObjectLink.update({
          where: { id: link.id },
          data: { metadata: { ...(link.metadata as Record<string, unknown>), amountCents: target, rowTargetCents: target } },
        });
      }
      await prisma.xeroSyncOperation.updateMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, queueType: "APPLIED_CREDIT_DEALLOCATION" },
        data: { status: "COMPLETED" },
      });
    }

    async function cancelAt(rule: (typeof TIERS)[number]["rule"]) {
      await prisma.cancellationPolicy.updateMany({ where: { lodgeId: LODGE_ID }, data: rule });
      const { cancelBooking } = await import("@/lib/booking-cancel");
      const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
      expect(result.status).toBe(200);
    }

    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for the removal to queue behind the member-credit key held by pid ${blockerPid}.`);
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      credit = await import("@/lib/member-credit");
      ledger = await import("@/lib/booking-ledger-balance");
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = separate("race-3809-lock-holder");
      observerClient = separate("race-3809-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);
    }, 60_000);

    afterAll(async () => {
      await Promise.all([lockHolderClient, observerClient].map((client) => (client ? client.$disconnect().catch(() => {}) : Promise.resolve())));
      if (typeof prisma !== "undefined") {
        // Not swallowed: a leaked fixture is a false result in another suite of this shared database.
        try {
          await deleteFixtures();
        } finally {
          await prisma.$disconnect().catch(() => {});
        }
      }
    });

    it.each(TIERS)("bank transfer, the 5000-cent guest removed at $tier: $givenBackCents cents back as applied credit, the mirror and the ledger follow, and Xero agrees on what is due and on the member's credit", async ({ rule, givenBackCents }) => {
      await creditPaidBooking("ib-allocated", rule);

      const result = await removeLeavingGuest();

      expect(result.priceDiffCents).toBe(-5_000);
      expect(result.refundAmountCents).toBe(0);
      expect(result.accountCreditAmountCents).toBe(0);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(givenBackCents);
      expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(20_000 - givenBackCents);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { creditAppliedCents: true, amountCents: true } });
      expect(payment).toEqual({ creditAppliedCents: 20_000 - givenBackCents, amountCents: 0 });
      // Nothing minted beside the give-back.
      expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID, type: "BOOKING_MODIFICATION_REFUND" } })).toBe(0);

      // The booking ledger: the reduction's night reversals and the give-back's
      // credit line. At 100% the club owes nothing; below it, what the policy
      // kept is the club's, exactly as a card reduction's retained slice is.
      expect(await owed()).toBe(givenBackCents - 5_000);

      // Xero, once its queue drains: the deallocation reopens the invoice by
      // the give-back and the invoice-allocated note closes it again.
      const notes = await queuedNotes(result.bookingModificationId);
      const target = await deallocationTarget();
      if (givenBackCents > 0) {
        expect(notes).toEqual([{ queueType: "MODIFICATION_CREDIT_NOTE", cents: givenBackCents, refundMethod: "account-credit" }]);
        expect(target).toBe(20_000 - givenBackCents);
      } else {
        expect(notes).toEqual([]);
        expect(target).toBeNull();
      }
      const allocatedCents = target ?? 20_000;
      const noteCents = notes.reduce((sum, note) => sum + note.cents, 0);
      expect(20_000 - noteCents - allocatedCents, "Xero's amount due = the app's owed").toBe(0);
      expect(20_000 - allocatedCents, "the member's Xero credit = the app's").toBe(await credit.getMemberCreditBalance(MEMBER_ID));
    });

    it("the issue's worked example on the REAL cancel: $50 back at 100%, then a cancel at 50% less $20 restores $55 - $105 in all, what a card-paid member gets", async () => {
      await creditPaidBooking("ib-allocated", TIERS[0]!.rule);
      await removeLeavingGuest();
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(5_000);
      await deallocationConverges();

      await cancelAt(FIFTY_LESS_TWENTY);

      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(10_500);
      expect(await owed()).toBe(0);
    });

    it("the card path, invoiced before #3836 with its credit never allocated: no deallocation, the give-back's allocated note, and the member's app credit", async () => {
      await creditPaidBooking("card-invoiced", TIERS[0]!.rule);

      const result = await removeLeavingGuest();

      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(5_000);
      expect(await deallocationTarget()).toBeNull();
      expect(await queuedNotes(result.bookingModificationId)).toEqual([
        { queueType: "MODIFICATION_CREDIT_NOTE", cents: 5_000, refundMethod: "account-credit" },
      ]);
      expect(await owed()).toBe(0);
    });

    it("finding 1: $5 back at 50% less $20, then the REAL cancel at 50% less $20 tiers the $150 the booking is worth, not the $195 still applied - $60 in all, the card-paid figure, and the ledger owes nothing", async () => {
      await creditPaidBooking("ib-allocated", FIFTY_LESS_TWENTY);
      await removeLeavingGuest();
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(500);
      await deallocationConverges();

      await cancelAt(FIFTY_LESS_TWENTY);

      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(6_000);
      expect(await owed()).toBe(0);
      // The cap is frozen with the decision, for a later review's netting (INV-PAY-113).
      const cancelled = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "CANCELLED" }, select: { snapshot: true } });
      expect((cancelled.snapshot as { ledger: { appliedCreditBaseCents: number } }).ledger.appliedCreditBaseCents).toBe(15_000);
    });

    it.each([
      { tier: "100%", rule: TIERS[0]!.rule, cardCents: 10_000, givenBackCents: 5_000 },
      { tier: "50% with a $20 fee", rule: FIFTY_LESS_TWENTY, cardCents: 3_000, givenBackCents: 2_500 },
      { tier: "0%", rule: TIERS[2]!.rule, cardCents: 0, givenBackCents: 0 },
    ])("finding 4 and H1: 10000 cents by card and 10000 by credit (allocated in Xero, #1641), the 15000-cent guest removed at $tier: $cardCents to the card and $givenBackCents of credit back, the all-card figure; the allocation comes down by the give-back, Xero agrees with the app, and the inbound sync leaves the give-back where it is", async ({ rule, cardCents, givenBackCents }) => {
      await creditPaidBooking("card-and-credit", rule);

      const result = await removeLeavingGuest("card");

      expect(result.priceDiffCents).toBe(-15_000);
      expect(result.refundAmountCents).toBe(cardCents);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(givenBackCents);
      expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(10_000 - givenBackCents);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { creditAppliedCents: true } });
      expect(payment.creditAppliedCents).toBe(10_000 - givenBackCents);
      // Review low 2: one note names one method (INV-PAY-101), so the credit
      // given back is an allocated note of its own beside the card refund's.
      const notes = await queuedNotes(result.bookingModificationId);
      const expectedNotes = [
        ...(cardCents > 0 ? [{ queueType: "MODIFICATION_CREDIT_NOTE", cents: cardCents, refundMethod: "card" }] : []),
        ...(givenBackCents > 0 ? [{ queueType: "MODIFICATION_CREDIT_NOTE", cents: givenBackCents, refundMethod: "account-credit" }] : []),
      ];
      expect(notes).toEqual(expect.arrayContaining(expectedNotes));
      expect(notes).toHaveLength(expectedNotes.length);

      // H1: the card booking's credit is allocated (#1641), so the give-back
      // deallocates it down to what is still applied, as a bank transfer's does.
      const target = await deallocationTarget();
      expect(target).toBe(givenBackCents > 0 ? 10_000 - givenBackCents : null);

      // The three invariants, from the rows the app wrote. The card refund's note
      // and the give-back's are both allocated against the invoice; the money
      // the policy kept stays on it, as for any captured payment.
      const allocatedCents = target ?? 10_000;
      const invoiceNetCents = 20_000 - notes.reduce((sum, note) => sum + note.cents, 0);
      const cashKeptCents = 10_000 - cardCents;
      expect(invoiceNetCents, "(i) invoice net of its notes = the price plus what the policy kept").toBe(5_000 + result.policyRetainedAmountCents);
      expect(invoiceNetCents - allocatedCents - cashKeptCents, "(ii) Xero's due = the app's owed").toBe(0);
      expect(10_000 - allocatedCents, "(iii) the member's Xero credit = the app's").toBe(await credit.getMemberCreditBalance(MEMBER_ID));

      // The inbound sync: fenced while Xero still shows the old allocation, then
      // reading the converged one, it leaves the give-back exactly where it is.
      const { repairAccountCreditAllocationBusinessState } = await import("@/lib/xero-inbound/credit-note-repairs");
      if (target !== null) {
        await expect(
          repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, [{ invoiceId: XERO_INVOICE_ID, amountCents: 10_000 }]),
        ).rejects.toThrow(/converge it before changing applied credit/);
        await deallocationConverges();
      }
      await repairAccountCreditAllocationBusinessState(CREDIT_NOTE_ID, [{ invoiceId: XERO_INVOICE_ID, amountCents: allocatedCents }]);
      expect(await credit.deriveBookingAppliedCreditCents(BOOKING_ID)).toBe(10_000 - givenBackCents);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(givenBackCents);
    });

    it.each([
      { tier: "100%", rule: TIERS[0]!.rule, totalBackCents: 20_000 },
      { tier: "50% with a $20 fee", rule: FIFTY_LESS_TWENTY, totalBackCents: 8_000 },
    ])("F1, owner decision of 4 Oct 2026: a booking reduced BEFORE this release (price lowered, no give-back recorded) is not capped - the REAL cancel at $tier restores $totalBackCents cents, as on main", async ({ rule, totalBackCents }) => {
      await creditPaidBooking("ib-allocated", rule);
      // The pre-release shape: the price came down by $50 and nothing gave credit back.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 15_000, finalPriceCents: 15_000 } });
      const { calculateCancellationPreview } = await import("@/lib/policies/booking-route-decisions");
      const { bookingReducedThroughCreditGiveBack } = await import("@/lib/booking-credit-give-back-marker");
      const capped = await bookingReducedThroughCreditGiveBack(BOOKING_ID, prisma);
      expect(capped).toBe(false);
      const preview = calculateCancellationPreview({
        payment: { amountCents: 0, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: 20_000 },
        openNonCancellationHandBackCents: 0,
        finalPriceCents: 15_000,
        checkIn: CHECK_IN,
        policyRules: [{ daysBeforeStay: 0, ...rule }],
        todayAtClub: "2026-07-01" as never,
        capAppliedCredit: capped,
      });

      await cancelAt(rule);

      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(totalBackCents);
      expect(preview.creditRestoredCents).toBe(totalBackCents);
      const cancelled = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: BOOKING_ID, type: "CANCELLED" }, select: { snapshot: true } });
      expect((cancelled.snapshot as { ledger: { appliedCreditBaseCents: number } }).ledger.appliedCreditBaseCents).toBe(20_000);
    });

    it.each([
      { tier: "0%", rule: TIERS[2]!.rule, cancelBackCents: 0 },
      { tier: "50% with a $20 fee", rule: FIFTY_LESS_TWENTY, cancelBackCents: 500 },
    ])("F2: 10000 cents by card and 10000 by credit, 15000 removed at 100% (the card refunded whole), then the REAL cancel at $tier: the last 5000 of credit is tiered, not restored whole - the all-card total", async ({ rule, cancelBackCents }) => {
      await creditPaidBooking("card-and-credit", TIERS[0]!.rule);
      const removed = await removeLeavingGuest("card");
      expect(removed.refundAmountCents).toBe(10_000);
      // The give-back's deallocation (H1) lands before the cancel, which waits on it.
      await deallocationConverges();
      // The route's Stripe refund, landed: the card is refunded whole.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000, status: "REFUNDED" } });
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(5_000);
      const { refundedPaymentCreditRestore } = await import("@/lib/cancel-refunded-payment-credit");
      await prisma.cancellationPolicy.updateMany({ where: { lodgeId: LODGE_ID }, data: rule });
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
      const previewed = await refundedPaymentCreditRestore(prisma, { bookingId: BOOKING_ID, booking: { ...booking, payment: booking.payment! }, openNonCancellationHandBackCents: 0, todayAtClub: "2026-07-01" as never });

      await cancelAt(rule);

      const creditBackCents = (await credit.getMemberCreditBalance(MEMBER_ID)) - 5_000;
      expect(creditBackCents).toBe(cancelBackCents);
      // The preview's figure (the same helper) is the cancel's.
      expect(previewed?.creditToRestoreCents).toBe(cancelBackCents);
      // All-card: $150 refunded at 100%, then the cancel tiers the $50 the booking is worth.
      const { calculateRefundAmount } = await import("@/lib/cancellation");
      const allCardCancel = calculateRefundAmount(5_000, 31, [{ daysBeforeStay: 0, ...rule }]).refundAmountCents;
      expect(10_000 + 5_000 + creditBackCents).toBe(15_000 + allCardCancel);
    });

    it("F2, owner decision of 4 Oct 2026: the same booking reduced BEFORE this release (card refunded whole, no credit given back) keeps main's full restore at 50% less $20 - never short", async () => {
      await creditPaidBooking("card-and-credit", FIFTY_LESS_TWENTY);
      // The pre-release shape: $150 off, the card refunded whole, nothing given back, no history row.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 5_000, finalPriceCents: 5_000 } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 10_000, status: "REFUNDED" } });
      const { refundedPaymentCreditRestore } = await import("@/lib/cancel-refunded-payment-credit");
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, include: { payment: true } });
      expect(await refundedPaymentCreditRestore(prisma, { bookingId: BOOKING_ID, booking: { ...booking, payment: booking.payment! }, openNonCancellationHandBackCents: 0, todayAtClub: "2026-07-01" as never })).toBeNull();

      await cancelAt(FIFTY_LESS_TWENTY);

      // Main's figure: all $100 still applied comes back ($200 in all), not the tiered $30 ($130, short of all-card's $155).
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(10_000);
    });

    it("FORCES the lock order: the removal queues on the member's credit-ledger key holding NO lock on the Payment row, and completes once the key is released", async () => {
      await creditPaidBooking("ib-allocated", TIERS[0]!.rule);
      const release = deferred();
      const holderPid = deferred<number>();
      const holder = lockHolderClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('member-credit-ledger'), hashtext(${MEMBER_ID}))`;
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        holderPid.resolve(rows[0]!.pid);
        await release.promise;
      }, { timeout: 20_000 });

      const removal = removeLeavingGuest();
      await waitForBlockedBy(await holderPid.promise);

      // The removal is parked on the member key. Had it touched the Payment
      // row first, this NOWAIT would fail with "could not obtain lock".
      await expect(observerClient.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${PAYMENT_ID} FOR UPDATE NOWAIT`;
      })).resolves.toBeUndefined();

      release.resolve();
      await holder;
      await removal;
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(5_000);
    });
  },
);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
