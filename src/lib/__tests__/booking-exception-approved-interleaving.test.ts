import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { matchesWhere, type WhereInput, type WhereRow } from "./support/prisma-where";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { requireCalendarDate } from "@/lib/club-time";
import { bookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import type { BatchModificationPreTransaction } from "@/lib/booking-batch-modification-service";

// #4069 (`INV-PAY-159`): the approval email's race, composed offline. The real
// approval engine, the real approval hooks, the real bank-switch and
// exclusive-hold routes, the real cash-cover reader and the real sender run
// over one in-memory booking. Canonical creation supplies that row and a
// controlled post-commit thunk; providers and unrelated guest and hosting side
// effects stay offline. The reader's real-writer cases, and the snapshot on
// real PostgreSQL, are `booking-cash-evidence.realdb.test.ts`.
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
// The bank receipt's row as the real writer leaves it: PRIMARY, pending, at its face.
vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction: async (args: { amountCents: number; status: string; reason: string }) => {
    (live.booking?.payment as PaymentRow).transactions.push({
      id: "txn-bank-1", kind: "PRIMARY", source: "INTERNET_BANKING", status: args.status, amountCents: args.amountCents,
      refundedAmountCents: 0, reason: args.reason, stripePaymentIntentId: null,
    });
  },
}));
vi.mock("@/lib/booking-ledger-pending-charge", () => ({ postBindingCharge: vi.fn() }));
vi.mock("@/lib/member-money/doors", () => ({ resolveBookingMoneyPostingContext: async () => ({}) }));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: vi.fn() }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: async () => ({ queueOperationId: null }),
  enqueueXeroAppliedCreditAllocationOperation: async () => ({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(), getAuditRequestContext: () => ({}) }));
vi.mock("@/lib/family-booking-add-notifications", () => ({ sendFamilyMemberBookingAddNotifications: vi.fn() }));
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => ({
  ...(await importOriginal()) as typeof import("@/lib/booking-exception-request-service"),
  evaluateProposalPartyViolations: async () => [minimumStayViolation],
}));
// The real applied-credit read, over the fake ledger below.
vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...(await importOriginal()) as typeof import("@/lib/member-credit"),
  lockMemberCreditLedger: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  booking: { findUnique: (...args: Parameters<typeof root.booking.findUnique>) => root.booking.findUnique(...args) },
  internetBankingPaymentSettings: { findUnique: async () => ({ holdBedSlots: true, holdDays: 5, minimumDaysBeforeCheckIn: 7 }) },
  $transaction: (...args: Parameters<typeof $transaction>) => $transaction(...args),
} }));

import { buildPolicyExceptionApprovalHooks } from "@/lib/booking-exception-approval";
import { approveAndExecutePolicyExceptionRequest, newBookingExceptionRequestStore } from "@/lib/booking-exception-execution";
import { computeProposalHash, freezePolicyExceptionEvidence, type NewBookingProposalSnapshot } from "@/lib/booking-exception-requests";
import { POST as switchToBank } from "@/app/api/payments/switch-to-internet-banking/route";
import { POST as exclusiveHold } from "@/app/api/admin/bookings/[id]/exclusive-hold/route";
import { bookingPolicyExceptionApprovedPaymentNote } from "@/lib/booking-exception-approved-email-copy";

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
type PaymentRow = WhereRow & { transactions: WhereRow[] };
/** What a client reads: the booking, and the account credit applied to it. */
type Rows = { booking: WhereRow | null; appliedCreditCents: number };
let requestRow: WhereRow;
const live: Rows = { booking: null, appliedCreditCents: 0 };
const order: string[] = [];
/** Every read, as `<client>:<model>`, so a read that left the snapshot shows. */
const reads: string[] = [];
/** What the email read and through which client, sorted: which reads, never their order. */
const emailReads = () => reads.filter((read) => !read.startsWith("tx:")).sort();
const snapshots: Array<{ options: unknown; statements: string[] }> = [];
/** A writer to run once, after the snapshot's first read and before its next. */
let betweenSnapshotReads: (() => void) | null = null;
let failSnapshot = false;

