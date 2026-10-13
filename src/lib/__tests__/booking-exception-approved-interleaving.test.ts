import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { matchesWhere, type WhereInput, type WhereRow } from "./support/prisma-where";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { requireCalendarDate } from "@/lib/club-time";
import { bookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

// #4069: compose the real approval engine, approval hooks and two real routes.
// Canonical creation supplies the shared row and a controlled post-commit thunk;
// external providers and unrelated guest/hosting side effects stay offline.
/** The shipped default: the memberGuests module off, consent required. */
const MEMBER_GUEST_POLICY = {
  wideningEnabled: false,
  approvalRequired: true,
  pendingHoldExpiryDays: 0,
} as const;

const checkCapacityForGuestRanges = vi.fn();
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) => checkCapacityForGuestRanges(...args),
  acquireLodgeCapacityLock: vi.fn(),
  findOverlappingCapacityHoldingBookings: async () => [],
  findOverlappingOverriddenNonHoldingBookings: async () => [],
}));
const createConfirmedBooking = vi.fn();
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: (...args: unknown[]) => createConfirmedBooking(...args),
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({ modifyBookingBatch: vi.fn() }));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  recordAdultMemberHostingReviewDecision: vi.fn(), enqueueOwnHostingCoverageReevaluation: vi.fn(),
}));
vi.mock("@/lib/adult-member-hosting-proposed", () => ({ evaluateProposedAdultMemberHosting: async () => null }));
vi.mock("@/lib/adult-member-hosting-coverage-incidents", () => ({ resolveHostingCoverageIncidents: vi.fn() }));
vi.mock("@/lib/cancellation", () => ({ getNonMemberHoldPolicy: vi.fn() }));
vi.mock("@/lib/booking-guests", () => ({
  resolveLinkedBookingMembersWithBoundary: async () => ({ members: new Map(), boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] } }),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: (guests: Array<Record<string, unknown>>) => guests,
}));
vi.mock("@/lib/member-guest-add-policy", () => ({
  planMemberGuestConsentWrites: ({ guests }: { guests: Array<Record<string, unknown>> }) => ({ guests, entriesByMemberId: new Map() }),
  loadMemberGuestAddPolicy: async () => MEMBER_GUEST_POLICY,
  matchMemberGuestNotificationRows: () => [],
}));

const sendEmail = vi.fn(async (payload: { html: string; templateData: Record<string, unknown> }) => { void payload; });
vi.mock("@/lib/email/core", () => ({ sendEmail: (...args: Parameters<typeof sendEmail>) => sendEmail(...args) }));
vi.mock("@/lib/email", async () => {
  const { sendBookingPolicyExceptionApprovedEmail } = await import("@/lib/email/booking");
  return { sendBookingPolicyExceptionApprovedEmail };
});
vi.mock("@/lib/club-theme", async () => {
  const { DEFAULT_CLUB_THEME_VALUES } = await import("@/lib/club-theme-schema");
  return { getWebsiteThemeRenderState: async () => ({ values: DEFAULT_CLUB_THEME_VALUES, css: "" }) };
});
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => CLUB_FORMAT_TEST }));
vi.mock("@/lib/club-time/server", () => ({ clubTodayDateOnlyInstant: async () => new Date("2026-07-01") }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "member-1", accessRoles: [{ role: "USER" }] } }) }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: async () => null,
  requireAdmin: async () => ({ ok: true, session: { user: { id: "officer-1", accessRoles: [{ role: "ADMIN" }] } } }),
}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: async () => ({ xeroIntegration: true, internetBankingPayments: true }) }));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  MAX_AUDITED_PRUNED_ALLOCATIONS: 50,
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn(),
  reconcileBedAllocationsForBookingWithGlobalLockHeld: async () => ({ enabled: true, deletedCount: 0, createdCount: 0, promotedCount: 0 }),
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({ settleHostingCoverageAfterCommit: vi.fn() }));
vi.mock("@/lib/booking-credit-election", () => ({ consumeStoredCreditElection: async () => null }));
vi.mock("@/lib/payment-transactions", () => ({ recordInternetBankingPaymentTransaction: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: vi.fn() }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: async () => ({ queueOperationId: null }),
  enqueueXeroAppliedCreditAllocationOperation: async () => ({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: async () => false }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(), getAuditRequestContext: () => ({}) }));
