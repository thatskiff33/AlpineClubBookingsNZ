import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacity: vi.fn(),
  chargePaymentMethod: vi.fn(),
  markBookingPaymentSucceeded: vi.fn(),
  reconcile: vi.fn(),
  enqueueHosting: vi.fn(),
  settleHosting: vi.fn(),
  enqueueXero: vi.fn(),
  kickXero: vi.fn(),
  sendConfirmedEmail: vi.fn(),
  sendPaymentFailureAlert: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
  // #2576: no hosting policy row, so the rule resolves off and the coverage
  // machinery is a no-op. Present because the production path reads them.
  adultMemberHostingPolicyFindMany: vi.fn().mockResolvedValue([]),
  hostingCoverageReevaluationCreate: vi.fn().mockResolvedValue({ id: "hcr_1" }),
  hostingCoverageReevaluationFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
    },
    payment: { upsert: mocks.paymentUpsert },
    // #2576 §8: the post-commit drain reads this and finds nothing.
    hostingCoverageReevaluation: {
      findMany: mocks.hostingCoverageReevaluationFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  // #172/#1881 — the capacity-claiming branches take the per-lodge lock (under
  // the global lock(1)) so the re-check serialises against per-lodge creators.
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacity,
}));
vi.mock("@/lib/stripe", () => ({ chargePaymentMethod: mocks.chargePaymentMethod }));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcile,
  reconcileBedAllocationsForBookingWithGlobalLockHeld: mocks.reconcile,
  reconcileBedAllocationsForBookingWithLodgeLockHeld: mocks.reconcile,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: mocks.enqueueHosting,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHosting,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXero,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendConfirmedEmail,
  sendAdminPaymentFailureAlert: mocks.sendPaymentFailureAlert,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
}));
vi.mock("@/lib/audit", () => ({
  createStructuredAuditLog: mocks.createStructuredAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/confirm-pending-guests/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

const params = Promise.resolve({ id: "b1" });

// Transaction client the route receives inside prisma.$transaction. Reuses the
// same underlying mocks so assertions on booking.updateMany / payment.upsert
// see the calls made inside the advisory-locked transaction too.
const txClient = {
  $executeRaw: mocks.executeRaw,
  booking: {
    findUnique: mocks.bookingFindUnique,
    update: mocks.bookingUpdate,
    updateMany: mocks.bookingUpdateMany,
  },
  payment: { upsert: mocks.paymentUpsert },
  // #2576 §9: the officer's confirmation records the bounded same-owner hosting
  // re-evaluation inside this transaction. No policy row, so the rule resolves off
  // and the enqueue is a no-op — which is what every expectation here assumes.
  adultMemberHostingPolicy: { findMany: mocks.adultMemberHostingPolicyFindMany },
  hostingCoverageReevaluation: {
    create: mocks.hostingCoverageReevaluationCreate,
  },
};

function makeRequest(body?: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/admin/bookings/b1/confirm-pending-guests",
    {
      method: "POST",
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  );
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    status: "PENDING",
    hasNonMembers: true,
    nonMemberHoldUntil: new Date("2026-07-08"),
    checkIn: new Date("2026-07-15"),
    checkOut: new Date("2026-07-17"),
    finalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "m@example.com", firstName: "Pat", lastName: "Lee" },
    guests: [{ id: "g1" }, { id: "g2" }],
    // #3269: a saved card is customer + pm + the SetupIntent that saved it.
    payment: {
      stripePaymentMethodId: "pm_1",
      stripeCustomerId: "cus_1",
      stripeSetupIntentId: "seti_1",
    },
    parentBooking: null,
    promoRedemption: null,
    ...overrides,
  };
}

const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };
const FULL = {
  available: false,
  minAvailable: -1,
  nightDetails: [
    {
      date: new Date("2026-07-15T00:00:00.000Z"),
      occupiedBeds: 25,
      availableBeds: -1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  });
  mocks.getAuditRequestContext.mockReturnValue({});
  mocks.createStructuredAuditLog.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
  mocks.enqueueHosting.mockResolvedValue(undefined);
  mocks.settleHosting.mockResolvedValue(undefined);
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({ id: "pay1" });
  mocks.sendPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.executeRaw.mockResolvedValue(1);
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  // Default: capacity is available. Each test that needs a full lodge overrides.
  mocks.checkCapacity.mockResolvedValue(AVAILABLE);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(txClient)
  );
  mocks.enqueueXero.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue({});
  mocks.sendConfirmedEmail.mockResolvedValue(undefined);
});