function update(row: WhereRow | null, { where, data }: { where: WhereInput; data: WhereRow }) {
  if (!row || !matchesWhere(row, where)) return { count: 0 };
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? Number(row[key]) + Number(value.increment) : value;
  }
  return { count: 1 };
}
const CAPTURED = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"];
/** A payment as a select returns it: its rows, and the count of captured ones. */
function paymentAsRead(payment: PaymentRow | null) {
  return payment && { ...structuredClone(payment), recoveryOperations: [], refunds: [],
    _count: { transactions: payment.transactions.filter((row) => CAPTURED.includes(String(row.status))).length } };
}
/** One database client over `rows()`: the live rows, or a snapshot's frozen copy. */
function clientOver(name: "root" | "tx" | "snapshot", rows: () => Rows, statements: string[] = []) {
  const read = <T>(model: string, value: T): T => { reads.push(`${name}:${model}`); return value; };
  return {
    $executeRaw: async (sql: TemplateStringsArray) => { statements.push(sql.join("?")); },
    member: { findUnique: async () => ({ active: true, canLogin: true, forcePasswordChange: false, accessRoles: [{ role: "ADMIN" }] }), findMany: async () => [] },
    booking: {
      findUnique: async ({ where }: { where: WhereInput }) => {
        const booking = rows().booking;
        const found = read("booking", booking && matchesWhere(booking, where)
          ? { ...structuredClone(booking), payment: paymentAsRead(booking.payment as PaymentRow | null) } : null);
        if (name === "snapshot" && betweenSnapshotReads) { const write = betweenSnapshotReads; betweenSnapshotReads = null; write(); }
        return found;
      },
      // The organiser-settled children of a parent: the one booking, when it is one.
      findMany: async ({ where }: { where: WhereInput }) => {
        const booking = rows().booking;
        const payment = booking?.payment as PaymentRow | null | undefined;
        return read("booking.siblings", booking && matchesWhere(booking, where)
          ? [{ id: booking.id, lodgeId: booking.lodgeId, payment: payment ? { amountCents: payment.amountCents, status: payment.status, source: payment.source } : null }]
          : []);
      },
      updateMany: async (args: { where: WhereInput; data: WhereRow }) => update(rows().booking, args),
    },
    payment: {
      findUnique: async () => read("payment", rows().booking?.payment ?? null),
      upsert: async ({ update: payment }: { update: WhereRow }) => {
        const booking = rows().booking;
        if (!booking) throw new Error("Approval did not create a booking");
        booking.payment = { id: "payment-1", refundedAmountCents: 0, changeFeeCents: null, additionalPaymentIntentId: null, transactions: [], ...payment };
        return booking.payment;
      },
    },
    paymentTransaction: {
      findMany: async () => read("paymentTransaction", structuredClone((rows().booking?.payment as PaymentRow | null)?.transactions ?? [])),
    },
    stripeDispute: { findMany: async () => read("stripeDispute", []) },
    paymentRecoveryOperation: { findMany: async () => read("paymentRecoveryOperation", []) },
    memberCredit: { aggregate: async () => read("memberCredit", { _sum: { amountCents: -rows().appliedCreditCents } }) },
    newBookingPolicyExceptionRequest: {
      findUnique: async ({ where }: { where: WhereInput }) => matchesWhere(requestRow, where) ? structuredClone(requestRow) : null,
      updateMany: async (args: { where: WhereInput; data: WhereRow }) => update(requestRow, args),
    },
    bedAllocation: { findMany: async () => [] },
  };
}
const root = clientOver("root", () => live);
const tx = clientOver("tx", () => live);
/**
 * A writer's transaction commits to the live rows. A `RepeatableRead` one reads
 * the rows as they stood at its first read, as PostgreSQL's snapshot does.
 */
async function $transaction(fn: (client: typeof tx) => Promise<unknown>, options?: { isolationLevel?: string }) {
  if (options?.isolationLevel !== "RepeatableRead") {
    const result = await fn(tx);
    order.push("commit");
    return result;
  }
  if (failSnapshot) throw new Error("the database went away");
  const statements: string[] = [];
  snapshots.push({ options, statements });
  let frozen: Rows | null = null;
  return fn(clientOver("snapshot", () => (frozen ??= structuredClone(live)), statements));
}
const db = { ...tx, $transaction };