vi.mock("@/lib/family-booking-add-notifications", () => ({ sendFamilyMemberBookingAddNotifications: vi.fn() }));
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => ({
  ...(await importOriginal()) as typeof import("@/lib/booking-exception-request-service"),
  evaluateProposalPartyViolations: async () => [minimumStayViolation],
}));
const deriveBookingAppliedCreditCents = vi.fn(async () => 0);
vi.mock("@/lib/member-credit", () => ({ deriveBookingAppliedCreditCents: () => deriveBookingAppliedCreditCents(), lockMemberCreditLedger: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  booking: { findUnique: (...args: Parameters<typeof bookingFindUnique>) => bookingFindUnique(...args) },
  internetBankingPaymentSettings: { findUnique: () => db.internetBankingPaymentSettings.findUnique() },
  $transaction: (...args: Parameters<typeof db.$transaction>) => db.$transaction(...args),
} }));

import { buildPolicyExceptionApprovalHooks } from "@/lib/booking-exception-approval";
import { approveAndExecutePolicyExceptionRequest, newBookingExceptionRequestStore } from "@/lib/booking-exception-execution";
import { computeProposalHash, freezePolicyExceptionEvidence, type NewBookingProposalSnapshot } from "@/lib/booking-exception-requests";
import { POST as switchToBank } from "@/app/api/payments/switch-to-internet-banking/route";
import { POST as exclusiveHold } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";

const BOOKING_ID = "abcd1234-exception";
const snapshot: NewBookingProposalSnapshot = {
  kind: "NEW_BOOKING", lodgeId: "lodge-1",
  proposed: { checkIn: "2026-08-01", checkOut: "2026-08-02", guests: [{
    firstName: "Mia", lastName: "Member", ageTier: "ADULT", isMember: true,
    memberId: "member-1", nights: ["2026-08-01"],
  }] },
};
// A one-night adult-member stay needing a two-night minimum-stay exception:
// the reviewed and live rule agree, so the real drift gate authorizes execution.
const minimumStayViolation: MinimumStayPolicyExceptionViolation = {
  reasonCode: "MINIMUM_STAY", policyId: "policy-1", policyVersion: 1,
  policyName: "Weekend minimum stay",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: "lodge-1" },
  affectedNights: ["2026-08-01"], exceptionEligible: true, capacityMode: "NO_HOLD",
  message: "Two-night minimum on weekends.", triggerDay: "2026-08-01", minimumNights: 2, actualNights: 1,
  requirements: { kind: "MINIMUM_STAY", minimumNights: 2, actualNights: 1, triggerDays: [6] },
};
let requestRow: WhereRow;
let bookingRow: WhereRow | null;
const order: string[] = [];

function update(row: WhereRow | null, { where, data }: { where: WhereInput; data: WhereRow }) {
  if (!row || !matchesWhere(row, where)) return { count: 0 };
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? Number(row[key]) + Number(value.increment) : value;
  }
  return { count: 1 };
}
const bookingFindUnique = vi.fn(async ({ where }: { where: WhereInput }) =>
  bookingRow && matchesWhere(bookingRow, where) ? structuredClone(bookingRow) : null);
