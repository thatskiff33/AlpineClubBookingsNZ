/**
 * Real-PostgreSQL proof of #4357 (`INV-PAY-119`): every saved-card door charges
 * the booking's worth - its price plus a change fee recorded on its unsettled
 * payment - as the confirm-pending cron does.
 *
 * Before #4357 the cron charged worth (`savedCardChargeCents`), but the
 * charge-saved-method route and the officer's confirm-pending-guests route
 * charged the bare `finalPriceCents`. The settle admits only worth (or worth
 * less applied credit), so a booking carrying a change fee was charged short.
 *
 * EVERY STEP IS THE REAL CODE: the fee is recorded by the edit lifecycle's own
 * writer (`writeEditOnPayment`, on a payment with no primary invoice yet), each
 * door is its real route, and the settle is the real
 * `markBookingPaymentSucceeded` the routes call. Only Stripe is a double (the
 * harness's one `@/lib/stripe` double, whose off-session charge succeeds at the
 * amount asked) and the session is the harness's one `@/lib/auth` double.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`saved-card-charge-worth-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4357-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { resetStripeRaceHooks, stripeRaceHooks } from "@/lib/__tests__/support/stripe-race-double";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4357-owner";
const OFFICER_ID = "race-4357-officer";
const LODGE_ID = "race-4357-lodge";
const BOOKING_ID = "race-4357-booking";
const PAYMENT_ID = "race-4357-payment";
// Future against the frozen suite clock (1 July 2026).
const CHECK_IN = new Date("2026-09-15T00:00:00.000Z");
const NIGHT_2 = new Date("2026-09-16T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-17T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const PRICE_CENTS = 2 * NIGHT_CENTS;
const CHANGE_FEE_CENTS = 2_500;
const WORTH_CENTS = PRICE_CENTS + CHANGE_FEE_CENTS;

let prisma: PrismaClient;
let chargeRoute: typeof import("@/app/api/payments/charge-saved-method/route");
let confirmGuestsRoute: typeof import("@/app/api/admin/bookings/[id]/confirm-pending-guests/route");

async function clean(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ targetId: { in: [BOOKING_ID, PAYMENT_ID] } }, { memberId: { in: [OWNER_ID, OFFICER_ID] } }, { subjectMemberId: OWNER_ID }] },
  });
  await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  // #4627: the doors post journal batches bridged to these lines; release them first.
  await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.updateMany({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * A PENDING booking held for a non-member guest, its card saved through a
 * SetupIntent, and a change fee the edit lifecycle's writer recorded on its
 * still-unsettled payment.
 */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PENDING",
      hasNonMembers: true,
      nonMemberHoldUntil: new Date("2026-07-08T00:00:00.000Z"),
      totalPriceCents: PRICE_CENTS,
      finalPriceCents: PRICE_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      bookingId: BOOKING_ID,
      firstName: "Visiting",
      lastName: "Friend",
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
  const payment = await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: PRICE_CENTS,
      status: "PENDING",
      stripeCustomerId: "cus_race_4357",
      stripePaymentMethodId: "pm_race_4357",
      stripeSetupIntentId: "seti_race_4357",
    },
    select: { id: true, xeroInvoiceId: true },
  });
  const { writeEditOnPayment } = await import("@/lib/booking-primary-invoice-claim");
  await prisma.$transaction((tx) => writeEditOnPayment(tx, { payment, changeFeeCents: CHANGE_FEE_CENTS }));
}

/** Stripe's off-session charge succeeds at whatever amount the door asked for. */
function stripeChargesAsAsked(): number[] {
  const asked: number[] = [];
  stripeRaceHooks.charge = async (args) => {
    asked.push(args.amountCents);
    return {
      id: `pi_race_4357_${asked.length}`,
      object: "payment_intent",
      amount: args.amountCents,
      currency: "nzd",
      status: "succeeded",
      payment_method: args.paymentMethodId,
      latest_charge: `ch_race_4357_${asked.length}`,
      metadata: args.metadata ?? {},
    };
  };
  return asked;
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function expectSettledAtWorth(asked: number[], worthCents = WORTH_CENTS): Promise<void> {
  expect(asked).toEqual([worthCents]);
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { status: true, payment: { select: { status: true, amountCents: true, creditAppliedCents: true, changeFeeCents: true } } },
  });
  expect(booking.status).toBe("PAID");
  expect(booking.payment).toMatchObject({
    status: "SUCCEEDED",
    amountCents: worthCents,
    creditAppliedCents: 0,
    changeFeeCents: CHANGE_FEE_CENTS,
  });
  const captures = await prisma.paymentTransaction.findMany({
    where: { paymentId: PAYMENT_ID, status: "SUCCEEDED" },
    select: { amountCents: true },
  });
  expect(captures).toEqual([{ amountCents: worthCents }]);
}

