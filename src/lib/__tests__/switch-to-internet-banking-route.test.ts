import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PaymentSource, PaymentStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  findUnique: vi.fn(),
  txBookingFindUnique: vi.fn(),
  upsert: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  transaction: vi.fn(),
  txExecuteRaw: vi.fn(),
  recordInternetBankingPaymentTransaction: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  enqueueXeroAppliedCreditAllocationOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  isXeroConnected: vi.fn(),
  creditAggregate: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: { findUnique: mocks.findUnique, update: mocks.bookingUpdate },
    payment: { upsert: mocks.upsert },
    memberCredit: { aggregate: mocks.creditAggregate },
    internetBankingPaymentSettings: { findUnique: mocks.settingsFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction:
    mocks.recordInternetBankingPaymentTransaction,
}));
vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroBookingInvoiceOperation,
  enqueueXeroAppliedCreditAllocationOperation:
    mocks.enqueueXeroAppliedCreditAllocationOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/member-credit", () => ({
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  // #2265 — the switch now consumes a stored credit election, which drives the
  // shared ledger helpers.
  applyCreditToBooking: mocks.applyCreditToBooking,
  getMemberCreditBalance: mocks.getMemberCreditBalance,
  deriveBookingAppliedCreditCents: mocks.deriveBookingAppliedCreditCents,
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return {
    ...actual,
    acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Internet Banking module gate. Partial-mock so the module's other exports
// (used transitively) stay intact.
vi.mock("@/lib/module-settings", async () => {
  const actual = (await vi.importActual("@/lib/module-settings")) as typeof import("@/lib/module-settings");
  return { ...actual, loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags };
});

import { POST } from "@/app/api/payments/switch-to-internet-banking/route";

// buildInternetBankingPaymentReference uppercases the first 8 chars of the id.
const BOOKING_ID = "abcd1234-booking";
const REFERENCE = "BOOKING-ABCD1234";

function postRequest(body: unknown = { bookingId: BOOKING_ID }) {
  return new NextRequest(
    "http://localhost/api/payments/switch-to-internet-banking",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

/** A payable Stripe (card) booking the owner can still switch. */
function stripeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    hasNonMembers: false,
    organiserSettled: false,
    finalPriceCents: 4500,
    payment: {
      source: PaymentSource.STRIPE,
      status: PaymentStatus.PENDING,
      stripePaymentIntentId: "pi_123",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  mocks.findUnique.mockResolvedValue(stripeBooking());
  // #1881 — the route re-reads the booking under the locks inside the tx before
  // switching; default it to the same payable snapshot with an empty guest set.
  mocks.txBookingFindUnique.mockResolvedValue({ ...stripeBooking(), guests: [] });
  mocks.upsert.mockResolvedValue({ id: "payment-1" });
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  // Settings singleton: null → defaults (holdBedSlots false, no lead-time gate),
  // so the switch stays PAYMENT_PENDING without a capacity re-check.
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.txExecuteRaw.mockResolvedValue(undefined);
  // The route now finalises the payment switch inside a Prisma transaction; run
  // the callback against a tx client that mirrors the production surface.
  mocks.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: vi.fn().mockResolvedValue([]),
        lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
        payment: { upsert: mocks.upsert },
        memberCredit: { aggregate: mocks.creditAggregate },
        booking: {
          findUnique: mocks.txBookingFindUnique,
          update: mocks.bookingUpdate,
          updateMany: mocks.bookingUpdateMany,
        },
      })
  );
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(undefined);
  mocks.enqueueXeroBookingInvoiceOperation.mockResolvedValue({
    queueOperationId: "queue-1",
  });
  mocks.enqueueXeroAppliedCreditAllocationOperation.mockResolvedValue({
    queueOperationId: null,
  });
  // Default booking has no applied credit → effective amount == finalPrice.
  mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
  mocks.applyCreditToBooking.mockResolvedValue(undefined);
  mocks.getMemberCreditBalance.mockResolvedValue(0);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.isXeroConnected.mockResolvedValue(true);
});