const tx = {
  $executeRaw: vi.fn(async () => undefined),
  member: { findUnique: async () => ({ active: true, canLogin: true, forcePasswordChange: false, accessRoles: [{ role: "ADMIN" }] }), findMany: async () => [] },
  booking: { findUnique: bookingFindUnique, updateMany: async (args: { where: WhereInput; data: WhereRow }) => update(bookingRow, args) },
  payment: {
    findUnique: async () => bookingRow?.payment ?? null,
    upsert: async ({ update: payment }: { update: WhereRow }) => {
      if (!bookingRow) throw new Error("Approval did not create a booking");
      bookingRow.payment = { id: "payment-1", ...payment };
      return bookingRow.payment;
    },
  },
  memberCredit: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
  newBookingPolicyExceptionRequest: {
    findUnique: async ({ where }: { where: WhereInput }) => matchesWhere(requestRow, where) ? structuredClone(requestRow) : null,
    updateMany: async (args: { where: WhereInput; data: WhereRow }) => update(requestRow, args),
  },
  bedAllocation: { findMany: async () => [] },
};
const db = {
  ...tx,
  internetBankingPaymentSettings: { findUnique: async () => ({ holdBedSlots: true, holdDays: 5, minimumDaysBeforeCheckIn: 7 }) },
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
    const result = await fn(tx);
    order.push("commit");
    return result;
  },
};

function payableBooking() {
  return {
    id: BOOKING_ID, memberId: "member-1", lodgeId: "lodge-1", status: "PAYMENT_PENDING",
    finalPriceCents: 5000, totalPriceCents: 5000, discountCents: 0, promoAdjustmentCents: 0,
    checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-02"), deletedAt: null,
    hasNonMembers: false, organiserSettled: false, wholeLodgeHold: false,
    wholeLodgeHoldAt: null, wholeLodgeHoldByMemberId: null, adminCapacityHoldAt: null,
    originBookingRequest: null, creditElectionCents: 0, payment: null,
    member: { id: "member-1", email: "member@example.test", firstName: "Mia" }, organisation: null,
    guests: [{ id: "guest-1", memberId: "member-1", priceCents: 5000,
      nights: [{ stayDate: new Date("2026-08-01"), priceCents: 5000, priceSource: "SOLD" }] }],
  };
}
function buildHooks() {
  return buildPolicyExceptionApprovalHooks({
    format: CLUB_FORMAT_TEST, todayAtClub: requireCalendarDate("2026-07-01"),
    batchPreTransaction: {} as BatchModificationPreTransaction,
    requestId: "request-1", actorMemberId: "officer-1", ipAddress: "203.0.113.5",
    adminNotes: "Agreed by the club", internalNotes: "Private officer note",
    newBookingExecution: { status: "PAYMENT_PENDING", shouldBePending: false, holdDays: 0,
      paymentMethod: "stripe", memberGuestPolicy: MEMBER_GUEST_POLICY,
      guestDietarySeeding: bookingGuestDietarySeeding(false) },
  });
}
function approve() {
  return approveAndExecutePolicyExceptionRequest({ requestId: "request-1", expectedVersion: 1,
    actorMemberId: "officer-1", hooks: buildHooks().hooks,
    store: newBookingExceptionRequestStore, db: db as never });
}
function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks(); order.length = 0; bookingRow = null;
  requestRow = { id: "request-1", status: "REQUESTED", version: 1, requestedByMemberId: "member-1",
    proposalSnapshot: snapshot, proposalHash: computeProposalHash(snapshot),
    frozenEvidence: freezePolicyExceptionEvidence([minimumStayViolation]), aggregateCapacityMode: "NO_HOLD" };
  checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  deriveBookingAppliedCreditCents.mockResolvedValue(0);
  createConfirmedBooking.mockImplementation(async () => {
    bookingRow = payableBooking();
    return { type: "created", booking: structuredClone(bookingRow), deferredPostCommit: async () => undefined };
  });
});

