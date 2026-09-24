import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CreditType } from "@prisma/client";

/**
 * #2265 (epic #2245, E1) — end-to-end behaviour of the stored credit election
 * across the two routes that matter.
 *
 * 1. `POST /api/bookings` with `draft: true` must REMEMBER the election instead
 *    of discarding it, and must not consume a cent of the member's balance.
 * 2. `POST /api/payments/create-payment-intent` must apply it when the draft
 *    becomes a real booking, charge the card the credit-reduced remainder, and
 *    report what it did.
 *
 * The credit ledger is real here — the pay-path tests drive the actual
 * `applyCreditToBooking` / `deriveBookingAppliedCreditCents` helpers against an
 * in-memory MemberCredit table, so the Stripe amount is derived exactly as
 * production derives it.
 */

type LedgerRow = {
  memberId: string;
  amountCents: number;
  type: CreditType;
  appliedToBookingId?: string | null;
};

const MEMBER_ID = "member-1";
const BOOKING_ID = "draft-2265";

const ledger: LedgerRow[] = [];

function aggregateLedger({ where }: { where: Record<string, unknown> }) {
  const matched = ledger.filter((row) => {
    if (where.memberId != null && row.memberId !== where.memberId) return false;
    if (
      where.appliedToBookingId != null &&
      row.appliedToBookingId !== where.appliedToBookingId
    ) {
      return false;
    }
    if (where.type != null && row.type !== where.type) return false;
    return true;
  });
  return {
    _sum: {
      amountCents: matched.reduce((sum, row) => sum + row.amountCents, 0),
    },
  };
}

const mocks = vi.hoisted(() => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
  upsertPaymentIntentTransaction: vi.fn(),
  // Async in production, so the mock must resolve — the route attaches a
  // .catch() to keep a queueing failure from 500-ing an already settled
  // booking, and a mock returning undefined would hide that.
  queueXeroInvoiceForPaidBooking: vi.fn().mockResolvedValue(undefined),
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  drainSupersededPrimaryIntents: vi.fn().mockResolvedValue(undefined),
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn(),
  markBookingPaymentSucceeded: vi.fn(),
}));

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(1),
  booking: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  payment: { upsert: vi.fn().mockResolvedValue({ id: "payment-2265" }) },
  memberCredit: {
    aggregate: vi.fn(aggregateLedger),
    create: vi.fn(async ({ data }: { data: LedgerRow }) => {
      ledger.push(data);
      return data;
    }),
  },
};

// #3599: the credit rows' ledger lines are posted by one sync, proved in its own
// suites and against Postgres; this suite tests what it always tested.
vi.mock("@/lib/booking-ledger-credit-sync", () => ({
  syncBookingLedgerCredits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    payment: { upsert: vi.fn().mockResolvedValue({ id: "payment-2265" }) },
    promoRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
    memberCredit: { aggregate: vi.fn(aggregateLedger) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_test" }),
  getPaymentIntent: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-1"),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations:
    mocks.queueSupersededPrimaryIntentCancellations,
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  drainSupersededPrimaryIntents: mocks.drainSupersededPrimaryIntents,
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
}));
vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: mocks.queueXeroInvoiceForPaidBooking,
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendBookingConfirmedEmail,
}));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// #2576 §9. Mocked at the module boundary, like the other collaborators this suite
// already stubs. The real seam reads the booking and the lodge policy through the
// CONFIRMING transaction's client, and this suite drives that transaction with a fake
// that carries only the delegates the money path itself needs — so without this the
// enqueue throws and the settlement fails. Failing closed is the correct production
// behaviour (§8 wants the obligation to commit WITH the transition), so the fixture is
// what changes. Whether an uncovered booking becomes an incident belongs to the hosting
// suites; that this path reaches a seam at all is pinned tree-wide by
// `adult-member-hosting-call-sites.test.ts`.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(async () => null),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));


import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  createPaymentIntent as stripeCreatePaymentIntent,
} from "@/lib/stripe";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";

const mockPrisma = prisma as unknown as {
  booking: { findUnique: ReturnType<typeof vi.fn> };
  payment: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};
const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockStripeCreatePaymentIntent =
  stripeCreatePaymentIntent as ReturnType<typeof vi.fn>;

const PRICE_CENTS = 10_000;

function makeDraft(creditElectionCents: number | null) {
  return {
    id: BOOKING_ID,
    memberId: MEMBER_ID,
    lodgeId: "lodge-1",
    status: "DRAFT",
    hasNonMembers: false,
    organiserSettled: false,
    totalPriceCents: PRICE_CENTS,
    finalPriceCents: PRICE_CENTS,
    discountCents: 0,
    promoAdjustmentCents: 0,
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    creditElectionCents,
    member: {
      id: MEMBER_ID,
      email: "aroha@example.com",
      firstName: "Aroha",
      lastName: "Ngata",
    },
    guests: [
      {
        id: "g1",
        priceCents: PRICE_CENTS,
        stayStart: null,
        stayEnd: null,
        nights: [
          {
            id: "g1-night-1",
            stayDate: new Date("2026-08-14"),
            priceCents: PRICE_CENTS / 2,
            priceSource: "SOLD",
          },
          {
            id: "g1-night-2",
            stayDate: new Date("2026-08-15"),
            priceCents: PRICE_CENTS / 2,
            priceSource: "SOLD",
          },
        ],
      },
    ],
    promoRedemption: null,
    nightAdjustments: [],
    payment: null,
  };
}

