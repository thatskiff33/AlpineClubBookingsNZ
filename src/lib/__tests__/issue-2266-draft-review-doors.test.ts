import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #2266 (HIGH-1 defence in depth) — the review invariant is enforced at the
// DOORS, not only at the writers. A DRAFT carrying an unresolved admin review
// (requiresAdminReview with a non-APPROVED adminReviewStatus) must be refused
// by BOTH ways a draft becomes real money:
//
//  1. POST /api/bookings/[id]/confirm-draft   (the $0 confirm)
//  2. POST /api/payments/create-payment-intent (the pay step's DRAFT arm)
//
// The writers now park review-flagged drafts to AWAITING_REVIEW (create
// parity), so this state should no longer be creatable — these tests pin the
// fail-closed behaviour for any writer bug or legacy row, completing the lens
// scenario: own-guest removal leaves the booking minors-only, and neither the
// $0 confirm nor the pay attempt may land it PAID with review PENDING.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  hasAdminAccess: vi.fn(),
  prismaBookingFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  txBookingFindUnique: vi.fn(),
  txBookingUpdateMany: vi.fn(),
  txBookingUpdate: vi.fn(),
  txPaymentCreate: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  consumeStoredCreditElection: vi.fn(),
}));

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(1),
  booking: {
    findUnique: mocks.txBookingFindUnique,
    updateMany: mocks.txBookingUpdateMany,
    update: mocks.txBookingUpdate,
  },
  payment: { create: mocks.txPaymentCreate, upsert: vi.fn() },
};

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
// #2576 §9 widened this module's import graph: the path under test now reaches the
// hosting coverage drain, which pulls in the incident and email modules. Exports this
// partial mock never had to provide became reachable, so it spreads `importOriginal`
// over the real module and overrides only what it actually stubs — which is the shape
// that cannot break again the next time an edge is added.
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-roles")>()),
  hasAdminAccess: mocks.hasAdminAccess,
}));

// #2576 §9. Confirming a draft IS a confirmation, so the route now runs the shared
// hosting evaluator immediately before the PAID claim — and the evaluator reads the
// lodge policy through the claim's transaction client, which this suite drives with a
// fake carrying only the draft-review delegates. Mocked at the module boundary rather
// than widened, because this file's subject is the #2266 review doors; the hosting
// refusal on this route is pinned by `adult-member-hosting-call-sites.test.ts` (which
// asserts the route both uses the seam and catches its refusal above the generic
// branch) and by the hosting suites themselves.
vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adult-member-hosting-review")>()),
  reconcileAdultMemberHostingReviewWithSiblings: vi.fn(async () => ({
    action: "none" as const,
    violation: null,
    mode: null,
  })),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.prismaBookingFindUnique },
    payment: { upsert: vi.fn().mockResolvedValue({ id: "payment-1" }) },
    promoRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: mocks.prismaTransaction,
  },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-1"),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi
    .fn()
    .mockResolvedValue({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  getMembershipTypeBookingPolicyErrorBody: vi.fn(),
  MembershipTypeBookingPolicyError: class extends Error {},
  requiresPaidSubscriptionForMemberForBooking: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: vi.fn().mockResolvedValue(undefined),
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn().mockResolvedValue(undefined),
}));
// create-payment-intent extras
vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_test" }),
  getPaymentIntent: vi.fn(),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: vi.fn(),
}));
vi.mock("@/lib/booking-payment-flow", () => ({
  canCreateImmediatePaymentIntent: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
}));
vi.mock("@/lib/booking-status", () => ({
  bookingHasCapacityOverride: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  drainSupersededPrimaryIntents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/booking-credit-election", () => ({
  consumeStoredCreditElection: mocks.consumeStoredCreditElection,
  settleFullyCreditCoveredBooking: vi.fn(),
  CreditCoveredSettlementConflictError: class extends Error {},
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: vi.fn().mockResolvedValue(null),
}));

import { POST as confirmDraftRoute } from "@/app/api/bookings/[id]/confirm-draft/route";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";

const MEMBER_ID = "member-1";
const BOOKING_ID = "draft-2266";

function flaggedDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    memberId: MEMBER_ID,
    lodgeId: "lodge-1",
    status: "DRAFT",
    hasNonMembers: false,
    organiserSettled: false,
    finalPriceCents: 0,
    discountCents: 0,
    promoAdjustmentCents: 0,
    checkIn: new Date("2026-08-14"),
    checkOut: new Date("2026-08-16"),
    creditElectionCents: null,
    draftExpiresAt: new Date("2026-08-01"),
    // The lens state: minors-only edit tripped the rule but a (hypothetical)
    // writer bug left the booking DRAFT instead of parking it.
    requiresAdminReview: true,
    adminReviewStatus: "PENDING",
    member: {
      id: MEMBER_ID,
      email: "aroha@example.com",
      firstName: "Aroha",
      lastName: "Ngata",
      ageTier: "ADULT",
    },
    guests: [{ id: "g1" }],
    payment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: MEMBER_ID, roles: ["USER"] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.hasAdminAccess.mockReturnValue(false);
  mocks.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    nightDetails: [],
  });
  mocks.prismaTransaction.mockImplementation(
    async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.txBookingUpdateMany.mockResolvedValue({ count: 1 });
});

function confirmRequest() {
  return new NextRequest(
    `http://localhost/api/bookings/${BOOKING_ID}/confirm-draft`,
    { method: "POST" },
  );
}

function payRequest() {
  return new NextRequest("http://localhost/api/payments/create-payment-intent", {
    method: "POST",
    body: JSON.stringify({ bookingId: BOOKING_ID }),
    headers: { "Content-Type": "application/json" },
  });
}

describe("#2266 door 1 — confirm-draft refuses an unresolved review", () => {
  it("refuses a $0 confirm on a review-PENDING draft, writing nothing", async () => {
    mocks.prismaBookingFindUnique.mockResolvedValue(flaggedDraft());

    const res = await confirmDraftRoute(confirmRequest(), {
      params: Promise.resolve({ id: BOOKING_ID }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/admin review/i);
    // The refusal happens at the door: no transaction, no payment, no status.
    expect(mocks.prismaTransaction).not.toHaveBeenCalled();
    expect(mocks.txPaymentCreate).not.toHaveBeenCalled();
  });

  it("also refuses a review-REJECTED draft (fail closed on any non-APPROVED state)", async () => {
    mocks.prismaBookingFindUnique.mockResolvedValue(
      flaggedDraft({ adminReviewStatus: "REJECTED" }),
    );

    const res = await confirmDraftRoute(confirmRequest(), {
      params: Promise.resolve({ id: BOOKING_ID }),
    });

    expect(res.status).toBe(409);
  });

  it("still confirms an APPROVED-review $0 draft (the review is resolved)", async () => {
    const draft = flaggedDraft({ adminReviewStatus: "APPROVED" });
    mocks.prismaBookingFindUnique.mockResolvedValue(draft);
    mocks.txBookingFindUnique.mockResolvedValue({
      ...draft,
      guests: [{ id: "g1", nights: [] }],
    });
    mocks.txBookingUpdate.mockResolvedValue(draft);
    mocks.txPaymentCreate.mockResolvedValue({ id: "pay-1" });

    const res = await confirmDraftRoute(confirmRequest(), {
      params: Promise.resolve({ id: BOOKING_ID }),
    });

    expect(res.status).toBe(200);
    expect(mocks.txBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
  });
});

describe("#2266 door 2 — create-payment-intent's DRAFT arm refuses an unresolved review", () => {
  it("refuses the pay attempt with a 409 and advances nothing", async () => {
    const draft = flaggedDraft({ finalPriceCents: 10_000 });
    mocks.prismaBookingFindUnique.mockResolvedValue(draft);
    mocks.txBookingFindUnique.mockResolvedValue({
      ...draft,
      guests: [{ id: "g1", nights: [] }],
    });

    const res = await createPaymentIntentRoute(payRequest());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/admin review/i);
    // The DRAFT -> PAYMENT_PENDING claim never ran and no election was
    // consumed: the member's credit stays untouched behind the refusal.
    expect(mocks.txBookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.consumeStoredCreditElection).not.toHaveBeenCalled();
  });

  it("lets an APPROVED-review draft proceed to the DRAFT -> PAYMENT_PENDING claim", async () => {
    const draft = flaggedDraft({
      finalPriceCents: 10_000,
      adminReviewStatus: "APPROVED",
    });
    mocks.prismaBookingFindUnique.mockResolvedValue(draft);
    mocks.txBookingFindUnique.mockResolvedValue({
      ...draft,
      guests: [{ id: "g1", nights: [] }],
    });
    mocks.consumeStoredCreditElection.mockResolvedValue(null);
    const { createPaymentIntent } = await import("@/lib/stripe");
    (createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pi_test",
      client_secret: "secret_test",
    });

    const res = await createPaymentIntentRoute(payRequest());

    expect(res.status).toBe(200);
    expect(mocks.txBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID, status: "DRAFT" },
        data: expect.objectContaining({ status: "PAYMENT_PENDING" }),
      }),
    );
  });
});