describe("exception approval post-commit notification", () => {
  it("quotes a still-unpaid held whole lodge after the real switch and exclusive-hold routes interleave", async () => {
    const entered = barrier(); const release = barrier();
    createConfirmedBooking.mockImplementation(async () => {
      bookingRow = payableBooking();
      return { type: "created", booking: structuredClone(bookingRow), deferredPostCommit: async () => {
        order.push("deferred"); entered.resolve(); await release.promise;
      } };
    });
    const approval = approve();
    await entered.promise;
    expect(order).toEqual(["commit", "deferred"]);
    expect(requestRow).toMatchObject({ status: "APPROVED", createdBookingId: BOOKING_ID });
    expect(bookingRow).toMatchObject({ status: "PAYMENT_PENDING", wholeLodgeHold: false });
    expect(sendEmail).not.toHaveBeenCalled();
    try {
      const switched = await switchToBank(post("/api/payments/switch-to-internet-banking", { bookingId: BOOKING_ID }));
      expect(await switched.json()).toMatchObject({ holdBedSlots: true });
      expect(switched.status).toBe(200);
      expect(bookingRow).toMatchObject({ status: "CONFIRMED", payment: {
        source: "INTERNET_BANKING", status: "PENDING", amountCents: 5000, internetBankingHoldSlots: true,
      } });
      const held = await exclusiveHold(post(`/api/admin/bookings/${BOOKING_ID}/exclusive-hold`, { hold: true }), { params: Promise.resolve({ id: BOOKING_ID }) });
      expect(held.status).toBe(200);
      expect(bookingRow).toMatchObject({ wholeLodgeHold: true, status: "CONFIRMED", payment: { status: "PENDING", amountCents: 5000 } });
    } finally { release.resolve(); }
    expect(await approval).toEqual({ outcome: "executed", requestId: "request-1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0][0];
    expect(message.templateData.paymentNote).toContain("50.00 to pay");
    expect(message.html).toContain("bank-transfer instructions");
    expect(message.html).toContain("Your beds are currently held.");
    expect(message.html).not.toContain("beds are not held");
    expect(message.html).not.toContain("Private officer note");
    expect(await approve()).toMatchObject({ outcome: "claimLost" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary unheld Stripe payment instructions", async () => {
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sendEmail.mock.calls[0][0].html).toContain("Open it from your account to pay now.");
    expect(sendEmail.mock.calls[0][0].html).toContain("The beds are not held until it is paid.");
  });

  it("reports an admin-held ordinary payment-pending booking as held", async () => {
    createConfirmedBooking.mockImplementation(async () => {
      bookingRow = { ...payableBooking(), adminCapacityHoldAt: new Date("2026-07-01") };
      return { type: "created", booking: structuredClone(bookingRow), deferredPostCommit: async () => undefined };
    });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sendEmail.mock.calls[0][0].html).toContain("Your beds are currently held.");
    expect(sendEmail.mock.calls[0][0].html).not.toContain("beds are not held");
  });

  it.each(["paid", "succeeded-confirmed", "zero-price", "credit-covered"])("omits the payment note for %s", async (kind) => {
    createConfirmedBooking.mockImplementation(async () => {
      bookingRow = { ...payableBooking(), ...((kind === "paid" || kind === "succeeded-confirmed") ? { status: kind === "paid" ? "PAID" : "CONFIRMED", payment: { status: "SUCCEEDED", source: "STRIPE", changeFeeCents: null } } : kind === "zero-price" ? { finalPriceCents: 0 } : {}) };
      return { type: "created", booking: structuredClone(bookingRow), deferredPostCommit: async () => undefined };
    });
    if (kind === "credit-covered") deriveBookingAppliedCreditCents.mockResolvedValue(5000);
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sendEmail.mock.calls[0][0].templateData.paymentNote).toBe("");
    expect(sendEmail.mock.calls[0][0].html).not.toContain("to pay on this booking");
  });

  it("does not send a new-booking notice for an existing-booking outcome", async () => {
    const { hooks } = buildHooks();
    await hooks.notifyApproved?.({ bookingId: "existing-booking" } as never);
    expect(bookingFindUnique).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