/** Net credit consumed by the booking under test. */
function appliedToBooking() {
  return -ledger
    .filter(
      (row) =>
        row.type === CreditType.BOOKING_APPLIED &&
        row.appliedToBookingId === BOOKING_ID,
    )
    .reduce((sum, row) => sum + row.amountCents, 0) || 0;
}

function memberBalance() {
  return ledger
    .filter((row) => row.memberId === MEMBER_ID)
    .reduce((sum, row) => sum + row.amountCents, 0) || 0;
}

function payRequest() {
  return new NextRequest(
    "http://localhost/api/payments/create-payment-intent",
    {
      method: "POST",
      body: JSON.stringify({ bookingId: BOOKING_ID }),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function arrangeDraft(booking: ReturnType<typeof makeDraft>, balanceCents: number) {
  ledger.length = 0;
  if (balanceCents > 0) {
    ledger.push({
      memberId: MEMBER_ID,
      amountCents: balanceCents,
      type: CreditType.CANCELLATION_REFUND,
      appliedToBookingId: null,
    });
  }

  const live = { ...booking };
  mockPrisma.booking.findUnique.mockResolvedValue(live);
  tx.booking.findUnique.mockImplementation(async () => ({
    ...live,
    guests: booking.guests,
  }));
  tx.booking.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(live, data);
      return { ...live };
    },
  );
  // Guarded claims: every key in `where` must match the row as it stands now,
  // so a test that moves the booking under the route sees count 0 the way
  // Postgres would.
  tx.booking.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matches = Object.entries(where).every(([key, value]) =>
        key === "id"
          ? value === BOOKING_ID
          : value === (live as Record<string, unknown>)[key],
      );
      if (!matches) return { count: 0 };
      Object.assign(live, data);
      return { count: 1 };
    },
  );
  mockPrisma.$transaction.mockImplementation(
    async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  return live;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.length = 0;
  mockAuth.mockResolvedValue({ user: { id: MEMBER_ID, roles: ["USER"] } });
  mocks.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    nightDetails: [],
  });
  mocks.queueSupersededPrimaryIntentCancellations.mockResolvedValue([]);
  mockStripeCreatePaymentIntent.mockResolvedValue({
    id: "pi_test",
    client_secret: "secret_test",
  });
  mockPrisma.payment.upsert.mockResolvedValue({ id: "payment-2265" });
  tx.payment.upsert.mockResolvedValue({ id: "payment-2265" });
});