(RUN ? describe : describe.skip)(
  "every saved-card door charges the booking's worth, change fee included - real PostgreSQL (#4357, INV-PAY-119)",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Saved-card charge worth");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      chargeRoute = await import("@/app/api/payments/charge-saved-method/route");
      confirmGuestsRoute = await import("@/app/api/admin/bookings/[id]/confirm-pending-guests/route");

      await clean();
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
      for (const [id, firstName, role] of [
        [OWNER_ID, "Owner", Role.USER],
        [OFFICER_ID, "Officer", Role.ADMIN],
      ] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName, lastName: "Proof", ageTier: "ADULT", canLogin: true, role },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4357 Lodge", slug: "race-4357" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    }, 120_000); // cold imports of both routes' module graphs

    beforeEach(async () => {
      await clean();
      raceSession.current = { user: { id: OFFICER_ID, role: "ADMIN", accessRoles: [{ role: "ADMIN" }], canLogin: true } };
      await seed();
    });

    afterEach(() => {
      resetStripeRaceHooks();
      raceSession.current = null;
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      raceSession.current = null;
      if (!prisma) return;
      await clean();
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
    });

    it("the fee is recorded on the unsettled payment by the edit lifecycle's own writer", async () => {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { changeFeeCents: true } });
      expect(payment.changeFeeCents).toBe(CHANGE_FEE_CENTS);
    });

    it("the charge-saved-method route charges worth and the settle takes it", async () => {
      const asked = stripeChargesAsAsked();
      const response = await json(
        await chargeRoute.POST(
          new Request("http://localhost/api/payments/charge-saved-method", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bookingId: BOOKING_ID }),
          }) as never,
        ),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      await expectSettledAtWorth(asked);
    });

    it("the officer's confirm-pending-guests route charges worth and the settle takes it", async () => {
      const asked = stripeChargesAsAsked();
      const response = await json(
        await confirmGuestsRoute.POST(
          new Request(`http://localhost/api/admin/bookings/${BOOKING_ID}/confirm-pending-guests`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notifyMember: false }),
          }) as never,
          { params: Promise.resolve({ id: BOOKING_ID }) },
        ),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "PAID", charged: true });
      await expectSettledAtWorth(asked);
    });

    it("a $0 price carrying a recorded change fee is charged the fee by the officer's route, never confirmed at no charge", async () => {
      // An edit that recorded a fee and left the price at $0 (a promo on the new dates).
      await prisma.bookingGuestNight.updateMany({ where: { bookingGuest: { bookingId: BOOKING_ID } }, data: { priceCents: 0 } });
      await prisma.bookingGuest.updateMany({ where: { bookingId: BOOKING_ID }, data: { priceCents: 0 } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 0, finalPriceCents: 0 } });
      const asked = stripeChargesAsAsked();
      const response = await json(
        await confirmGuestsRoute.POST(
          new Request(`http://localhost/api/admin/bookings/${BOOKING_ID}/confirm-pending-guests`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notifyMember: false }),
          }) as never,
          { params: Promise.resolve({ id: BOOKING_ID }) },
        ),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "PAID", charged: true });
      await expectSettledAtWorth(asked, CHANGE_FEE_CENTS);
    });

    // #4399: a booking worth $0 (no price, no fee) through each door.
    async function makeWorthZero(): Promise<void> {
      await prisma.bookingGuestNight.updateMany({ where: { bookingGuest: { bookingId: BOOKING_ID } }, data: { priceCents: 0 } });
      await prisma.bookingGuest.updateMany({ where: { bookingId: BOOKING_ID }, data: { priceCents: 0 } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { totalPriceCents: 0, finalPriceCents: 0 } });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 0 } });
    }

    it("#4399: charge-saved-method refuses a booking worth $0 before any claim or Stripe call", async () => {
      await makeWorthZero();
      const asked = stripeChargesAsAsked();
      const response = await json(
        await chargeRoute.POST(
          new Request("http://localhost/api/payments/charge-saved-method", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bookingId: BOOKING_ID }),
          }) as never,
        ),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(asked).toEqual([]);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PENDING");
      expect(await prisma.paymentTransaction.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
    });

    it("#4399: the officer's $0 confirm leaves the booking PAID with a SUCCEEDED $0 payment", async () => {
      await makeWorthZero();
      const asked = stripeChargesAsAsked();
      const response = await json(
        await confirmGuestsRoute.POST(
          new Request(`http://localhost/api/admin/bookings/${BOOKING_ID}/confirm-pending-guests`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notifyMember: false }),
          }) as never,
          { params: Promise.resolve({ id: BOOKING_ID }) },
        ),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "PAID", charged: false });
      expect(asked).toEqual([]);
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { id: BOOKING_ID },
        select: { status: true, payment: { select: { status: true, amountCents: true } } },
      });
      expect(booking).toEqual({ status: "PAID", payment: { status: "SUCCEEDED", amountCents: 0 } });
    });
  },
);