describe("POST /api/payments/switch-to-internet-banking", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an inactive session before touching the booking", async () => {
    mocks.requireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "inactive" }), { status: 403 })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the Internet Banking module is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValueOnce({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Internet Banking payments are not available.",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body", async () => {
    const res = await POST(postRequest({ nope: true }));
    expect(res.status).toBe(400);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking does not exist", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is neither the owner nor an admin", async () => {
    mocks.auth.mockResolvedValueOnce({
      user: { id: "someone-else", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("lets an admin switch on behalf of the booking owner", async () => {
    mocks.auth.mockResolvedValueOnce({ user: { id: "admin-9", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalled();
  });

  it("rejects an organiser-settled booking with 400", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ organiserSettled: true })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent when the booking is already Internet Banking", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({
        payment: {
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: null,
        },
      })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reference: REFERENCE });
    // No re-conversion work.
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("409s and writes nothing when a concurrent cancel moved the booking out of PAYMENT_PENDING under the locks (#1881)", async () => {
    // The pre-transaction read still sees PAYMENT_PENDING, but the under-lock
    // re-read sees a booking a concurrent cancel already moved to CANCELLED.
    mocks.txBookingFindUnique.mockResolvedValue({
      ...stripeBooking({ status: "CANCELLED" }),
      guests: [],
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(409);
    // No payment switch, no invoice work — the claim was refused.
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("rejects a booking that is not immediately payable (wrong status)", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ status: "CONFIRMED" })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a saved-card hold (non-member) booking that cannot charge now", async () => {
    // A non-member hold sits at PENDING and uses a saved card, not an
    // immediate charge — so it must not be switchable to Internet Banking.
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ status: "PENDING", hasNonMembers: true })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a zero-dollar booking with nothing to pay", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ finalPriceCents: 0 })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a booking whose payment already succeeded", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({
        payment: {
          source: PaymentSource.STRIPE,
          status: PaymentStatus.SUCCEEDED,
          stripePaymentIntentId: "pi_123",
        },
      })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("spends a stored credit election so the invoice asks only for the rest", async () => {
    // #2265 — a booking an admin released from review can still be carrying the
    // member's election when they choose Internet Banking. The switch used to
    // walk straight past it: the invoice was raised for the full price and the
    // credit was stranded on a booking that could never consume it.
    const withElection = { ...stripeBooking(), creditElectionCents: 2_000 };
    mocks.findUnique.mockResolvedValue(withElection);
    mocks.txBookingFindUnique.mockResolvedValue({ ...withElection, guests: [] });
    mocks.getMemberCreditBalance.mockResolvedValue(5_000);
    // The route re-reads the ledger AFTER the consumption, so the aggregate
    // reports the newly written BOOKING_APPLIED row.
    mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: -2_000 } });

    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      reference: REFERENCE,
      creditElection: { requestedCents: 2_000, appliedCents: 2_000 },
    });

    expect(mocks.applyCreditToBooking).toHaveBeenCalledWith(
      "member-1",
      2_000,
      BOOKING_ID,
      expect.anything(),
      expect.objectContaining({
        description: expect.stringContaining("price source BASE_EVIDENCE_UNKNOWN"),
      }),
    );
    // The invoice is raised for the post-election remainder, and the mirror
    // keeps amountCents + creditAppliedCents = finalPriceCents.
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          amountCents: 2_500,
          creditAppliedCents: 2_000,
        }),
      }),
    );
  });

  it("refuses the switch when credit covers the booking, leaving the election intact", async () => {
    const withElection = { ...stripeBooking(), creditElectionCents: 4_500 };
    mocks.findUnique.mockResolvedValue(withElection);
    mocks.txBookingFindUnique.mockResolvedValue({ ...withElection, guests: [] });
    mocks.getMemberCreditBalance.mockResolvedValue(5_000);
    mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: -4_500 } });

    const res = await POST(postRequest());

    // There is no $0 invoice to raise, and settling belongs to the pay step.
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "CREDIT_COVERS_BOOKING",
    });
    // Nothing was written: the transaction rolled back, so the election is
    // still on the booking for the pay step to spend.
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("converts a Stripe booking to Internet Banking and raises the invoice", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    // Default settings hold no beds, so the response reports the reference plus
    // the (empty) hold policy.
    await expect(res.json()).resolves.toEqual({
      reference: REFERENCE,
      holdBedSlots: false,
      holdUntil: null,
      // #2265 — null because this booking carried no stored credit election.
      creditElection: null,
    });

    // Voids the open Stripe intent.
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_123");

    // Flips the payment to Internet Banking, clearing the Stripe intent. With no
    // applied credit the effective amount is the full price and the mirror is 0.
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: BOOKING_ID },
        update: expect.objectContaining({
          amountCents: 4500,
          creditAppliedCents: 0,
          source: PaymentSource.INTERNET_BANKING,
          reference: REFERENCE,
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: null,
        }),
      })
    );

    // Records the IB transaction and queues the emailed Xero invoice.
    expect(mocks.recordInternetBankingPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: REFERENCE })
    );
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith(
      BOOKING_ID,
      expect.objectContaining({ createdByMemberId: "member-1" })
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalled();
  });

  it("switches at the credit-reduced effective amount and queues the allocation (#1620)", async () => {
    // Member applied NZ$15.00 credit to this $45.00 booking (BOOKING_APPLIED
    // ledger sum = -1500; the card-origin payment mirror was 0).
    mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: -1500 } });
    mocks.enqueueXeroAppliedCreditAllocationOperation.mockResolvedValue({
      queueOperationId: "queue-alloc-1",
    });

    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    // §3 mirror: amountCents = finalPrice − applied; creditAppliedCents = applied.
    // (amount + credit = finalPrice preserved.)
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          amountCents: 3000,
          creditAppliedCents: 1500,
        }),
        update: expect.objectContaining({
          amountCents: 3000,
          creditAppliedCents: 1500,
        }),
      })
    );

    // The invoice is reduced to effective by the allocation op.
    expect(
      mocks.enqueueXeroAppliedCreditAllocationOperation
    ).toHaveBeenCalledWith(
      BOOKING_ID,
      expect.objectContaining({ createdByMemberId: "member-1" })
    );
    expect(mocks.recordInternetBankingPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 3000 })
    );
  });

  it("uses the repriced booking and credit ledger under global -> lodge -> member locks (#1881)", async () => {
    // The unlocked request snapshot was $45 with no credit. While it waited for
    // lock(1), a valid reprice raised the booking to $60 and the member applied
    // $20 credit. The persisted IB mirror must use the locked pair: 4000+2000.
    mocks.txBookingFindUnique.mockResolvedValue({
      ...stripeBooking({ finalPriceCents: 6000 }),
      guests: [],
    });
    mocks.creditAggregate.mockResolvedValue({ _sum: { amountCents: -2000 } });

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          amountCents: 4000,
          creditAppliedCents: 2000,
        }),
      })
    );
    expect(mocks.recordInternetBankingPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 4000 })
    );
    expect(mocks.lockMemberCreditLedger).toHaveBeenCalledWith(
      "member-1",
      expect.objectContaining({ memberCredit: expect.any(Object) })
    );
    expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]
    );
    expect(mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.lockMemberCreditLedger.mock.invocationCallOrder[0]
    );
    expect(mocks.lockMemberCreditLedger.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.creditAggregate.mock.invocationCallOrder[0]
    );
  });

  it("does not kick the outbox when Xero is disconnected", async () => {
    mocks.isXeroConnected.mockResolvedValueOnce(false);
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });

  it("still succeeds when a Stripe intent cannot be cancelled", async () => {
    mocks.cancelPaymentIntentIfCancellable.mockRejectedValueOnce(
      new Error("stripe down")
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalled();
  });
});