describe("#2265 the pay step honours the election made when the draft was saved", () => {
  it("applies the stored election and charges the card only the remainder", async () => {
    const live = arrangeDraft(makeDraft(3_000), 20_000);

    const res = await createPaymentIntentRoute(payRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    // The card is charged the credit-reduced amount, not the full price.
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_000 }),
    );
    expect(data.chargedAmountCents).toBe(7_000);

    // The ledger moved by exactly the elected amount.
    expect(appliedToBooking()).toBe(3_000);
    expect(memberBalance()).toBe(17_000);

    // The booking advanced and the election is spent, so a retry cannot
    // apply it a second time.
    expect(live.status).toBe("PAYMENT_PENDING");
    expect(live.creditElectionCents).toBeNull();

    // The Payment mirror keeps amountCents + creditAppliedCents = price.
    expect(mockPrisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          amountCents: 7_000,
          creditAppliedCents: 3_000,
        }),
      }),
    );

    // And the member is told what happened to their credit.
    expect(data.creditElection).toMatchObject({
      requestedCents: 3_000,
      appliedCents: 3_000,
      shortfallCents: 0,
      shortfallReason: "none",
    });
  });

  it("clamps to the balance the member actually has left, and says so in the response", async () => {
    arrangeDraft(makeDraft(8_000), 3_000);

    const res = await createPaymentIntentRoute(payRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(appliedToBooking()).toBe(3_000);
    expect(memberBalance()).toBe(0);
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_000 }),
    );
    expect(data.creditElection).toMatchObject({
      requestedCents: 8_000,
      appliedCents: 3_000,
      shortfallCents: 5_000,
      shortfallReason: "balance",
    });
  });

  it("settles a fully credit-covered booking at $0 instead of dead-ending it", async () => {
    // Before #2265 this booking could not exist; if it had, the pay route's
    // effective-price guard would have refused it with a 400 and the member
    // would have had no way to complete their own booking.
    const live = arrangeDraft(makeDraft(PRICE_CENTS), 20_000);

    const res = await createPaymentIntentRoute(payRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.alreadyPaid).toBe(true);
    expect(data.status).toBe("PAID");
    expect(data.clientSecret).toBeUndefined();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();

    expect(live.status).toBe("PAID");
    expect(appliedToBooking()).toBe(PRICE_CENTS);
    expect(memberBalance()).toBe(10_000);

    // $0 SUCCEEDED payment mirroring the credit, on the transaction handle.
    expect(tx.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          amountCents: 0,
          creditAppliedCents: PRICE_CENTS,
          status: "SUCCEEDED",
        }),
      }),
    );

    // The member hears about it and the club invoices it.
    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalled();
    expect(mocks.queueXeroInvoiceForPaidBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID }),
    );
    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "MEMBER_PAID", amountCents: 0 }),
    );
  });

  it("leaves a draft with no election exactly as it behaved before", async () => {
    const live = arrangeDraft(makeDraft(null), 20_000);

    const res = await createPaymentIntentRoute(payRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: PRICE_CENTS }),
    );
    expect(data.creditElection).toBeNull();
    expect(appliedToBooking()).toBe(0);
    expect(memberBalance()).toBe(20_000);
    expect(live.status).toBe("PAYMENT_PENDING");
  });

  it("consumes an election on a booking an admin released from review", async () => {
    // A draft that trips the no-adult rule is created in AWAITING_REVIEW and is
    // released straight to PAYMENT_PENDING, never passing through DRAFT at the
    // pay step. Its election must still be honoured.
    const live = arrangeDraft(
      { ...makeDraft(2_500), status: "PAYMENT_PENDING" },
      20_000,
    );

    const res = await createPaymentIntentRoute(payRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(appliedToBooking()).toBe(2_500);
    expect(live.creditElectionCents).toBeNull();
    expect(data.creditElection).toMatchObject({ appliedCents: 2_500 });
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 7_500 }),
    );
    // This arm can settle the booking at $0, so it claims capacity like every
    // other settle path rather than settling on trust.
    expect(mocks.checkCapacityForGuestRanges).toHaveBeenCalled();
  });

  it("refuses a released booking whose beds are gone, without spending the election", async () => {
    const live = arrangeDraft(
      { ...makeDraft(2_500), status: "PAYMENT_PENDING" },
      20_000,
    );
    mocks.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [],
    });

    const res = await createPaymentIntentRoute(payRequest());

    expect(res.status).toBe(409);
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
    // The election is untouched, so the member can pay once beds free up.
    expect(live.creditElectionCents).toBe(2_500);
    expect(appliedToBooking()).toBe(0);
    expect(memberBalance()).toBe(20_000);
  });

  it("settles an over-capacity booking that carries a persisted override", async () => {
    const live = arrangeDraft(
      {
        ...makeDraft(PRICE_CENTS),
        status: "PAYMENT_PENDING",
        capacityOverriddenAt: new Date("2026-07-01"),
      } as ReturnType<typeof makeDraft>,
      20_000,
    );
    mocks.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [],
    });

    const res = await createPaymentIntentRoute(payRequest());
    const data = await res.json();

    // #1771: an admin deliberately admitted this booking above the ceiling, so
    // a payment-time re-check must settle it, not refuse it.
    expect(res.status).toBe(200);
    expect(data.alreadyPaid).toBe(true);
    expect(live.status).toBe("PAID");
    expect(appliedToBooking()).toBe(PRICE_CENTS);
    // PAYMENT_PENDING -> PAID is a status claim like any other, so the beds are
    // reconciled against the final status, as markBookingPaymentSucceeded does.
    expect(mocks.reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: BOOKING_ID }),
    );
  });

  it("settles a draft repriced to nothing instead of stranding it unpayable", async () => {
    // The price can move between the member rendering the pay step and clicking
    // it. The transition used to commit first and only then hit the "nothing to
    // charge" guard, which 400s — leaving a booking that had left DRAFT and
    // could never be paid.
    const live = arrangeDraft(
      { ...makeDraft(null), finalPriceCents: 0 },
      20_000,
    );

    const res = await createPaymentIntentRoute(payRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.alreadyPaid).toBe(true);
    expect(data.status).toBe("PAID");
    expect(live.status).toBe("PAID");
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
    // Nothing was owed, so nothing was taken from the member's balance.
    expect(memberBalance()).toBe(20_000);
  });

  it("bails rather than resurrect a draft a cancel took while it was paying", async () => {
    const live = arrangeDraft(makeDraft(3_000), 20_000);
    // The transaction's post-lock re-read sees the cancel that landed first.
    tx.booking.findUnique.mockImplementation(async () => ({
      ...live,
      status: "CANCELLED",
      guests: [{ id: "g1" }],
    }));

    const res = await createPaymentIntentRoute(payRequest());

    expect(res.status).toBe(409);
    expect(live.status).toBe("DRAFT");
    expect(appliedToBooking()).toBe(0);
    expect(memberBalance()).toBe(20_000);
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });
});