describe("POST /api/admin/bookings/[id]/confirm-pending-guests", () => {
  it("returns the fixed 409 before charging when the participant fence contends", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.enqueueHosting.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(makeRequest(), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.sendPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("charges the saved card and confirms to PAID, clearing the hold", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "PAID", charged: true });
    // #1881 two-tier protocol (on top of #172's per-lodge lock): the
    // capacity-claiming charge branch takes BOTH locks — the global
    // pg_advisory_xact_lock(1) FIRST, then the per-lodge capacity lock (keyed
    // on the booking's lodgeId, on the same tx client the capacity re-check
    // uses) — so the claim serialises against both status/money transitions
    // and per-lodge creators.
    expect(mocks.executeRaw).toHaveBeenCalled();
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(txClient, "lodge-1");
    // Lock order: the global lock(1) is taken BEFORE the per-lodge lock, which
    // is taken BEFORE the capacity re-check, all inside the same tx.
    expect(
      mocks.executeRaw.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]);
    expect(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.checkCapacity.mock.invocationCallOrder[0]);
    // The pre-charge capacity re-check runs under those locks.
    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      "lodge-1",
      expect.any(Date),
      expect.any(Date),
      expect.any(Array),
      "b1",
      txClient
    );
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10000, idempotencyKey: "pending_charge_b1" })
    );
    // Claim-first (#1418): capacity is claimed as CONFIRMED (hold cleared)
    // BEFORE Stripe is touched, mirroring the cron.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CONFIRMED", nonMemberHoldUntil: null },
    });
    expect(
      mocks.bookingUpdateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.chargePaymentMethod.mock.invocationCallOrder[0]);
    // The captured charge is durably recorded before reconciliation.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay1",
        paymentIntentId: "pi_1",
        amountCents: 10000,
        status: "SUCCEEDED",
      })
    );
    expect(
      mocks.upsertPaymentIntentTransaction.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.markBookingPaymentSucceeded.mock.invocationCallOrder[0]);
    expect(mocks.createStructuredAuditLog).toHaveBeenCalled();
    // The booking's OWN saved card is charged; the claim writes only the
    // customer onto its row (#3269 — a pm write-back would race the
    // setup-intent route's replacement mint and resurrect a cleared card).
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_1", paymentMethodId: "pm_1" })
    );
    const ownUpsertArgs = mocks.paymentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(ownUpsertArgs.create).toMatchObject({ stripeCustomerId: "cus_1" });
    expect(ownUpsertArgs.update).toMatchObject({ stripeCustomerId: "cus_1" });
    expect(Object.keys(ownUpsertArgs.create)).not.toContain("stripePaymentMethodId");
    expect(Object.keys(ownUpsertArgs.update)).not.toContain("stripePaymentMethodId");
  });

  // #3269 / INV-PAY-053: the route asks the same question the cron asks — "may
  // this card be charged off-session?" — and answers it by SetupIntent
  // provenance, on the child's own row first and then the split parent's.
  describe("saved-card provenance (#3269)", () => {
    const ONE_OFF_CHECKOUT_CARD = {
      stripeCustomerId: "cus_oneoff",
      stripePaymentMethodId: "pm_oneoff",
      stripeSetupIntentId: null,
    };
    const PARENT_SETUP_INTENT_CARD = {
      stripeCustomerId: "cus_parent",
      stripePaymentMethodId: "pm_parent",
      stripeSetupIntentId: "seti_parent",
    };

    it("moves a booking whose only card came from a one-off checkout to payment-owed instead of charging it", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ payment: ONE_OFF_CHECKOUT_CARD })
      );

      const res = await POST(makeRequest(), { params });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
      expect(mocks.paymentUpsert).not.toHaveBeenCalled();
    });

    it("charges a split child on its parent's SetupIntent-saved card without copying that card onto the child's row", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({
          payment: null,
          parentBooking: { id: "parent-1", payment: PARENT_SETUP_INTENT_CARD },
        })
      );
      mocks.chargePaymentMethod.mockResolvedValue({
        id: "pi_parent_card",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_parent",
      });
      mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

      const res = await POST(makeRequest(), { params });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, status: "PAID", charged: true });
      // The route can only answer for a split child if it LOADS the parent's
      // payment row — the mock above returns it regardless, so pin the query.
      expect(mocks.bookingFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            payment: true,
            parentBooking: { include: { payment: true } },
          }),
        })
      );
      expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cus_parent",
          paymentMethodId: "pm_parent",
          idempotencyKey: "pending_charge_b1",
        })
      );
      // The claim writes the customer the child is charged under, and NOT the
      // parent's pm: the key is absent from both arms of the upsert.
      const upsertArgs = mocks.paymentUpsert.mock.calls[0][0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(upsertArgs.create).toMatchObject({ stripeCustomerId: "cus_parent" });
      expect(upsertArgs.update).toMatchObject({ stripeCustomerId: "cus_parent" });
      expect(Object.keys(upsertArgs.create)).not.toContain("stripePaymentMethodId");
      expect(Object.keys(upsertArgs.update)).not.toContain("stripePaymentMethodId");
      // The pre-reconciliation transaction record names the customer charged.
      expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: "cus_parent" })
      );
    });

    it("does not borrow a parent's one-off checkout card: payment-owed, never a charge Stripe would refuse", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({
          payment: null,
          parentBooking: { id: "parent-1", payment: ONE_OFF_CHECKOUT_CARD },
        })
      );

      const res = await POST(makeRequest(), { params });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
      expect(mocks.paymentUpsert).not.toHaveBeenCalled();
    });

    it("prefers the child's own SetupIntent card over the parent's", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({
          parentBooking: { id: "parent-1", payment: PARENT_SETUP_INTENT_CARD },
        })
      );
      mocks.chargePaymentMethod.mockResolvedValue({
        id: "pi_own",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_1",
      });
      mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

      const res = await POST(makeRequest(), { params });

      expect(res.status).toBe(200);
      expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cus_1", paymentMethodId: "pm_1" })
      );
    });
  });

  it("does not charge when capacity is full, returning 409 CAPACITY_EXCEEDED", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-15"],
    });
    // Gated before Stripe: the card is never touched on a full lodge.
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("charges past a full lodge when allowOverbook is set", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(FULL);
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: true });
    expect(mocks.chargePaymentMethod).toHaveBeenCalled();
    // #1771: claiming CONFIRMED over the ceiling stamps the persisted override
    // with the acting admin, so the later markBookingPaymentSucceeded re-check
    // never cancels the deliberately-admitted booking.
    const confirmClaim = mocks.bookingUpdateMany.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === "CONFIRMED"
    );
    const confirmData = (confirmClaim?.[0] as { data: Record<string, unknown> }).data;
    expect(confirmData.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(confirmData.capacityOverriddenByMemberId).toBe("admin1");
  });

  // ADR-001 decision 5 (issue #118): an exclusive whole-lodge hold on the target
  // nights is NOT bypassable — even with allowOverbook the confirm is refused,
  // before any CONFIRMED claim, Stripe charge, or $0 PAID advance.
  const HELD = {
    available: false,
    minAvailable: 0,
    nightDetails: [
      {
        date: new Date("2026-07-15T00:00:00.000Z"),
        occupiedBeds: 4,
        // Pinned to 0 (never negative) so it never appears in overbookDates.
        availableBeds: 0,
        wholeLodgeHeld: true,
      },
    ],
  };

  it("refuses the charge branch with 409 WHOLE_LODGE_HOLD_BLOCKED even with allowOverbook, never charging or claiming", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(HELD);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.blockedNights).toEqual(["2026-07-15"]);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("refuses the $0 branch with 409 WHOLE_LODGE_HOLD_BLOCKED even with allowOverbook, never advancing to PAID", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(HELD);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.blockedNights).toEqual(["2026-07-15"]);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
  });

  // #1418: charge captured, then reconciliation throws (e.g. transient DB
  // failure or a concurrent status change). The captured money must never go
  // silent: the transaction row is already durably recorded (webhook can
  // finish the promotion), the claim keeps holding the beds, and admins are
  // alerted.
  it("alerts and leaves the booking claimed when reconciliation fails after a captured charge (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new Error("Booking is not payable from status CANCELLED")
    );

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      paymentReceived: true,
      finalisationPending: true,
    });
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(body.error).toContain("charge succeeded");
    // The captured charge was durably recorded BEFORE reconciliation ran.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_1", status: "SUCCEEDED" })
    );
    // Admins are alerted with the intent id.
    expect(mocks.sendPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_1",
        amountCents: 10000,
        errorMessage: expect.stringContaining("captured"),
      })
    );
    // The claim is NOT released — CONFIRMED keeps holding the paid-for beds.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING" }),
      })
    );
    // No confirmation email for an unfinalised booking.
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
  });

  it("keeps captured-payment recovery intact and returns the fixed participant 409", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_hosting_retry",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(makeRequest(), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
      finalisationPending: true,
    });
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_hosting_retry",
        status: "SUCCEEDED",
      }),
    );
    expect(mocks.sendPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_hosting_retry" }),
    );
    expect(mocks.createStructuredAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          outcome: "charged_finalisation_pending",
        }),
      }),
    );
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
  });

  it("releases the claim and alerts when the Stripe charge itself fails (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockRejectedValue(new Error("card_declined"));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("charge failed");
    // Claim released: CONFIRMED -> PENDING with the original hold restored.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: new Date("2026-07-08"),
      },
    });
    // #172: BOTH transactions on this path — the claim and the release —
    // serialise on the per-lodge capacity lock keyed on the booking's lodgeId,
    // on the same tx client. The release must re-lock, not run unserialised.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledTimes(2);
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenNthCalledWith(1, txClient, "lodge-1");
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenNthCalledWith(2, txClient, "lodge-1");
    // The release-tx lock is acquired before the CONFIRMED -> PENDING revert.
    const releaseRevertOrder = mocks.bookingUpdateMany.mock.calls.findIndex(
      (c) => (c[0] as { where: { status?: string } }).where.status === "CONFIRMED"
    );
    expect(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[1]
    ).toBeLessThan(
      mocks.bookingUpdateMany.mock.invocationCallOrder[releaseRevertOrder]
    );
    expect(mocks.sendPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        errorMessage: "card_declined",
      })
    );
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("releases the claim without alerting when the card needs further authorisation (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "requires_action",
      amount: 10000,
      payment_method: "pm_1",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ paymentStatus: "requires_action" });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: new Date("2026-07-08"),
      },
    });
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.sendPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("reports the auto-refund accurately when the final capacity claim fails (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "cancelled_refunded",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("refunded in full");
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
  });

  it("reports durable refund recovery after a capacity-failed charge cancels the booking (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "cancelled_refund_failed",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: "CANCELLED",
      refunded: false,
      refundRecoveryPending: true,
      paymentReceived: true,
    });
    expect(body.error).toContain("automatic refund recovery is pending");
    expect(body).not.toHaveProperty("finalisationPending");
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
  });

  // #1992 — this route's charge can lose the settlement race to a different
  // capture (e.g. the member paid an in-flight /pay link intent in the same
  // window): the reconciler auto-refunds THIS route's duplicate charge while
  // the booking stays settled by the other capture. That is a finalised
  // booking, not a failure — a 500 "could not be finalised" here was
  // inaccurate.
  it("reports a duplicate charge accurately: booking settled by the other capture, this charge auto-refunded — not a 500 (#1992)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_dup",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "duplicate_capture_refunded",
      bookingId: "b1",
      bumpedBookingIds: [],
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "PAID",
      charged: false,
      duplicateChargeRefunded: true,
    });
    expect(body.message).toContain("automatically refunded");
    // The settling capture's path already sent the confirmation email and
    // queued the Xero invoice — the duplicate outcome repeats neither.
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
    expect(mocks.createStructuredAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          outcome: "charged_duplicate_capture_refunded",
        }),
      })
    );
  });

  it("reports the queued-refund variant accurately when the duplicate's inline refund failed (#1992)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_dup",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "duplicate_capture_refund_failed",
      bookingId: "b1",
      bumpedBookingIds: [],
      refundError: "Stripe is unavailable (503)",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: "PAID",
      charged: false,
      duplicateChargeRefunded: false,
    });
    expect(body.message).toContain("queued");
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
  });

  it("moves a no-card (request-origin) booking to payment-owed without charging or capacity gate", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ payment: null }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING", nonMemberHoldUntil: null },
    });
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    // PAYMENT_PENDING is not capacity-holding, so no capacity re-check runs.
    expect(mocks.checkCapacity).not.toHaveBeenCalled();
  });

  it("confirms a $0 booking to PAID without charging when capacity is available", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: false });
    // #172: the $0 promote transaction serialises on the per-lodge capacity
    // lock keyed on the booking's lodgeId, on the same tx client.
    expect(mocks.acquireLodgeCapacityLock).toHaveBeenCalledWith(txClient, "lodge-1");
    expect(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.checkCapacity.mock.invocationCallOrder[0]);
    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      "lodge-1",
      expect.any(Date),
      expect.any(Date),
      expect.any(Array),
      "b1",
      txClient
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAID", nonMemberHoldUntil: null },
    });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      bookingId: "b1",
      db: txClient,
      previousRange: expect.objectContaining({
        checkIn: expect.any(Date),
        checkOut: expect.any(Date),
      }),
    });
    expect(mocks.enqueueHosting).toHaveBeenCalledWith("b1", txClient, {
      cause: "SYSTEM_CHANGE",
      actorMemberId: "admin1",
    });
    expect(mocks.settleHosting).toHaveBeenCalledWith({ bookingId: "b1" });
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueHosting.mock.invocationCallOrder[0],
    );
    expect(mocks.enqueueHosting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.settleHosting.mock.invocationCallOrder[0],
    );
    expect(mocks.paymentUpsert).toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("blocks a $0 promote at full capacity with 409 CAPACITY_EXCEEDED and does not flip to PAID", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-15"],
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
  });

  it("promotes a $0 booking at full capacity when allowOverbook is set", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: false });
    // #1771: claiming a $0 booking PAID over the ceiling stamps the persisted
    // override with the acting admin.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: {
        status: "PAID",
        nonMemberHoldUntil: null,
        capacityOverriddenAt: expect.any(Date),
        capacityOverriddenByMemberId: "admin1",
      },
    });
  });

  it("rejects a booking with no pending non-member guests", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({ status: "PAID", nonMemberHoldUntil: null })
    );

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking is missing", async () => {
    mocks.bookingFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin via the requireAdmin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 403 }),
    });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(403);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  // #1769b (#1705 semantics): the admin's per-action member-email choice. The
  // confirmation email only sends on the two paths that become PAID — the
  // zero-amount (paid_zero) and charged-card (paid_charged) outcomes — so the
  // audit records `notifyMember: false` only there. The payment-owed and
  // failure outcomes send no email and record no notify field.
  describe("member-email notify choice (#1769b)", () => {
    it("emails and records no notify field by default on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest(), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({ outcome: "paid_zero" });
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the email and records notifyMember:false on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: false }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({
        outcome: "paid_zero",
        notifyMember: false,
      });
    });

    it("emails and records no notify field when notifyMember is true on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: true }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the email and records notifyMember:false on the charged-card path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(makeBooking());
      mocks.chargePaymentMethod.mockResolvedValue({
        id: "pi_1",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_1",
      });
      mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

      const res = await POST(makeRequest({ notifyMember: false }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const chargedCall = mocks.createStructuredAuditLog.mock.calls.find(
        (call) => call[0].metadata?.outcome === "paid_charged"
      );
      expect(chargedCall?.[0].metadata).toMatchObject({
        outcome: "paid_charged",
        notifyMember: false,
      });
    });

    it("records NO notify field on the payment-owed path even when notifyMember:false", async () => {
      // Priced booking with no saved card moves to payment-owed and emails no
      // one, so a suppression there is not real — no field is recorded.
      mocks.bookingFindUnique.mockResolvedValue(makeBooking({ payment: null }));

      const res = await POST(makeRequest({ notifyMember: false }), { params });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({ outcome: "payment_owed" });
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("rejects a non-boolean notifyMember with 400 and no side effects", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: "false" }), { params });

      expect(res.status).toBe(400);
      expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      expect(mocks.createStructuredAuditLog).not.toHaveBeenCalled();
    });
  });
});