function payableBooking() {
  return {
    id: BOOKING_ID, memberId: "member-1", lodgeId: "lodge-1", status: "PAYMENT_PENDING",
    finalPriceCents: 5000, totalPriceCents: 5000, discountCents: 0, promoAdjustmentCents: 0,
    checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-02"), deletedAt: null,
    hasNonMembers: false, organiserSettled: false, wholeLodgeHold: false,
    wholeLodgeHoldAt: null, wholeLodgeHoldByMemberId: null, adminCapacityHoldAt: null,
    originBookingRequest: null, creditElectionCents: 0, payment: null as PaymentRow | null,
    parentBookingId: null, parentBooking: null, manualRefundTasks: [], creditsFromCancellation: [],
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

/** Canonical creation, landing `booking` as the approved row. */
function createsBooking(booking: WhereRow, deferredPostCommit: () => Promise<void> = async () => undefined) {
  createConfirmedBooking.mockImplementation(async () => {
    live.booking = booking;
    return { type: "created", booking: structuredClone(booking), deferredPostCommit };
  });
}
/** A card payment as a capture leaves it: the mirror, and the captured row behind it. */
function capturedCardPayment(amountCents: number): PaymentRow {
  return {
    id: "payment-1", status: "SUCCEEDED", source: "STRIPE", amountCents, refundedAmountCents: 0,
    changeFeeCents: null, stripePaymentIntentId: "pi_1", additionalPaymentIntentId: null,
    transactions: [{ id: "txn-card-1", kind: "PRIMARY", source: "STRIPE", status: "SUCCEEDED", amountCents,
      refundedAmountCents: 0, reason: null, stripePaymentIntentId: "pi_1" }],
  };
}
/** A captured card payment after `cents` of it went back to the card: mirror and row together. */
function refundedCardPayment(amountCents: number, cents: number): PaymentRow {
  const payment = capturedCardPayment(amountCents);
  return { ...payment, status: "PARTIALLY_REFUNDED", refundedAmountCents: cents,
    transactions: [{ ...payment.transactions[0], status: "PARTIALLY_REFUNDED", refundedAmountCents: cents }] };
}
/** A joiner's booking in an organiser-pays group: committed, and the organiser's to pay. */
function organiserPaidChild(settlementStatus: "PENDING" | "SUCCEEDED") {
  const settled = settlementStatus === "SUCCEEDED";
  return {
    ...payableBooking(), status: settled ? "PAID" : "CONFIRMED", organiserSettled: true, parentBookingId: "organiser-booking",
    parentBooking: { id: "organiser-booking", groupBookingAsOrganiser: { paymentMode: "ORGANISER_PAYS", settlement: {
      id: "settlement-1", source: "STRIPE", amountCents: 5000, stripePaymentIntentId: "pi_group", refundPlan: null, status: settlementStatus,
    } } },
    // The settle writes the child's mirror with the settlement's source and no rows of its own.
    payment: settled ? { ...capturedCardPayment(5000), stripePaymentIntentId: null, transactions: [] } : null,
  };
}
const sent = () => sendEmail.mock.calls.map(([message]) => message);
const ORGANISER_PAYS_LINE = "Your group organiser pays for this stay.";
const NEUTRAL_LINE = "To see whether anything is still to pay on this booking, open it from your account or contact the club.";

beforeEach(() => {
  vi.clearAllMocks(); order.length = 0; reads.length = 0; snapshots.length = 0;
  live.booking = null; live.appliedCreditCents = 0; betweenSnapshotReads = null; failSnapshot = false;
  requestRow = { id: "request-1", status: "REQUESTED", version: 1, requestedByMemberId: "member-1",
    proposalSnapshot: snapshot, proposalHash: computeProposalHash(snapshot),
    frozenEvidence: freezePolicyExceptionEvidence([minimumStayViolation]), aggregateCapacityMode: "NO_HOLD" };
  checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  createsBooking(payableBooking());
});

describe("exception approval post-commit notification", () => {
  it("quotes a still-unpaid held whole lodge after the real switch and exclusive-hold routes interleave", async () => {
    const entered = barrier(); const release = barrier();
    createsBooking(payableBooking(), async () => {
      order.push("deferred"); entered.resolve(); await release.promise;
    });
    const approval = approve();
    await entered.promise;
    expect(order).toEqual(["commit", "deferred"]);
    expect(requestRow).toMatchObject({ status: "APPROVED", createdBookingId: BOOKING_ID });
    expect(live.booking).toMatchObject({ status: "PAYMENT_PENDING", wholeLodgeHold: false });
    expect(sendEmail).not.toHaveBeenCalled();
    try {
      const switched = await switchToBank(post("/api/payments/switch-to-internet-banking", { bookingId: BOOKING_ID }));
      expect(await switched.json()).toMatchObject({ holdBedSlots: true });
      expect(switched.status).toBe(200);
      // CONFIRMED, holding its beds, and owing the whole transfer: a pending
      // payment at its face, and a pending receipt row behind it.
      expect(live.booking).toMatchObject({ status: "CONFIRMED", payment: {
        source: "INTERNET_BANKING", status: "PENDING", amountCents: 5000, internetBankingHoldSlots: true,
        transactions: [{ kind: "PRIMARY", status: "PENDING", amountCents: 5000, reason: "internet_banking_switch_at_pay" }],
      } });
      const held = await exclusiveHold(post(`/api/admin/bookings/${BOOKING_ID}/exclusive-hold`, { hold: true }), { params: Promise.resolve({ id: BOOKING_ID }) });
      expect(held.status).toBe(200);
      expect(live.booking).toMatchObject({ wholeLodgeHold: true, status: "CONFIRMED", payment: { status: "PENDING", amountCents: 5000 } });
    } finally { release.resolve(); }
    expect(await approval).toEqual({ outcome: "executed", requestId: "request-1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [message] = sent();
    expect(message.templateData).toMatchObject({
      amount: "$50.00",
      paymentNote: "There is $50.00 to pay on this booking. Your beds are held for now; open it from your account to pay or to see the payment details.",
    });
    expect(message.html).toContain("There is $50.00 to pay on this booking. Your beds are held for now;");
    expect(message.html).not.toContain("beds are not held");
    expect(message.html).not.toContain("Private officer note");
    // A retry loses the claim and sends nothing more.
    expect(await approve()).toMatchObject({ outcome: "claimLost" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary unheld card payment instructions", async () => {
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData.paymentNote).toBe(
      "There is $50.00 to pay on this booking. Open it from your account to pay now — the beds are not held until it is paid.",
    );
    expect(sent()[0].html).toContain("the beds are not held until it is paid.");
  });

  it("reports an admin-held ordinary payment-pending booking as held", async () => {
    createsBooking({ ...payableBooking(), adminCapacityHoldAt: new Date("2026-07-01") });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].html).toContain("There is $50.00 to pay on this booking. Your beds are held for now;");
    expect(sent()[0].html).not.toContain("beds are not held");
    // A card booking: the held line never sends the member to bank-transfer details.
    expect(sent()[0].templateData.paymentNote).not.toMatch(/bank/i);
  });

  it("does not call the beds held for a whole-lodge flag left on a booking that holds no capacity", async () => {
    // The exclusive-hold route refuses to set the flag on a booking that holds nothing,
    // and enforcement reads it only on a holding booking: a stale flag blocks nobody.
    createsBooking({ ...payableBooking(), wholeLodgeHold: true });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].html).toContain("the beds are not held until it is paid.");
    expect(sent()[0].html).not.toContain("Your beds are held for now");
  });

  it.each(["paid", "succeeded-confirmed", "zero-price", "credit-covered"])("omits the payment note for %s", async (kind) => {
    createsBooking({ ...payableBooking(), ...((kind === "paid" || kind === "succeeded-confirmed") ? { status: kind === "paid" ? "PAID" : "CONFIRMED", payment: capturedCardPayment(5000) } : kind === "zero-price" ? { finalPriceCents: 0 } : {}) });
    if (kind === "credit-covered") live.appliedCreditCents = 5000;
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData).toMatchObject({ paymentNote: "", amount: "$0.00" });
    expect(sent()[0].html).not.toContain("to pay on this booking");
  });

  it("owes only what credit and cash leave, in whole cents", async () => {
    // $50.00 stay, $12.34 of account credit: $37.66 is owed.
    live.appliedCreditCents = 1234;
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData.amount).toBe("$37.66");
    expect(sent()[0].templateData.paymentNote).toContain("There is $37.66 to pay on this booking.");
  });

  it.each(["PAID", "CONFIRMED"])("never reads a %s status with no captured row as paid", async (status) => {
    // The payment says it succeeded and no ledger row records a capture: the
    // records cannot prove it, so the member gets the neutral line.
    createsBooking({ ...payableBooking(), status, payment: { ...capturedCardPayment(5000), transactions: [] } });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData).toMatchObject({ paymentNote: NEUTRAL_LINE, amount: "" });
    expect(sent()[0].html).not.toMatch(/\$\d/);
    expect(sent()[0].html).not.toMatch(/\bpaid\b/i);
  });

  it("reads the booking, its cash and its held beds from one read-only snapshot", async () => {
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(snapshots).toEqual([{
      options: { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 10_000 },
      statements: ["SET TRANSACTION READ ONLY"],
    }]);
    expect(emailReads()).toEqual(["snapshot:booking", "snapshot:booking", "snapshot:memberCredit"]);
  });

  it("reads a paid booking's captures, disputes and superseded-capture ownership inside that snapshot too", async () => {
    createsBooking({ ...payableBooking(), status: "PAID", payment: capturedCardPayment(5000) });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(emailReads()).toEqual([
      "snapshot:booking", "snapshot:booking", "snapshot:memberCredit",
      "snapshot:paymentRecoveryOperation", "snapshot:paymentTransaction", "snapshot:stripeDispute",
    ]);
  });

  const UNPAID_UNHELD = "There is $50.00 to pay on this booking. Open it from your account to pay now — the beds are not held until it is paid.";
  const OWES_25_HELD = "There is $25.00 to pay on this booking. Your beds are held for now; open it from your account to pay or to see the payment details.";
  it.each([
    // A capture: the booking is paid and settled a moment after the snapshot.
    { name: "a capture", start: payableBooking, amount: "$50.00", paymentNote: UNPAID_UNHELD,
      write: () => { Object.assign(live.booking!, { status: "PAID", payment: capturedCardPayment(5000) }); } },
    // A credit application covering the whole stay.
    { name: "a credit application", start: payableBooking, amount: "$50.00", paymentNote: UNPAID_UNHELD,
      write: () => { live.appliedCreditCents = 5000; } },
    // A switch to a bed-holding bank transfer: now CONFIRMED and holding.
    { name: "a bed-holding bank switch", start: payableBooking, amount: "$50.00", paymentNote: UNPAID_UNHELD,
      write: () => { Object.assign(live.booking!, { status: "CONFIRMED" }); } },
    // A refund: a $75.00 stay holding its beds with $50.00 captured owes $25.00.
    // A cancellation then refunds $25.00 of the capture and lets the beds go: a
    // later read would owe more and hold nothing.
    { name: "a refund", start: () => ({ ...payableBooking(), status: "CONFIRMED", finalPriceCents: 7500, totalPriceCents: 7500, payment: capturedCardPayment(5000) }),
      amount: "$25.00", paymentNote: OWES_25_HELD,
      write: () => { Object.assign(live.booking!, { status: "CANCELLED", payment: refundedCardPayment(5000, 2500) }); } },
    // A group settlement: the organiser had not paid at the snapshot, and pays a
    // moment after. The member is told who pays, with no amount of their own.
    { name: "a group settlement", start: () => organiserPaidChild("PENDING"), amount: "", paymentNote: ORGANISER_PAYS_LINE,
      write: () => { Object.assign(live.booking!, organiserPaidChild("SUCCEEDED")); } },
  ])("describes one moment when $name lands between its reads", async ({ start, write, amount, paymentNote }) => {
    createsBooking(start());
    betweenSnapshotReads = write;
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(betweenSnapshotReads).toBeNull();
    // The amount and the held-bed sentence are both the snapshot's, never one
    // read's amount beside another's beds.
    expect(sent()[0].templateData).toMatchObject({ amount, paymentNote });
    expect(sent()[0].html).toContain(paymentNote);
    expect(reads.filter((read) => read.startsWith("root:"))).toEqual([]);
  });

  it("a snapshot opened after that refund says something else: the cancelled booking gets no amount", async () => {
    createsBooking({ ...payableBooking(), status: "CANCELLED", finalPriceCents: 7500, totalPriceCents: 7500, payment: refundedCardPayment(5000, 2500) });
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData).toMatchObject({ amount: "", paymentNote: NEUTRAL_LINE });
  });

  it("tells a joiner the organiser pays, through the real sender, asking for nothing and naming no amount", async () => {
    createsBooking(organiserPaidChild("PENDING"));
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData).toMatchObject({ amount: "", paymentNote: ORGANISER_PAYS_LINE });
    expect(sent()[0].html).toContain(ORGANISER_PAYS_LINE);
    expect(sent()[0].html).not.toMatch(/\$\d/);
    expect(sent()[0].html).not.toContain("to pay on this booking");
    // The group's share is read inside the snapshot too.
    expect(emailReads()).toEqual([
      "snapshot:booking", "snapshot:booking", "snapshot:booking.siblings", "snapshot:memberCredit", "snapshot:stripeDispute",
    ]);
  });

  it("says nothing about payment to a joiner whose organiser has paid a share the settlement proves", async () => {
    createsBooking(organiserPaidChild("SUCCEEDED"));
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sent()[0].templateData).toMatchObject({ amount: "$0.00", paymentNote: "" });
    expect(sent()[0].html).not.toContain("to pay on this booking");
    expect(sent()[0].html).not.toContain(ORGANISER_PAYS_LINE);
  });

  it("still tells the member, neutrally and once, when the snapshot cannot be read", async () => {
    failSnapshot = true;
    expect(await approve()).toMatchObject({ outcome: "executed" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sent()[0].templateData).toMatchObject({ paymentNote: NEUTRAL_LINE, amount: "" });
    expect(sent()[0].html).not.toMatch(/\$\d/);
  });

  it("does not send a new-booking notice for an existing-booking outcome", async () => {
    const { hooks } = buildHooks();
    await hooks.notifyApproved?.({ bookingId: "existing-booking" } as never);
    expect(reads).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the approval email's payment line, one per cash-cover answer", () => {
  const note = (cover: Parameters<typeof bookingPolicyExceptionApprovedPaymentNote>[0]["cover"], bedsHeld = false) =>
    bookingPolicyExceptionApprovedPaymentNote({ cover, bedsHeld }, CLUB_FORMAT_TEST);

  it("names the amount owed, with the held-bed sentence that is true", () => {
    expect(note({ kind: "owes", cents: 123_456 }, true)).toEqual({
      amount: "$1,234.56",
      paymentNote: "There is $1,234.56 to pay on this booking. Your beds are held for now; open it from your account to pay or to see the payment details.",
    });
    expect(note({ kind: "owes", cents: 5 }, false)).toEqual({
      amount: "$0.05",
      paymentNote: "There is $0.05 to pay on this booking. Open it from your account to pay now — the beds are not held until it is paid.",
    });
  });

  it("says nothing once the booking is covered, held or not", () => {
    expect(note({ kind: "covered" }, true)).toEqual({ amount: "$0.00", paymentNote: "" });
    expect(note({ kind: "covered" }, false)).toEqual({ amount: "$0.00", paymentNote: "" });
  });

  it("never asks a member whose organiser pays", () => {
    expect(note({ kind: "organiser_pays" }, true)).toEqual({ amount: "", paymentNote: ORGANISER_PAYS_LINE });
    expect(note({ kind: "organiser_pays" }, false)).toEqual({ amount: "", paymentNote: ORGANISER_PAYS_LINE });
  });

  it.each([
    { kind: "unknown", reason: "legacy-history" },
    { kind: "unknown", reason: "organiser-share-unproven" },
    null,
  ] as const)("gives the neutral line, with no amount and no 'paid', for %j", (cover) => {
    const line = note(cover, true);
    expect(line).toEqual({ amount: "", paymentNote: NEUTRAL_LINE });
    expect(line.paymentNote).not.toMatch(/\$|\d|\bpaid\b|\bheld\b/i);
  });
});
