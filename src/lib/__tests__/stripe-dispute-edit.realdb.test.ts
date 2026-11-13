/**
 * Real-PostgreSQL proof of the #5061 follow-up (`INV-PAY-151`): an edit that
 * lowers the price of a booking whose card capture the cardholder disputes
 * issues no card refund and no account credit, and hands the reduction to the
 * treasurer - as the cancel does (`stripe-dispute-cancel.realdb.test.ts`).
 *
 * Through the REAL doors, which read the `StripeDispute` record under the
 * edit's locks (`applyPaymentAdjustments`, `editReductionDisputeHold`):
 *
 * - the date change, choosing account credit and choosing a card refund;
 * - the guest removal;
 * - the batch edit (a guest removed).
 *
 * Each, after a LOST dispute: no `MemberCredit` row, no Stripe refund call, no
 * recovery operation, nothing taken off the payment, and ONE hand-back task for
 * the reduction whose reason names the dispute. A WON dispute restores the
 * normal path: a credit edit credits the member's account and raises no task.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`. No
 * Stripe call is made: a refund would go to the harness's one shared
 * `@/lib/stripe` double (`support/stripe-race-double.ts`), which this file
 * makes throw.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/stripe-dispute-edit.realdb.test.ts
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-5061e-member";
const OFFICER_ID = "race-5061e-officer";
const LODGE_ID = "race-5061e-lodge";
const SEASON_ID = "race-5061e-season";
const BOOKING_ID = "race-5061e-booking";
const GUEST_A = "race-5061e-guest-a";
const GUEST_B = "race-5061e-guest-b";
const PAYMENT_ID = "race-5061e-payment";
const CARD_TXN = "race-5061e-txn-card";
const INTENT = "pi_race_5061e";
const DISPUTE_ID = "dp_race_5061e";

const TODAY = new Date("2026-07-01T00:00:00.000Z");
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);
const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];
const CHECK_OUT = "2026-08-04";
const RATE = 5_000;
/** Two guests, three nights each, at the season rate. */
const GUEST_CENTS = RATE * NIGHTS.length;
const PRICE_CENTS = 2 * GUEST_CENTS;
/** Dropping the last night for both guests. */
const SHORTENING_CENTS = 2 * RATE;

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("The race DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) {
    throw new Error("The race DB name must carry 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let removalService: typeof import("@/lib/booking-guest-removal-service");
let clubTimeServer: typeof import("@/lib/club-time/server");

(RUN ? describe : describe.skip)(
  "a disputed card capture is never refunded or credited by an edit - real PostgreSQL (#5061 follow-up)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      const modifications = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
      const credits = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { id: true } });
      const localIds = [PAYMENT_ID, BOOKING_ID, ...modifications.map((row) => row.id), ...credits.map((row) => row.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ targetId: BOOKING_ID }, { memberId: { in: [MEMBER_ID, OFFICER_ID] } }, { actorMemberId: { in: [MEMBER_ID, OFFICER_ID] } }] },
      });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.stripeDispute.deleteMany({ where: { stripeDisputeId: DISPUTE_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** A $300 PAID card booking: two guests, three nights each, confirmed in the ledger. */
    async function seedPaidBooking() {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: D(NIGHTS[0]!),
          checkOut: D(CHECK_OUT),
          status: "PAID",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
          hasNonMembers: true,
        },
      });
      for (const guestId of [GUEST_A, GUEST_B]) {
        await prisma.bookingGuest.create({
          data: {
            id: guestId,
            bookingId: BOOKING_ID,
            firstName: "Guest",
            lastName: guestId.slice(-1).toUpperCase(),
            ageTier: "ADULT",
            isMember: false,
            stayStart: D(NIGHTS[0]!),
            stayEnd: D(CHECK_OUT),
            priceCents: GUEST_CENTS,
            nights: { create: NIGHTS.map((day) => ({ stayDate: D(day), priceCents: RATE, priceSource: "SOLD" as const })) },
          },
        });
        for (const [index, day] of NIGHTS.entries()) {
          await prisma.bookingLedgerLine.create({
            data: {
              bookingId: BOOKING_ID,
              side: "CHARGE",
              kind: "GUEST_NIGHT",
              sign: 1,
              quantity: 1,
              unitCents: RATE,
              amountCents: RATE,
              bookingGuestId: guestId,
              nightStart: D(day),
              nightEndExclusive: D(NIGHTS[index + 1] ?? CHECK_OUT),
              ageTier: "ADULT",
              guestNames: [guestId],
              anchorKind: "CONFIRMATION",
              anchorId: BOOKING_ID,
              narration: "race 5061e confirmation",
              lodgeId: LODGE_ID,
              postingKey: `race-5061e-confirm-${guestId}-${day}`,
            },
          });
        }
      }
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRICE_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: INTENT },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: CARD_TXN,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: INTENT,
          amountCents: PRICE_CENTS,
          status: "SUCCEEDED",
          createdAt: D("2026-05-01"),
        },
      });
    }

    async function recordDispute(status: "LOST" | "WON") {
      const opened = D("2026-06-20");
      await prisma.stripeDispute.create({
        data: {
          stripeDisputeId: DISPUTE_ID,
          stripeChargeId: "ch_race_5061e",
          stripePaymentIntentId: INTENT,
          paymentTransactionId: CARD_TXN,
          paymentId: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          currency: "nzd",
          reason: "fraudulent",
          status,
          stripeStatus: status === "LOST" ? "lost" : "won",
          stripeCreatedAt: opened,
          lastEventCreatedAt: opened,
          stripeEventId: "evt_race_5061e",
        },
      });
    }

    async function shortenDates(settlementMethod: "card" | "credit") {
      return dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: NIGHTS[0]!, checkOut: NIGHTS[2]!, settlementMethod } as never,
        ipAddress: "127.0.0.1",
      });
    }

    async function removeGuest(settlementMethod: "card" | "credit") {
      return prisma.$transaction(
        (tx) =>
          removalService.removeBookingGuestInTransaction({
            tx,
            bookingId: BOOKING_ID,
            guestId: GUEST_B,
            actorMemberId: OFFICER_ID,
            actorRole: "ADMIN",
            today: TODAY,
            format: CLUB_FORMAT_TEST,
            journal: memberMoneyTestContext(),
            settlementMethod,
          }),
        { maxWait: 10_000, timeout: 20_000 },
      );
    }

    async function batchRemoveGuest(settlementMethod: "card" | "credit") {
      return batchService.modifyBookingBatch({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { removeGuestIds: [GUEST_B], settlementMethod } as never,
        ipAddress: "127.0.0.1",
        todayAtClub: (await clubTimeServer.clubTime()).today(),
        format: CLUB_FORMAT_TEST,
      });
    }

    /** The edit hands the whole reduction to the treasurer, naming the dispute, and moves no money. */
    async function expectHandedToTreasurer(reductionCents: number) {
      expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } })).toBe(0);
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      expect(await prisma.paymentRefund.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } }))
        .toEqual({ refundedAmountCents: 0 });
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "OPEN", paymentId: PAYMENT_ID, amountCents: reductionCents });
      expect(tasks[0]!.reason).toContain(DISPUTE_ID);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { finalPriceCents: true } }))
        .toEqual({ finalPriceCents: PRICE_CENTS - reductionCents });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      batchService = await import("@/lib/booking-batch-modification-service");
      dateService = await import("@/lib/booking-date-modification-service");
      removalService = await import("@/lib/booking-guest-removal-service");
      clubTimeServer = await import("@/lib/club-time/server");

      await deleteFixtures();
      for (const [id, role] of [
        [MEMBER_ID, Role.USER],
        [OFFICER_ID, Role.ADMIN],
      ] as const) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: id === MEMBER_ID ? "Disputed" : "Officer",
            lastName: "Card",
            ageTier: "ADULT",
            canLogin: true,
            role,
          },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5061e Lodge", slug: "race-5061e" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 20 } });
      // One tier, all of it back on either route: the reduction is the whole night's price.
      await prisma.cancellationPolicy.create({
        data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0 },
      });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.create({
        data: {
          id: SEASON_ID,
          name: "Race 5061e season",
          type: "WINTER",
          startDate: D("2026-06-01"),
          endDate: D("2026-09-30"),
          active: true,
          lodgeId: LODGE_ID,
          membershipTypeRates: {
            create: [
              { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: RATE },
              { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: RATE },
            ],
          },
        },
      });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      stripeRaceHooks.refund = async () => {
        throw new Error("#5061 follow-up: a disputed capture must never reach Stripe's refund call");
      };
      await deleteBookingRows();
      await seedPaidBooking();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("a lost dispute, then a date change choosing credit: no credit, and one treasurer task naming the dispute", async () => {
      await recordDispute("LOST");

      const result = await shortenDates("credit");

      expect(result).toMatchObject({ priceDiffCents: -SHORTENING_CENTS });
      await expectHandedToTreasurer(SHORTENING_CENTS);
    });

    it("a lost dispute, then a date change choosing a card refund: no Stripe refund, and one treasurer task", async () => {
      await recordDispute("LOST");

      const result = await shortenDates("card");

      expect(result).toMatchObject({ priceDiffCents: -SHORTENING_CENTS });
      await expectHandedToTreasurer(SHORTENING_CENTS);
    });

    it("a lost dispute, then a guest removal choosing credit: no credit, and one treasurer task", async () => {
      await recordDispute("LOST");

      const result = await removeGuest("credit");

      expect(result).toMatchObject({ refundHeldForDispute: true });
      await expectHandedToTreasurer(GUEST_CENTS);
    });

    it("a lost dispute, then a batch edit removing a guest: no credit, and one treasurer task", async () => {
      await recordDispute("LOST");

      await batchRemoveGuest("credit");

      await expectHandedToTreasurer(GUEST_CENTS);
    });

    it("a won dispute restores the normal path: a credit date change credits the account and raises no task", async () => {
      await recordDispute("WON");

      const result = await shortenDates("credit");

      expect(result).toMatchObject({ priceDiffCents: -SHORTENING_CENTS });
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
      const credits = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { amountCents: true } });
      expect(credits.reduce((sum, credit) => sum + credit.amountCents, 0)).toBe(SHORTENING_CENTS);
    });
  },
);
