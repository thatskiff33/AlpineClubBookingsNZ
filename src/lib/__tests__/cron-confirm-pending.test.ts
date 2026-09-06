import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripeSdkError as stripeError } from "./support/stripe-sdk-error";

// Mock Stripe
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

const mockChargePaymentMethod = vi.fn();
// #1992: the auto-charge claim sweeps and cancels in-flight /pay link intents
// before charging the saved card (best-effort, outside any transaction).
const mockCancelPaymentIntentIfCancellable = vi.fn();
// #3268: a permanently unusable saved card is detached at Stripe (best-effort)
// before it is cleared from every row that carries it.
const mockDetachPaymentMethod = vi.fn();
const mockMarkBookingPaymentSucceeded = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({
  queueOperationId: "op_1",
  message: "queued",
});
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue({
  found: 1,
  processed: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
});
// #3267: a replayed attempt that already names its intent is RETRIEVED, and a
// superseded attempt's intent is cancelled through the with-result variant so a
// capture can be recognised.
const mockGetPaymentIntent = vi.fn();
const mockCancelPaymentIntentIfCancellableWithResult = vi.fn();
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
  getPaymentIntent: (...args: unknown[]) => mockGetPaymentIntent(...args),
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellableWithResult(...args),
  cancelPaymentIntentIfCancellable: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellable(...args),
  detachPaymentMethod: (...args: unknown[]) => mockDetachPaymentMethod(...args),
}));
vi.mock("../xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("../payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
}));

// #3267: the cron no longer records its charge through
// `upsertPaymentIntentTransaction`; the attempt module (`saved-card-charge-attempt`,
// exercised for real here) reads `isCapturedTransactionStatus` from this module
// and re-derives the aggregate through `reconcilePaymentAggregates`, which is
// the one export replaced — the real one needs a Payment row to read.
const mockReconcilePaymentAggregates = vi.fn();
vi.mock("../payment-transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payment-transactions")>()),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
}));

const mockProcessWaitlistForDates = vi.fn().mockResolvedValue(undefined);
vi.mock("../waitlist", () => ({
  processWaitlistForDates: (...args: unknown[]) =>
    mockProcessWaitlistForDates(...args),
}));

// #2012: the request-hold terminal cancel RELEASES held capacity via the bed
// reconcile (unlike the split child, which holds none). Mock it as an
// observable no-op so tests can assert the release fires (or does not, on the
// lost-CAS path). Fire-and-forget side effect on beds; the reconcile logic
// itself is covered in bed-allocation-lifecycle.test.ts.
const mockReconcileBedAllocationsForBooking = vi
  .fn()
  .mockResolvedValue(undefined);
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...args: unknown[]) =>
    mockReconcileBedAllocationsForBooking(...args),
  reconcileBedAllocationsForBookingWithGlobalLockHeld: (...args: unknown[]) =>
    mockReconcileBedAllocationsForBooking(...args),
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mockReconcileBedAllocationsForBooking(...args),
}));

const mockEnqueueOwnHostingCoverage = vi.fn().mockResolvedValue(undefined);
const mockSettleHostingCoverage = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: (...args: unknown[]) =>
    mockEnqueueOwnHostingCoverage(...args),
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...args: unknown[]) =>
    mockSettleHostingCoverage(...args),
}));

// Mock email
const mockSendConfirmedEmail = vi.fn();
const mockSendBumpedEmail = vi.fn();
const mockSendGuestsRemovedEmail = vi.fn();
const mockSendGuestsCancelledEmail = vi.fn();
const mockSendAdminPaymentFailureAlert = vi.fn().mockResolvedValue(undefined);
const mockSendAdminHoldExpiredAlert = vi.fn().mockResolvedValue(undefined);
const mockSendSplitGuestPaymentLinkEmail = vi.fn().mockResolvedValue({
  status: "sent",
});
const mockSendAdminSplitSettlementUnpaidAlert = vi
  .fn()
  .mockResolvedValue(undefined);
// #1993 Part A: dedicated terminal admin notice for an auto-cancelled split
// child (its own registered template, not a finalNotice variant).
const mockSendAdminSplitSettlementCancelledAlert = vi
  .fn()
  .mockResolvedValue(undefined);
// #1993 Part A: dedicated member notice for an auto-cancelled split child's
// guest portion (replaces the misleading generic booking-cancelled email).
const mockSendSplitGuestPortionCancelledEmail = vi
  .fn()
  .mockResolvedValue(undefined);
// #2012: dedicated terminal notices for an auto-cancelled request-origin
// booking (its own registered templates, symmetric with #1993).
const mockSendAdminBookingRequestHoldCancelledEmail = vi
  .fn()
  .mockResolvedValue(undefined);
const mockSendBookingRequestPaymentExpiredEmail = vi
  .fn()
  .mockResolvedValue(undefined);
// #3268: the one member notice for a saved card the cron has given up on.
const mockSendSavedCardChargeFailedEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("../email", () => ({
  sendSavedCardChargeFailedEmail: (...args: unknown[]) =>
    mockSendSavedCardChargeFailedEmail(...args),
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendConfirmedEmail(...args),
  sendBookingBumpedEmail: (...args: unknown[]) => mockSendBumpedEmail(...args),
  sendBookingGuestsRemovedEmail: (...args: unknown[]) => mockSendGuestsRemovedEmail(...args),
  sendBookingGuestsCancelledEmail: (...args: unknown[]) => mockSendGuestsCancelledEmail(...args),
  sendSplitGuestPortionCancelledEmail: (...args: unknown[]) =>
    mockSendSplitGuestPortionCancelledEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendAdminBookingRequestHoldExpiredEmail: (...args: unknown[]) =>
    mockSendAdminHoldExpiredAlert(...args),
  sendAdminBookingRequestHoldCancelledEmail: (...args: unknown[]) =>
    mockSendAdminBookingRequestHoldCancelledEmail(...args),
  sendBookingRequestPaymentExpiredEmail: (...args: unknown[]) =>
    mockSendBookingRequestPaymentExpiredEmail(...args),
  sendSplitGuestPaymentLinkEmail: (...args: unknown[]) =>
    mockSendSplitGuestPaymentLinkEmail(...args),
  sendAdminSplitSettlementUnpaidAlert: (...args: unknown[]) =>
    mockSendAdminSplitSettlementUnpaidAlert(...args),
  sendAdminSplitSettlementCancelledAlert: (...args: unknown[]) =>
    mockSendAdminSplitSettlementCancelledAlert(...args),
}));

// #1993 Part B: the derived alert cadence anchors on the hold's original expiry,
// read back from the non-member hold policy. Default 7 days matches the standard
// split-child hold window; individual tests override it to exercise the cadence.
const mockGetNonMemberHoldDays = vi.fn().mockResolvedValue(7);
vi.mock("../cancellation", () => ({
  getNonMemberHoldDays: (...args: unknown[]) =>
    mockGetNonMemberHoldDays(...args),
}));

// The confirm-pending cron revokes payment links for bumped bookings
// (issue #707); the behaviour itself is covered in payment-link.test.ts.
const mockRevokePaymentLinksForBooking = vi.fn().mockResolvedValue(0);
// #1967: the settlement cron mints a guest-portion payment link for a split
// child with no card on file (default: first transition — returns a fresh
// link), and revokes a just-minted link by id when the member email fails.
// `expiresAt` is part of the mint's contract since #2870: the caller emails the
// instant the row really holds rather than deriving the boundary again.
const MINTED_LINK_EXPIRES_AT = new Date("2026-08-02T11:59:59.999Z");
const mockMintSplitGuestPaymentLinkIfAbsent = vi.fn().mockResolvedValue({
  token: "tok_split_1",
  paymentLinkId: "pl_split_1",
  expiresAt: MINTED_LINK_EXPIRES_AT,
});
const mockRevokePaymentLinkById = vi.fn().mockResolvedValue(1);
vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: (...args: unknown[]) =>
    mockRevokePaymentLinksForBooking(...args),
  revokePaymentLinkById: (...args: unknown[]) =>
    mockRevokePaymentLinkById(...args),
}));
// Partial mock: the mint is stubbed, the real SPLIT_GUEST_PAYMENT_LINK_TEMPLATE
// flows through so the withheld-row assertion below compares against the
// production constant rather than a second literal (INV-SSOT-002).
vi.mock("@/lib/payment-link-split-guest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payment-link-split-guest")>()),
  mintSplitGuestPaymentLinkIfAbsent: (...args: unknown[]) =>
    mockMintSplitGuestPaymentLinkIfAbsent(...args),
}));

// Mock promo cleanup used by the whole-bump path.
const mockDeletePromoRedemption = vi.fn().mockResolvedValue(undefined);
vi.mock("../promo", () => ({
  deletePromoRedemptionAndAdjustCount: (...args: unknown[]) =>
    mockDeletePromoRedemption(...args),
}));

// Mock capacity
const mockCheckCapacityForGuestRanges = vi.fn();
const mockAcquireLodgeCapacityLock = vi.fn().mockResolvedValue(undefined);
vi.mock("../capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mockCheckCapacityForGuestRanges(...args),
  acquireLodgeCapacityLock: (...args: unknown[]) =>
    mockAcquireLodgeCapacityLock(...args),
  LODGE_CAPACITY: 29,
}));

const mockLodgeFindFirst = vi.fn().mockResolvedValue({ id: "lodge-1" });
vi.mock("../lodges", () => ({
  getDefaultLodgeId: (...args: unknown[]) => mockLodgeFindFirst(...args).then((l: { id: string }) => l.id),
}));

// Mock Prisma
const mockBookingFindMany = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockPaymentUpsert = vi.fn();
// #1992: the pre-charge sweep reads in-flight PRIMARY intents off the ledger.
// #3267: so does the attempt module inside the claim (same findMany mock, a
// different `where`), which then CREATES the attempt row and stamps its key,
// and `settleSavedCardChargeAttempt` records Stripe's answer on it.
const mockPaymentTransactionFindMany = vi.fn();
const mockPaymentTransactionCreate = vi.fn();
const mockPaymentTransactionUpdate = vi.fn();
const mockPaymentTransactionFindUnique = vi.fn();
const mockPaymentTransactionDeleteMany = vi.fn();
/** The id the attempt row is minted with, so the key can be asserted exactly. */
const ATTEMPT_ROW_ID = "txn_attempt_1";
const attemptKeyFor = (bookingId: string) =>
  `pending_charge_${bookingId}_${ATTEMPT_ROW_ID}`;
const paymentTransactionMocks = {
  findMany: (...args: unknown[]) => mockPaymentTransactionFindMany(...args),
  create: (...args: unknown[]) => mockPaymentTransactionCreate(...args),
  update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
  updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
  findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
  deleteMany: (...args: unknown[]) => mockPaymentTransactionDeleteMany(...args),
};
const mockPromoRedemptionFindUnique = vi.fn();
// #1993 Part A: the terminal branch records a CANCELLED booking event in-tx.
const mockBookingEventCreate = vi.fn().mockResolvedValue({ id: "evt_1" });
const mockEmailLogFindFirst = vi.fn().mockResolvedValue(null);
const mockEmailLogCreate = vi.fn().mockResolvedValue({ id: "emaillog_1" });
const mockPrismaTransaction = vi.fn();
const mockExecuteRaw = vi.fn();
// #3268: retiring an unusable saved card clears it from every Payment row and
// every ledger row carrying that exact id, on the base client (no lock).
const mockPaymentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
const mockPaymentTransactionUpdateMany = vi
  .fn()
  .mockResolvedValue({ count: 0 });
// #2576: no hosting policy row, so the rule resolves off and the coverage enqueue
// never fires. Present because the production path reads them, not because these
// tests exercise them.
const mockAdultMemberHostingPolicyFindMany = vi.fn().mockResolvedValue([]);
/*
  #2870: the club's persisted timezone, which the cron now reads ONCE per run
  (outside every transaction) and threads into the terminal-state decisions and
  the link mint.

  It defaults to NO ROW so every test above resolves the same zone it always
  did: `readClubTimeZoneOutsideRequest` folds an absent row into the environment
  seed, which is `APP_TIME_ZONE`. The club-zone block at the end of this file is
  the only one that persists a value.
*/
const mockClubTimeSettingsFindUnique = vi.fn().mockResolvedValue(null);
/** Zone reads that happened inside a `$transaction` callback. Contract: 0. */
let zoneReadsInsideTransaction = 0;
const mockHostingCoverageReevaluationCreate = vi
  .fn()
  .mockResolvedValue({ id: "hcr_1" });
const mockHostingCoverageReevaluationFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    payment: {
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
      upsert: (...args: unknown[]) => mockPaymentUpsert(...args),
      updateMany: (...args: unknown[]) => mockPaymentUpdateMany(...args),
    },
    paymentTransaction: paymentTransactionMocks,
    promoRedemption: {
      findUnique: (...args: unknown[]) => mockPromoRedemptionFindUnique(...args),
    },
    // #1993 Part A: the CANCELLED narrative event is now recorded POST-COMMIT
    // on the base client (recordBookingEvent's documented contract), not inside
    // the lock transaction.
    bookingEvent: {
      create: (...args: unknown[]) => mockBookingEventCreate(...args),
    },
    // #2258: the withheld-send audit row for a split guest link that was never
    // minted because the booking has "No emails" turned on.
    emailLog: {
      findFirst: (...args: unknown[]) => mockEmailLogFindFirst(...args),
      create: (...args: unknown[]) => mockEmailLogCreate(...args),
    },
    // #2576 §8: the post-cycle drain reads this on the base client. Empty, so the
    // sweep is one read that finds nothing.
    hostingCoverageReevaluation: {
      findMany: (...args: unknown[]) =>
        mockHostingCoverageReevaluationFindMany(...args),
    },
    clubTimeSettings: {
      findUnique: (...args: unknown[]) =>
        mockClubTimeSettingsFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
  },
}));

const {
  confirmPendingBookings,
  splitSettlementExtensionNumber,
  shouldAlertOnSplitSettlementExtension,
  CONFIRM_PENDING_RUN_INTERVAL_MS,
  isFirstRunInExtensionWindow,
  shouldAlertOnSavedCardChargeRefusal,
} = await import("../cron-confirm-pending");

/*
  The environment's answer, IMPORTED rather than rebuilt.

  The club-zone block below used to compose it by hand as
  `process.env.TZ || process.env.NEXT_PUBLIC_TZ || "Pacific/Auckland"`. Same
  precedence, but not the same value: `src/config/operational.ts` TRIMS the
  variable, so a `TZ` carrying a stray space made the hand-rolled copy and the
  code under test disagree — and the zone chooser below excludes candidates by
  comparing against exactly this string, so a disagreement there hands the suite
  a candidate equal to the environment's and quietly stops it discriminating.
  One import cannot drift from the constant it is asserting against.
*/
const { APP_TIME_ZONE } = await import("@/config/operational");

function makePendingBooking(
  id: string,
  opts: {
    checkIn?: string;
    checkOut?: string;
    guestCount?: number;
    holdUntil?: string;
    hasPaymentMethod?: boolean;
    finalPriceCents?: number;
    parentBookingId?: string | null;
    // #3269: provenance is REQUIRED here so every test states whether the
    // parent's card was saved through a SetupIntent (reusable off-session) or
    // written by a one-off Payment Element checkout (Stripe refuses to charge it
    // again). Customer + pm alone no longer means "has a card".
    parentPayment?: {
      id: string;
      stripePaymentMethodId: string;
      stripeCustomerId: string;
      // #3268/#3269: whether the parent SAVED the card through a SetupIntent.
      stripeSetupIntentId: string | null;
    } | null;
    // Full parent snapshot (#1967): lets tests model the parent's lifecycle
    // status and payment source (IB-settled vs abandoned card). Takes
    // precedence over the parentPayment shorthand when provided.
    parentBooking?: {
      id?: string;
      status?: string;
      deletedAt?: Date | null;
      payment?: {
        id: string;
        source?: string;
        stripeCustomerId?: string | null;
        stripePaymentMethodId?: string | null;
        stripeSetupIntentId?: string | null;
      } | null;
    } | null;
    // #3269: overrides on the booking's OWN payment row (applied over the
    // default SetupIntent-saved card when `hasPaymentMethod` is true), so a test
    // can model a legacy laundered row — customer + pm copied from the parent,
    // no `stripeSetupIntentId`.
    ownPayment?: {
      stripeCustomerId?: string | null;
      stripePaymentMethodId?: string | null;
      stripeSetupIntentId?: string | null;
    };
    // #1967: a #796 group joiner's booking always carries a join row.
    groupBookingJoin?: { id: string } | null;
    originBookingRequest?: { id: string } | null;
    // #2430: a booking converted from a public booking request is owned by a
    // non-login NON_MEMBER/SCHOOL contact, which changes where the bumped
    // notice sends them.
    memberCanLogin?: boolean;
  } = {}
) {
  const {
    checkIn = "2026-07-15",
    checkOut = "2026-07-17",
    guestCount = 2,
    holdUntil = "2026-07-08",
    hasPaymentMethod = true,
    finalPriceCents = 10000,
    parentBookingId = null,
    parentPayment = null,
    parentBooking,
    ownPayment = {},
    groupBookingJoin = null,
    originBookingRequest = null,
    memberCanLogin = true,
  } = opts;
  const stayStart = new Date(checkIn);
  const stayEnd = new Date(checkOut);

  const resolvedParentBooking =
    parentBooking !== undefined
      ? parentBooking === null
        ? null
        : {
            id: parentBooking.id ?? parentBookingId ?? `parent_${id}`,
            status: parentBooking.status ?? "CONFIRMED",
            deletedAt: parentBooking.deletedAt ?? null,
            payment: parentBooking.payment ?? null,
          }
      : parentPayment
        ? {
            id: parentBookingId ?? `parent_${id}`,
            status: "PAYMENT_PENDING",
            deletedAt: null,
            payment: { source: "STRIPE", ...parentPayment },
          }
        : null;

  return {
    id,
    memberId: `member_${id}`,
    checkIn: new Date(checkIn),
    checkOut: new Date(checkOut),
    status: "PENDING",
    finalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    nonMemberHoldUntil: new Date(holdUntil),
    hasNonMembers: true,
    cancelIfGuestsBumped: false,
    parentBookingId,
    parentBooking: resolvedParentBooking,
    groupBookingJoin,
    originBookingRequest,
    promoRedemption: null,
    createdAt: new Date("2026-03-01"),
    member: {
      id: `member_${id}`,
      email: `${id}@example.com`,
      firstName: "Test",
      lastName: "User",
      canLogin: memberCanLogin,
    },
    guests: Array.from({ length: guestCount }, (_, i) => ({
      id: `guest_${id}_${i}`,
      bookingId: id,
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT",
      isMember: false,
      memberId: null as string | null,
      stayStart,
      stayEnd,
      priceCents: 5000,
    })),
    payment: hasPaymentMethod
      ? {
          id: `pay_${id}`,
          bookingId: id,
          stripePaymentMethodId: `pm_${id}`,
          stripeCustomerId: `cus_${id}`,
          stripeSetupIntentId: `seti_${id}`,
          amountCents: finalPriceCents,
          status: "PENDING",
          ...ownPayment,
        }
      : null,
  };
}

function mockPendingBookings(bookings: ReturnType<typeof makePendingBooking>[]) {
  mockBookingFindMany.mockResolvedValue(bookings);
  mockBookingFindUnique.mockImplementation(
    async ({
      where,
      select,
    }: {
      where: { id: string };
      select?: { status?: boolean };
    }) => {
      const booking = bookings.find((candidate) => candidate.id === where.id) ?? null;
      // The requires-action release runs in a later transaction after the
      // first transaction claimed CONFIRMED. The mock store is not stateful,
      // so model that post-lock status-only re-read explicitly.
      if (
        booking &&
        select?.status &&
        Object.keys(select).length === 1 &&
        mockBookingUpdateMany.mock.calls.some(
          ([call]) => call?.data?.status === "CONFIRMED",
        )
      ) {
        return { status: "CONFIRMED" };
      }
      return booking;
    }
  );
}

describe("Cron: Confirm Pending Bookings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T00:00:00.000Z"));
    vi.clearAllMocks();
    mockEnqueueXeroBookingInvoiceOperation.mockResolvedValue({
      queueOperationId: "op_1",
      message: "queued",
    });
    mockKickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentUpsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { bookingId: string };
        create?: { id?: string };
      }) => ({
        id: create?.id ?? `pay_${where.bookingId}`,
      })
    );
    mockPaymentTransactionFindMany.mockResolvedValue([]);
    // #3267: a fresh attempt row by default; settle updates it in place.
    mockPaymentTransactionCreate.mockResolvedValue({ id: ATTEMPT_ROW_ID });
    mockPaymentTransactionUpdate.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        paymentId: "pay_1",
      })
    );
    mockPaymentTransactionFindUnique.mockResolvedValue(null);
    mockPaymentTransactionDeleteMany.mockResolvedValue({ count: 0 });
    mockReconcilePaymentAggregates.mockResolvedValue(null);
    mockGetPaymentIntent.mockResolvedValue(null);
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { status: "canceled" },
    });
    mockCancelPaymentIntentIfCancellable.mockResolvedValue(null);
    mockDetachPaymentMethod.mockResolvedValue({ id: "pm_detached" });
    mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
    // #3267: a status-guarded write on ONE row (the settle, the FAILED mark, a
    // superseded row's end) matches it; the #3268 card clear (matched by pm id,
    // no row id) matches nothing by default.
    mockPaymentTransactionUpdateMany.mockImplementation(
      async ({ where }: { where: { id?: string; stripePaymentIntentId?: string } }) => ({
        count: where.id !== undefined || where.stripePaymentIntentId !== undefined ? 1 : 0,
      })
    );
    mockSendSavedCardChargeFailedEmail.mockResolvedValue(undefined);
    mockClubTimeSettingsFindUnique.mockResolvedValue(null);
    mockPromoRedemptionFindUnique.mockResolvedValue(null);
    mockDeletePromoRedemption.mockResolvedValue(undefined);
    mockRevokePaymentLinksForBooking.mockResolvedValue(0);
    mockMintSplitGuestPaymentLinkIfAbsent.mockResolvedValue({
      token: "tok_split_1",
      paymentLinkId: "pl_split_1",
      expiresAt: MINTED_LINK_EXPIRES_AT,
    });
    mockRevokePaymentLinkById.mockResolvedValue(1);
    mockSendSplitGuestPaymentLinkEmail.mockResolvedValue({ status: "sent" });
    mockSendAdminSplitSettlementUnpaidAlert.mockResolvedValue(undefined);
    mockSendAdminSplitSettlementCancelledAlert.mockResolvedValue(undefined);
    mockSendSplitGuestPortionCancelledEmail.mockResolvedValue(undefined);
    mockSendAdminBookingRequestHoldCancelledEmail.mockResolvedValue(undefined);
    mockSendBookingRequestPaymentExpiredEmail.mockResolvedValue(undefined);
    mockProcessWaitlistForDates.mockResolvedValue(undefined);
    mockReconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    mockGetNonMemberHoldDays.mockResolvedValue(7);
    mockBookingEventCreate.mockResolvedValue({ id: "evt_1" });
    zoneReadsInsideTransaction = 0;
    mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        // #2870: how many `clubTimeSettings` reads happened WHILE this callback
        // was running. Zero is the contract — the callback holds
        // `pg_advisory_xact_lock(1)` and the per-lodge capacity lock for its
        // whole length, and a settings query in there lengthens a lock every
        // cancel, capture, hold-release and capacity claim contends for. A
        // per-run call count cannot see this: a read that MOVED inside the
        // transaction but still ran once per run keeps that count at 1.
        const zoneReadsBefore = mockClubTimeSettingsFindUnique.mock.calls.length;
        try {
          return await arg({
          $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
          lodge: {
            findFirst: (...args: unknown[]) => mockLodgeFindFirst(...args),
          },
          booking: {
            findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
            update: (...args: unknown[]) => mockBookingUpdate(...args),
            updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
          },
          payment: {
            upsert: (...args: unknown[]) => mockPaymentUpsert(...args),
          },
          // #3267: the claim mints the attempt row in-tx; the PROCESSING
          // release records Stripe's answer on it in-tx.
          paymentTransaction: paymentTransactionMocks,
          promoRedemption: {
            findUnique: (...args: unknown[]) =>
              mockPromoRedemptionFindUnique(...args),
          },
          // #1993 Part A: the terminal branch records the CANCELLED event
          // inside the lock transaction.
          bookingEvent: {
            create: (...args: unknown[]) => mockBookingEventCreate(...args),
          },
          // #2576 §9: the confirming claim records the bounded same-owner hosting
          // re-evaluation inside this transaction. No policy row, so the resolver
          // lands on the built-in default (the rule off) and the enqueue is a no-op
          // — which is the state every existing expectation here assumes.
          adultMemberHostingPolicy: {
            findMany: (...args: unknown[]) =>
              mockAdultMemberHostingPolicyFindMany(...args),
          },
          hostingCoverageReevaluation: {
            create: (...args: unknown[]) =>
              mockHostingCoverageReevaluationCreate(...args),
          },
          });
        } finally {
          zoneReadsInsideTransaction +=
            mockClubTimeSettingsFindUnique.mock.calls.length - zoneReadsBefore;
        }
      }

      return Promise.all(arg as Promise<unknown>[]);
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "b1",
      bumpedBookingIds: [],
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries all expired provisional bookings in oldest-first order, including split children", async () => {
    mockPendingBookings([]);

    await confirmPendingBookings();

    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          parentBookingId: expect.anything(),
        }),
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("consumes the POST-lock re-read (not the pre-lock read) for the capacity check (H3)", async () => {
    // Pre-lock read is now a minimal key/eligibility select; the buggy order
    // consumed its stale dates/guests. Make the two reads differ and prove the
    // capacity check ran against the POST-lock snapshot.
    const preLock = makePendingBooking("b1", {
      checkIn: "2026-01-01",
      checkOut: "2026-01-03",
      guestCount: 1,
    });
    const postLock = makePendingBooking("b1", {
      checkIn: "2026-05-20",
      checkOut: "2026-05-22",
      guestCount: 3,
    });
    mockBookingFindMany.mockResolvedValue([preLock]);
    let readCount = 0;
    mockBookingFindUnique.mockImplementation(async () =>
      readCount++ === 0 ? preLock : postLock
    );
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    await confirmPendingBookings();

    // The pre-lock read selects only the lock key + early-bail fields.
    expect(mockBookingFindUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "b1" },
      select: { lodgeId: true, status: true, nonMemberHoldUntil: true },
    });
    // The capacity check ran against the POST-lock dates + guest set (May),
    // never the January data that only the pre-lock read carried.
    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      "lodge-1",
      postLock.checkIn,
      postLock.checkOut,
      postLock.guests,
      "b1",
      expect.anything()
    );
  });

  it("confirms a booking when capacity is available and payment succeeds", async () => {
    const booking = makePendingBooking("b1");
    // #3267 (INV-PAY-055): the key is the attempt row's — booking id for the
    // dashboard, the row's own id for uniqueness — never the bare shared key.
    const expectedIdempotencyKey = attemptKeyFor("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    expect(mockChargePaymentMethod).toHaveBeenCalledWith({
      amountCents: 10000,
      customerId: "cus_b1",
      paymentMethodId: "pm_b1",
      metadata: { bookingId: "b1", memberId: "member_b1" },
      idempotencyKey: expectedIdempotencyKey,
    });
    // The attempt row is minted inside the claim (after the Payment upsert,
    // before Stripe) and its key is stamped from its own id; the capture is
    // then recorded on it before markBookingPaymentSucceeded.
    expect(mockPaymentTransactionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: "pay_b1",
        kind: "PRIMARY",
        source: "STRIPE",
        amountCents: 10000,
        status: "PENDING",
        paymentMethodId: "pm_b1",
        reason: "pending_hold_auto_charge",
      }),
      select: { id: true },
    });
    expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ROW_ID },
      data: { reference: expectedIdempotencyKey },
    });
    expect(mockPaymentTransactionCreate.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockPaymentUpsert.mock.invocationCallOrder[0]!
    );
    expect(mockPaymentTransactionCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      mockChargePaymentMethod.mock.invocationCallOrder[0]!
    );
    // Forward only (#3267 fix round): a capture is written over anything but
    // refund history, through a status-guarded updateMany; a null card from
    // Stripe never nulls the card the row carries.
    const settle = mockPaymentTransactionUpdateMany.mock.calls.find(
      ([call]) => call?.data?.stripePaymentIntentId === "pi_auto_1"
    );
    expect(settle?.[0]).toEqual({
      where: { id: ATTEMPT_ROW_ID, status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] } },
      data: {
        stripePaymentIntentId: "pi_auto_1",
        status: "SUCCEEDED",
        amountCents: 10000,
      },
    });
    expect(
      mockPaymentTransactionUpdateMany.mock.invocationCallOrder[
        mockPaymentTransactionUpdateMany.mock.calls.indexOf(settle!)
      ]!
    ).toBeLessThan(mockMarkBookingPaymentSucceeded.mock.invocationCallOrder[0]!);
    expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();

    expect(mockSendConfirmedEmail).toHaveBeenCalledWith(
      { bookingId: "b1", recipientMemberId: "member_b1" },
      "b1@example.com",
      "Test",
      booking.checkIn,
      booking.checkOut,
      2,
      10000,
      // Multi-lodge phase 8: the options now carry the booking's lodge so
      // the email renders that lodge's identity (undefined here because the
      // fixture booking has no lodgeId).
      { lodgeId: undefined }
    );
  });

  it("charges a split non-member child using the parent booking's SetupIntent-saved card, without copying the card onto the child's row (#3269)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
        // Saved through a SetupIntent: attached to the customer, reusable.
        stripeSetupIntentId: "seti_parent_1",
      },
      finalPriceCents: 12000,
      guestCount: 1,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 3,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_child_1",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_parent_1",
    });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["child_1"]);
    expect(mockPaymentUpsert).toHaveBeenCalledWith({
      where: { bookingId: "child_1" },
      create: expect.objectContaining({
        bookingId: "child_1",
        amountCents: 12000,
        stripeCustomerId: "cus_parent_1",
      }),
      update: expect.objectContaining({
        amountCents: 12000,
        stripeCustomerId: "cus_parent_1",
      }),
    });
    // #3269: the parent's pm is charged from the resolved card object and is
    // NOT written onto the child's row — that copy is what turned a one-off
    // checkout artefact into a "saved card" every other reader trusted. The
    // key is absent, not undefined.
    const upsertArgs = mockPaymentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(Object.keys(upsertArgs.create)).not.toContain("stripePaymentMethodId");
    expect(Object.keys(upsertArgs.update)).not.toContain("stripePaymentMethodId");
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12000,
        customerId: "cus_parent_1",
        paymentMethodId: "pm_parent_1",
        metadata: { bookingId: "child_1", memberId: "member_child_1" },
      })
    );
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("child_1");
    // #1967 FIX-6: the auto-charge claim revokes any outstanding /pay link
    // inside the claim transaction, so a link minted while no card was on
    // file can never race the saved-card charge into a double payment.
    expect(mockRevokePaymentLinksForBooking).toHaveBeenCalledWith(
      "child_1",
      expect.anything()
    );
  });

  // #3269 / INV-PAY-053. What `markBookingPaymentSucceeded` leaves on a parent
  // that paid its own place by one-off Payment Element checkout: PAID, with the
  // customer and the payment method the PaymentIntent used, and NO SetupIntent.
  // Stripe refuses to charge that payment method again — so the child has no
  // card, and takes the same payment-link path as an Internet-Banking parent.
  const ONE_OFF_CHECKOUT_PARENT = {
    status: "PAID",
    payment: {
      id: "pay_parent_1",
      source: "STRIPE",
      stripeCustomerId: "cus_parent_1",
      stripePaymentMethodId: "pm_parent_1",
      stripeSetupIntentId: null,
    },
  };

  it("never borrows a parent's one-off checkout card: the split child is routed to the payment-link path and nothing is copied onto its row (#3269)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: ONE_OFF_CHECKOUT_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // The production incident: this used to charge pm_parent_1 (refused by
    // Stripe) and stamp it onto the child's Payment row.
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.failedBookingIds).toEqual([]);

    // Genuine split child with a settled parent: link minted, member emailed,
    // hold extended — the #1967 path, reached now by provenance, not by the
    // absence of ids.
    expect(mockMintSplitGuestPaymentLinkIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "child_1" }),
      expect.any(String)
    );
    expect(mockSendSplitGuestPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "child_1@example.com",
        token: "tok_split_1",
        priceCents: 12000,
        guestCount: 2,
      })
    );
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "child_1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledWith(
      expect.objectContaining({ parentUnpaid: false, totalCents: 12000 })
    );
  });

  it("no longer treats a legacy laundered child row (parent's one-off card copied on, no SetupIntent) as a saved card (#3269)", async () => {
    // A row the pre-#3269 cron left behind in production: the child's own
    // Payment carries the parent's customer + pm and no stripeSetupIntentId.
    // Reading it by provenance repairs it without a migration.
    const booking = makePendingBooking("child_1", {
      parentBookingId: "parent_1",
      parentBooking: ONE_OFF_CHECKOUT_PARENT,
      ownPayment: {
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
        stripeSetupIntentId: null,
      },
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.failedBookingIds).toEqual([]);
    expect(mockMintSplitGuestPaymentLinkIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "child_1" }),
      expect.any(String)
    );
    expect(mockSendSplitGuestPaymentLinkEmail).toHaveBeenCalled();
  });

  it("charges the child's own SetupIntent-saved card ahead of the parent's, and the claim writes only the customer onto the row (#3269)", async () => {
    // Own row: the fixture default is a SetupIntent-saved card. The parent's
    // one-off card is present and must be ignored.
    const booking = makePendingBooking("child_1", {
      parentBookingId: "parent_1",
      parentBooking: ONE_OFF_CHECKOUT_PARENT,
      finalPriceCents: 12000,
      guestCount: 1,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 3,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_child_1",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_child_1",
    });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["child_1"]);
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_child_1",
        paymentMethodId: "pm_child_1",
      })
    );
    // Own card: the claim still writes only the customer. Writing the pm back
    // "as a no-op" races the setup-intent route's replacement mint (#3266),
    // which nulls the pm beside a fresh SetupIntent id — the write-back would
    // resurrect the old card next to the new id and pass the provenance check.
    expect(mockPaymentUpsert).toHaveBeenCalledWith({
      where: { bookingId: "child_1" },
      create: expect.objectContaining({ stripeCustomerId: "cus_child_1" }),
      update: expect.objectContaining({ stripeCustomerId: "cus_child_1" }),
    });
    const ownUpsertArgs = mockPaymentUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(Object.keys(ownUpsertArgs.create)).not.toContain("stripePaymentMethodId");
    expect(Object.keys(ownUpsertArgs.update)).not.toContain("stripePaymentMethodId");
    expect(mockMintSplitGuestPaymentLinkIfAbsent).not.toHaveBeenCalled();
  });

  it("cancels a split non-member child without charge or invoice when capacity is gone", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
        stripeSetupIntentId: "seti_parent_1",
      },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["child_1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "child_1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("does not charge when another worker already claimed the expired booking", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockBookingUpdateMany.mockResolvedValueOnce({ count: 0 });

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.failedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("bumps a booking when capacity is not available", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);

    // R3 cancels the unresolved provisional booking without charging it.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });

    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
    expect(mockSendBumpedEmail).toHaveBeenCalled();
    // #2430: a club member's own bumped booking keeps the members-only
    // booking flow (the last argument is the owner's canLogin).
    expect(mockSendBumpedEmail.mock.calls[0].at(-1)).toBe(true);
  });

  // #2430: the same bump, but the booking came from a public booking request,
  // so it is owned by a contact that can never sign in. The notice must not
  // send them to /book.
  it("tells the bumped-email sender when the owner cannot sign in (#2430)", async () => {
    const booking = makePendingBooking("b1", {
      hasPaymentMethod: false,
      originBookingRequest: { id: "req_1" },
      memberCanLogin: false,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockSendBumpedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendBumpedEmail.mock.calls[0].at(-1)).toBe(false);
  });

  // #1771 — a hold-eligible PENDING booking deliberately admitted over the
  // ceiling by an admin carries a persisted capacityOverriddenAt marker. The
  // hold-window re-check must NOT bump it: it falls through and confirms
  // (here a $0 booking straight to PAID). This is the read-site that lets
  // booking-create retire its PENDING carve-out.
  it("confirms an over-capacity PENDING booking with a persisted capacity override instead of bumping it (#1771)", async () => {
    const booking = {
      ...makePendingBooking("b1", { finalPriceCents: 0 }),
      capacityOverriddenAt: new Date("2026-06-01"),
      capacityOverriddenByMemberId: "admin-1",
    };
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    // Confirmed, not bumped.
    expect(result.bumpedBookingIds).not.toContain("b1");
    expect(result.confirmedBookingIds).toEqual(["b1"]);
    // The $0 booking is claimed straight to PAID; it is never CANCELLED.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAID", nonMemberHoldUntil: null },
    });
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
    expect(mockEnqueueOwnHostingCoverage).toHaveBeenCalledWith("b1", expect.anything(), {
      cause: "SYSTEM_CHANGE",
    });
    expect(mockEnqueueOwnHostingCoverage.mock.invocationCallOrder[0]).toBeLessThan(
      mockSettleHostingCoverage.mock.invocationCallOrder[0],
    );
    expect(mockSendBumpedEmail).not.toHaveBeenCalled();
  });

  it("fails gracefully when no payment method is saved", async () => {
    const booking = makePendingBooking("b1", { hasPaymentMethod: false });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("processes multiple bookings independently", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockPendingBookings([booking1, booking2]);

    // b1: available, payment succeeds
    // b2: not available, bump
    mockCheckCapacityForGuestRanges
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] })
      .mockResolvedValueOnce({ available: false, minAvailable: 0, nightDetails: [] });

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(result.bumpedBookingIds).toEqual(["b2"]);
  });

  it("handles Stripe charge failure gracefully", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockRejectedValue(new Error("Card declined"));

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toHaveLength(0);
  });

  it("handles payment in processing state (requires_action)", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "requires_action",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    // Not confirmed yet (waiting for webhook), not failed
    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);

    // #3267: Stripe's answer is recorded on the attempt row (`requires_action`
    // maps to PROCESSING), inside the locked release transaction, forward only
    // (a non-capture is written only over an unresolved row), and a null card
    // from Stripe never nulls the card the row carries.
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: { id: ATTEMPT_ROW_ID, status: { in: ["PENDING", "PROCESSING"] } },
      data: {
        stripePaymentIntentId: "pi_auto_1",
        status: "PROCESSING",
        amountCents: 10000,
      },
    });
    expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: booking.nonMemberHoldUntil,
      },
    });
    const releaseLockOrder = mockAcquireLodgeCapacityLock.mock.invocationCallOrder.at(-1);
    const releaseClaimOrder = mockBookingUpdateMany.mock.invocationCallOrder.at(-1);
    const releaseReconcileOrder =
      mockReconcileBedAllocationsForBooking.mock.invocationCallOrder.at(-1);
    expect(releaseLockOrder).toBeDefined();
    expect(releaseClaimOrder).toBeDefined();
    expect(releaseReconcileOrder).toBeDefined();
    expect(releaseLockOrder!).toBeLessThan(releaseClaimOrder!);
    expect(releaseClaimOrder!).toBeLessThan(releaseReconcileOrder!);
    expect(mockReconcileBedAllocationsForBooking).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bookingId: "b1",
        db: expect.anything(),
      }),
    );
  });

  it("does nothing when no pending bookings are past hold deadline", async () => {
    mockPendingBookings([]);

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toHaveLength(0);
    expect(result.bumpedBookingIds).toHaveLength(0);
    expect(result.failedBookingIds).toHaveLength(0);
    expect(mockCheckCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("continues processing remaining bookings when one fails", async () => {
    const booking1 = makePendingBooking("b1");
    const booking2 = makePendingBooking("b2");
    mockPendingBookings([booking1, booking2]);

    mockCheckCapacityForGuestRanges
      .mockRejectedValueOnce(new Error("DB error")) // b1 fails
      .mockResolvedValueOnce({ available: true, minAvailable: 10, nightDetails: [] }); // b2 succeeds

    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_2",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(result.confirmedBookingIds).toEqual(["b2"]);
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("passes guest stay ranges and booking ID to range capacity as excludeBookingId", async () => {
    const booking = makePendingBooking("b1", { guestCount: 3 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdate.mockResolvedValue({});

    await confirmPendingBookings();

    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      "lodge-1",
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      "b1",
      expect.objectContaining({})
    );
  });

  it("continues when Xero invoice queueing fails during pending confirmation", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockPaymentUpdate.mockResolvedValue({});
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero unavailable"));

    const result = await confirmPendingBookings();

    expect(result.confirmedBookingIds).toEqual(["b1"]);
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("b1");
  });

  it("does not revert or alert when local persistence fails after Stripe already succeeded", async () => {
    const booking = makePendingBooking("b1");
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_auto_1",
      status: "succeeded",
      amount: 10000,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValueOnce(
      new Error("Payment update failed")
    );

    const result = await confirmPendingBookings();

    expect(result.failedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CONFIRMED", nonMemberHoldUntil: null },
    });
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: booking.nonMemberHoldUntil,
      },
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  // --- issue #737: no partial bump or reduced members-only charge at hold
  // expiry. Members pay up front, so a PENDING booking that no longer fits is
  // bumped whole (the bump-on-no-capacity safety). The synchronous
  // most-recent-first / partial bump in bumping.ts is unchanged (#708) and
  // covered in bumping.test.ts. ---

  function makeMixedPendingBooking(
    opts: {
      id?: string;
      cancelIfGuestsBumped?: boolean;
      hasPaymentMethod?: boolean;
      finalPriceCents?: number;
    } = {}
  ) {
    const {
      id = "b1",
      cancelIfGuestsBumped = false,
      hasPaymentMethod = true,
      finalPriceCents = 18000,
    } = opts;
    const base = makePendingBooking(id, { hasPaymentMethod, finalPriceCents });
    base.guests = [
      {
        id: `${id}_m0`,
        bookingId: id,
        firstName: "Member",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: true,
        memberId: `mem_${id}`,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 8000,
      },
      {
        id: `${id}_n0`,
        bookingId: id,
        firstName: "NonMember",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: base.checkIn,
        stayEnd: base.checkOut,
        priceCents: 10000,
      },
    ];
    return { ...base, cancelIfGuestsBumped };
  }

  it("cancels the whole booking when the cancel-if-guests-bumped flag is set", async () => {
    const booking = makeMixedPendingBooking({ cancelIfGuestsBumped: true });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockSendGuestsCancelledEmail).toHaveBeenCalled();
    expect(mockSendBumpedEmail).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
  });

  it("whole-bumps a mixed booking at hold expiry without charging a reduced members-only amount", async () => {
    const booking = makeMixedPendingBooking({ finalPriceCents: 18000 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // No reduced members-only charge (issue #737).
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    // A regular (unflagged) bump sends the bumped email, not guests-cancelled.
    expect(mockSendBumpedEmail).toHaveBeenCalled();
    expect(mockSendGuestsCancelledEmail).not.toHaveBeenCalled();
  });

  it("whole-bumps a no-card mixed booking at hold expiry instead of repricing it", async () => {
    const booking = makeMixedPendingBooking({ hasPaymentMethod: false, finalPriceCents: 18000 });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(result.partialBumpedBookingIds).toEqual([]);
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Never routed to PAYMENT_PENDING (the old reprice-and-owe path is gone).
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING" },
    });
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
  });

  it("extends the hold and alerts admins for a request-origin booking, never charging it (#707)", async () => {
    const booking = makePendingBooking("b1", {
      hasPaymentMethod: false,
      originBookingRequest: { id: "req_1" },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // Request-origin bookings pay via a tokenised link, never a saved card.
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    // Hold extended via the status-claim; booking stays PENDING (not failed).
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "b1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(result.failedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);
    expect(mockSendAdminHoldExpiredAlert).toHaveBeenCalled();
  });

  it("cancels and revokes the payment link for a request-origin booking when capacity is gone (#707/#708)", async () => {
    const booking = makePendingBooking("b1", {
      hasPaymentMethod: false,
      originBookingRequest: { id: "req_1" },
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    expect(result.bumpedBookingIds).toEqual(["b1"]);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CANCELLED", nonMemberHoldUntil: null },
    });
    expect(mockRevokePaymentLinksForBooking).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({})
    );
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  // #2012 — the symmetric twin of #1993 Part A for request-origin bookings
  // (#707). Two behaviours: (1) a terminal auto-cancel once the check-in day has
  // ended that RELEASES the booking's held capacity (unlike the split child,
  // which holds none), and (2) the #1993 Part B capped alert cadence applied to
  // the previously-every-run pre-check-in hold-expired admin alert.
  describe("#2012 request-hold terminal auto-cancel + capped cadence", () => {
    it("cancels a past-check-in unpaid request booking: guarded CAS, in-tx link revoke + capacity release, POST-COMMIT event, requester email + dedicated final admin notice, waitlist wake, no charge, no Xero", async () => {
      const booking = makePendingBooking("b1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        originBookingRequest: { id: "req_1" },
        finalPriceCents: 14000,
        guestCount: 2,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      // Terminal cancel bucket; never confirmed/bumped/failed.
      expect(result.cancelledBookingIds).toEqual(["b1"]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.bumpedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);

      // Guarded PENDING -> CANCELLED CAS.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith({
        where: { id: "b1", status: "PENDING" },
        data: { status: "CANCELLED", nonMemberHoldUntil: null },
      });

      // Capacity released (bed reconcile) and link revoked IN the transaction;
      // CANCELLED narrative event recorded POST-COMMIT on the base client.
      expect(mockReconcileBedAllocationsForBooking).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "b1" })
      );
      expect(mockRevokePaymentLinksForBooking).toHaveBeenCalledWith(
        "b1",
        expect.anything()
      );
      expect(mockBookingEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId: "b1",
            type: "CANCELLED",
          }),
        })
      );

      // Never charged, never touched Xero, never extended the hold, and the
      // recurring hold-expired alert did NOT fire on the terminal run.
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
      expect(mockBookingUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { nonMemberHoldUntil: expect.any(Date) },
        })
      );
      expect(mockSendAdminHoldExpiredAlert).not.toHaveBeenCalled();

      // Post-commit: dedicated requester payment-expired email + ONE dedicated
      // terminal admin notice + waitlist wake for the freed beds.
      expect(mockSendBookingRequestPaymentExpiredEmail).toHaveBeenCalledTimes(1);
      expect(mockSendBookingRequestPaymentExpiredEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "b1@example.com",
          firstName: "Test",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })
      );
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).toHaveBeenCalledTimes(1);
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterName: "Test User",
          totalCents: 14000,
          guestCount: 2,
        })
      );
      expect(mockProcessWaitlistForDates).toHaveBeenCalledWith(
        expect.objectContaining({
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })
      );
    });

    it("records the CANCELLED event post-commit so a bookingEvent write failure never blocks the cancel", async () => {
      const booking = makePendingBooking("b1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        originBookingRequest: { id: "req_1" },
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });
      mockBookingEventCreate.mockRejectedValueOnce(
        new Error("event insert failed")
      );

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual(["b1"]);
      expect(result.failedBookingIds).toEqual([]);
      expect(mockBookingUpdateMany).toHaveBeenCalledWith({
        where: { id: "b1", status: "PENDING" },
        data: { status: "CANCELLED", nonMemberHoldUntil: null },
      });
      // Notices still went out despite the swallowed event failure.
      expect(mockSendBookingRequestPaymentExpiredEmail).toHaveBeenCalledTimes(1);
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).toHaveBeenCalledTimes(1);
    });

    it("does not cancel when a payment won the lock first (CAS count 0): already_processed, zero side effects — also the idempotent-rerun guard", async () => {
      const booking = makePendingBooking("b1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        originBookingRequest: { id: "req_1" },
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });
      // The guarded PENDING -> CANCELLED CAS finds no PENDING row: a /pay
      // settlement (or a prior cron pass) resolved it seconds earlier. A second
      // cron pass on an already-cancelled booking takes this same branch.
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual([]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      // Zero side effects on the lost claim: no capacity release, no revoke, no
      // event, no requester email, no admin notice, no waitlist.
      expect(mockReconcileBedAllocationsForBooking).not.toHaveBeenCalled();
      expect(mockRevokePaymentLinksForBooking).not.toHaveBeenCalled();
      expect(mockBookingEventCreate).not.toHaveBeenCalled();
      expect(mockSendBookingRequestPaymentExpiredEmail).not.toHaveBeenCalled();
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).not.toHaveBeenCalled();
      expect(mockProcessWaitlistForDates).not.toHaveBeenCalled();
    });

    it("still auto-charges a past-check-in request booking that DOES have a saved card (terminal cancel is only for the no-card path)", async () => {
      const booking = makePendingBooking("b1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: true,
        originBookingRequest: { id: "req_1" },
        finalPriceCents: 14000,
        guestCount: 1,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_req_charge",
        status: "succeeded",
        amount: 14000,
        payment_method: "pm_b1",
      });

      const result = await confirmPendingBookings();

      // The saved-card path settles it; the terminal cancel never runs.
      expect(result.cancelledBookingIds).toEqual([]);
      expect(result.confirmedBookingIds).toEqual(["b1"]);
      expect(mockChargePaymentMethod).toHaveBeenCalled();
      expect(mockSendBookingRequestPaymentExpiredEmail).not.toHaveBeenCalled();
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).not.toHaveBeenCalled();
    });

    it("before the check-in day, still extends the hold and alerts admins on window 1 (no terminal cancel)", async () => {
      // Default dates: checkIn 2026-07-15 (future), origin = checkIn - 7d =
      // 2026-07-08; now 2026-07-09 => window 1 => alert.
      const booking = makePendingBooking("b1", {
        hasPaymentMethod: false,
        originBookingRequest: { id: "req_1" },
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual([]);
      // Hold extended (low-churn continues), not cancelled.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "b1", status: "PENDING" }),
          data: { nonMemberHoldUntil: expect.any(Date) },
        })
      );
      expect(mockSendAdminHoldExpiredAlert).toHaveBeenCalledTimes(1);
      expect(
        mockSendAdminBookingRequestHoldCancelledEmail
      ).not.toHaveBeenCalled();
    });

    it("caps the pre-check-in admin alert: stays silent on a capped window (4) while still extending the hold", async () => {
      // Anchor the origin at 2026-07-02 (now - 7d => window 4, silent) via a
      // 40-day hold and a check-in far enough ahead that the terminal branch
      // does not fire.
      mockGetNonMemberHoldDays.mockResolvedValue(40);
      const booking = makePendingBooking("b1", {
        checkIn: "2026-08-11",
        checkOut: "2026-08-13",
        hasPaymentMethod: false,
        originBookingRequest: { id: "req_1" },
      });
      booking.createdAt = new Date("2026-03-01T00:00:00.000Z");
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      // Hold still extended, but no admin alert this window, and not cancelled.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "b1", status: "PENDING" }),
          data: { nonMemberHoldUntil: expect.any(Date) },
        })
      );
      expect(mockSendAdminHoldExpiredAlert).not.toHaveBeenCalled();
      expect(result.cancelledBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
    });
  });

  // A genuinely Internet-Banking-settled parent: switch-at-pay flips the
  // parent to CONFIRMED with an IB-source payment carrying no card ids.
  const IB_SETTLED_PARENT = {
    status: "CONFIRMED",
    payment: {
      id: "pay_parent_1",
      source: "INTERNET_BANKING",
      stripeCustomerId: null,
      stripePaymentMethodId: null,
    },
  };

  it("emails a payment link and alerts admins for a split child whose parent paid by internet banking, never charging it (#1967)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // Never charged (no saved card), never marked failed, never confirmed.
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(result.failedBookingIds).toEqual([]);
    expect(result.confirmedBookingIds).toEqual([]);

    // A guest-portion payment link was minted (first transition) and the hold
    // extended via the status-guarded claim.
    expect(mockMintSplitGuestPaymentLinkIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "child_1", checkIn: booking.checkIn }),
      // #2870: the zone is threaded in, never read under the lock.
      expect.any(String)
    );
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "child_1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );

    // Member emailed the link; admins alerted with parent-settled wording.
    expect(mockSendSplitGuestPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "child_1@example.com",
        token: "tok_split_1",
        priceCents: 12000,
        guestCount: 2,
        bookingReference: "child_1",
        // #2870: the email states the instant the ROW holds. A second
        // derivation here is what let the page, the email and the stored value
        // mean three different moments.
        expiresAt: MINTED_LINK_EXPIRES_AT,
      })
    );
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Test User",
        totalCents: 12000,
        guestCount: 2,
        holdUntil: expect.any(Date),
        parentUnpaid: false,
      })
    );
    // Nothing failed, so the just-minted link is never revoked.
    expect(mockRevokePaymentLinkById).not.toHaveBeenCalled();
  });

  it("does not re-send the member link on a later run when a link is already active, but still re-alerts admins each extension run (#1967 FIX-4)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    // An active link already exists from a prior run: mint returns null.
    mockMintSplitGuestPaymentLinkIfAbsent.mockResolvedValue(null);

    const result = await confirmPendingBookings();

    // Hold still re-extended (low-churn) and no duplicate member email, but
    // the admin alert repeats every extension run while unsettled.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "child_1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(mockSendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledWith(
      expect.objectContaining({ parentUnpaid: false })
    );
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(result.failedBookingIds).toEqual([]);
  });

  it("never mints or emails a link for a split child whose parent abandoned a card payment; alerts admins with parent-unpaid wording (#1967 FIX-1)", async () => {
    // Realistic abandoned-card parent: PAYMENT_PENDING with a Stripe-source
    // payment that never captured a card. savedPaymentMethodForBooking is
    // null for it — exactly like an IB parent — so only the settled-parent
    // gate keeps this child out of the payment-link branch.
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: {
        status: "PAYMENT_PENDING",
        payment: {
          id: "pay_parent_1",
          source: "STRIPE",
          stripeCustomerId: null,
          stripePaymentMethodId: null,
        },
      },
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // The guest portion must not become settleable while the member's own
    // place is unpaid: no link minted, no member email asserting false facts.
    expect(mockMintSplitGuestPaymentLinkIfAbsent).not.toHaveBeenCalled();
    expect(mockSendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();

    // Hold extended (the alert-cadence claim) and the dedicated admin alert
    // fired with parent-unpaid wording; still surfaced as failed.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "child_1", status: "PENDING" }),
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledWith(
      expect.objectContaining({ parentUnpaid: true, totalCents: 12000 })
    );
    expect(result.failedBookingIds).toEqual(["child_1"]);
  });

  it("keeps a card-less #796 group joiner on the legacy missing_payment_method path, never the split-guest branch (#1967 FIX-2)", async () => {
    const booking = makePendingBooking("joiner_1", {
      hasPaymentMethod: false,
      parentBookingId: "organiser_1",
      // The organiser's booking is fully settled — without the join-row
      // discriminator this joiner would sail into the split-guest branch.
      parentBooking: { status: "PAID", payment: null },
      groupBookingJoin: { id: "join_1" },
      finalPriceCents: 8000,
      guestCount: 1,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const result = await confirmPendingBookings();

    // Pre-existing behaviour, exactly: error-logged failure, no mint, no
    // emails, no alert, no hold extension.
    expect(mockMintSplitGuestPaymentLinkIfAbsent).not.toHaveBeenCalled();
    expect(mockSendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
    expect(mockSendAdminSplitSettlementUnpaidAlert).not.toHaveBeenCalled();
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nonMemberHoldUntil: expect.any(Date) },
      })
    );
    expect(result.failedBookingIds).toEqual(["joiner_1"]);
  });

  it("revokes the just-minted link when the member email throws, so the next run re-mints and re-sends (#1967 FIX-3a)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockSendSplitGuestPaymentLinkEmail.mockRejectedValue(
      new Error("SES unavailable")
    );

    const result = await confirmPendingBookings();

    // The unreachable token's link is revoked BY ID (a newer concurrent link
    // must survive), clearing the sentinel for the next extension run.
    expect(mockRevokePaymentLinkById).toHaveBeenCalledWith("pl_split_1");
    // The admin alert is independent of the member email outcome.
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledWith(
      expect.objectContaining({ parentUnpaid: false })
    );
    expect(result.failedBookingIds).toEqual([]);
  });

  // #2258: before this, the cron minted a link, found the email withheld, and
  // revoked it — every run, forever, filling the booking's withheld list with
  // identical rows.
  it("mints no split guest link at all when the booking has No emails on, and records the withhold once", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockEmailLogFindFirst.mockResolvedValue(null);
    // The pre-mint gate reads only the switch columns.
    mockBookingFindUnique.mockImplementation(
      async ({ select }: { select?: Record<string, unknown> }) =>
        select?.noEmails
          ? { noEmails: true, noEmailsAt: new Date("2026-07-08T00:00:00.000Z") }
          : booking
    );

    await confirmPendingBookings();

    expect(mockMintSplitGuestPaymentLinkIfAbsent).not.toHaveBeenCalled();
    expect(mockSendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
    expect(mockRevokePaymentLinkById).not.toHaveBeenCalled();
    const { SPLIT_GUEST_PAYMENT_LINK_TEMPLATE } = await import(
      "@/lib/payment-link-split-guest"
    );
    expect(mockEmailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId: "child_1",
          templateName: SPLIT_GUEST_PAYMENT_LINK_TEMPLATE,
          status: "SKIPPED_NO_EMAILS",
        }),
      })
    );
    // The hold is still extended and the operator is still told the guest
    // portion is unpaid — silencing the member must not silence the club.
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalled();
  });

  it("writes no second withheld row when this episode already recorded one", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockBookingFindUnique.mockImplementation(
      async ({ select }: { select?: Record<string, unknown> }) =>
        select?.noEmails
          ? { noEmails: true, noEmailsAt: new Date("2026-07-08T00:00:00.000Z") }
          : booking
    );
    mockEmailLogFindFirst.mockResolvedValue({ id: "emaillog_existing" });

    await confirmPendingBookings();

    expect(mockEmailLogCreate).not.toHaveBeenCalled();
    // The once-check is scoped to THIS episode, so a later re-enable records
    // afresh rather than returning the first episode's stale row.
    expect(mockEmailLogFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date("2026-07-08T00:00:00.000Z") },
        }),
      })
    );
  });

  // The flip race: the switch goes on between the pre-mint gate and the send.
  it("revokes the token but does not re-mint next run when the send is withheld mid-flight", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockSendSplitGuestPaymentLinkEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "child_1",
      reason: "booking_no_emails",
    });

    await confirmPendingBookings();

    // The unreachable token is still cleaned up...
    expect(mockRevokePaymentLinkById).toHaveBeenCalledWith("pl_split_1");
    // ...and the operator is still told.
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalled();
  });

  // A fail-CLOSED withhold is a transient fault, not a standing decision, so it
  // keeps ordinary retry semantics (#2258 R5).
  it("treats an unreadable switch mid-flight as a retryable failure, not a withhold", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockSendSplitGuestPaymentLinkEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log_1",
      bookingId: "child_1",
      reason: "booking_flag_unreadable",
    });

    await confirmPendingBookings();

    expect(mockRevokePaymentLinkById).toHaveBeenCalledWith("pl_split_1");
  });

  it("revokes the just-minted link when the member email is suppressed (#1967 FIX-3a)", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    mockSendSplitGuestPaymentLinkEmail.mockResolvedValue({
      status: "suppressed",
      emailLogId: null,
      emailSuppressionId: "sup_1",
      reason: "bounce",
    });

    await confirmPendingBookings();

    expect(mockRevokePaymentLinkById).toHaveBeenCalledWith("pl_split_1");
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalled();
  });

  it("is idempotent across consecutive cron runs: one member email, one link, an admin alert per run (#1967 cross-run)", async () => {
    // Stateful sentinel mirroring the real mint helper's contract (the real
    // helper's own cross-run behaviour is pinned against a stateful store in
    // payment-link.test.ts): the first run mints, every later run sees the
    // active link and returns null. Exercises two REAL consecutive
    // confirmPendingBookings() invocations rather than asserting on a single
    // mocked return value.
    const activeLinks = new Set<string>();
    let mintCounter = 0;
    mockMintSplitGuestPaymentLinkIfAbsent.mockImplementation(
      async (_tx: unknown, target: { id: string }) => {
        if (activeLinks.has(target.id)) return null;
        activeLinks.add(target.id);
        mintCounter += 1;
        return {
          token: `tok_${mintCounter}`,
          paymentLinkId: `pl_${mintCounter}`,
          expiresAt: MINTED_LINK_EXPIRES_AT,
        };
      }
    );
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentBooking: IB_SETTLED_PARENT,
      finalPriceCents: 12000,
      guestCount: 2,
    });
    mockPendingBookings([booking]);
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    await confirmPendingBookings();
    // Second run: in production the extended hold keeps this child out of the
    // candidate query for ~2 days; even if it is re-processed (extension
    // elapsed, or the claim raced), the active link suppresses a second email.
    await confirmPendingBookings();

    expect(mockSendSplitGuestPaymentLinkEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSplitGuestPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok_1" })
    );
    // The admin alert repeats per extension run (FIX-4).
    expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledTimes(2);
    expect(mockRevokePaymentLinkById).not.toHaveBeenCalled();
  });

  // #1993 Part A — terminal state: a split non-member child still PENDING
  // (unsettled, no saved card) once its check-in day has ended is auto-cancelled
  // under the lodge lock (Option 1). now is 2026-07-09; a check-in of 2026-07-01
  // has an ended check-in day, so these children are past check-in.
  describe("#1993 terminal auto-cancel at end of check-in day", () => {
    it("cancels a past-check-in unsettled split child: guarded CAS, in-tx link revoke, POST-COMMIT CANCELLED event, member email + dedicated final admin notice, no charge, no Xero", async () => {
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: IB_SETTLED_PARENT,
        finalPriceCents: 12000,
        guestCount: 2,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      // Terminal cancel bucket; never confirmed/bumped/failed.
      expect(result.cancelledBookingIds).toEqual(["child_1"]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.bumpedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);

      // Guarded PENDING -> CANCELLED CAS.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith({
        where: { id: "child_1", status: "PENDING" },
        data: { status: "CANCELLED", nonMemberHoldUntil: null },
      });

      // Link revocation happens IN the transaction (revoke receives the tx
      // client); the CANCELLED narrative event is recorded POST-COMMIT on the
      // base client per booking-events.ts (L1 fix — never in-tx).
      expect(mockRevokePaymentLinksForBooking).toHaveBeenCalledWith(
        "child_1",
        expect.anything()
      );
      expect(mockBookingEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId: "child_1",
            type: "CANCELLED",
          }),
        })
      );

      // Never re-minted a link, never charged, never touched Xero (an unsettled
      // child has no invoice), never extended the hold.
      expect(mockMintSplitGuestPaymentLinkIfAbsent).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
      expect(mockBookingUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { nonMemberHoldUntil: expect.any(Date) },
        })
      );

      // Post-commit: dedicated member guest-portion-cancelled email (parent
      // settled => "own booking remains confirmed") + ONE dedicated terminal
      // admin notice (its own template, no finalNotice flag on the recurring
      // alert, which is never called on the terminal path).
      expect(mockSendSplitGuestPortionCancelledEmail).toHaveBeenCalledTimes(1);
      expect(mockSendSplitGuestPortionCancelledEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "child_1@example.com",
          firstName: "Test",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          parentConfirmed: true,
          parentBookingReference: "parent_1",
        })
      );
      expect(mockSendAdminSplitSettlementUnpaidAlert).not.toHaveBeenCalled();
      expect(mockSendAdminSplitSettlementCancelledAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminSplitSettlementCancelledAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          parentUnpaid: false,
          totalCents: 12000,
        })
      );
      // The dedicated terminal notice has no finalNotice flag (it is its own
      // registered template, not a variant of the recurring alert).
      expect(
        mockSendAdminSplitSettlementCancelledAlert.mock.calls[0][0]
      ).not.toHaveProperty("finalNotice");
    });

    it("records the CANCELLED event post-commit so a bookingEvent write failure never blocks the cancel (L1)", async () => {
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: IB_SETTLED_PARENT,
        finalPriceCents: 12000,
        guestCount: 2,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });
      // The narrative INSERT rejects. Because it runs post-commit on the base
      // client (recordBookingEvent swallows its own failure), the cancel — which
      // already committed under the lock — must still stand, and the member +
      // admin notices must still fire.
      mockBookingEventCreate.mockRejectedValueOnce(new Error("event insert failed"));

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual(["child_1"]);
      expect(result.failedBookingIds).toEqual([]);
      // The CAS still committed the cancel.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith({
        where: { id: "child_1", status: "PENDING" },
        data: { status: "CANCELLED", nonMemberHoldUntil: null },
      });
      // Notifications still went out despite the swallowed event failure.
      expect(mockSendSplitGuestPortionCancelledEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminSplitSettlementCancelledAlert).toHaveBeenCalledTimes(1);
    });

    it("uses not-settled member wording and parent-unpaid admin wording when the parent's own place is also unpaid", async () => {
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: {
          status: "PAYMENT_PENDING",
          payment: {
            id: "pay_parent_1",
            source: "STRIPE",
            stripeCustomerId: null,
            stripePaymentMethodId: null,
          },
        },
        finalPriceCents: 12000,
        guestCount: 2,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual(["child_1"]);
      // Member email must NOT promise "own booking remains confirmed" when the
      // parent is itself unsettled.
      expect(mockSendSplitGuestPortionCancelledEmail).toHaveBeenCalledWith(
        expect.objectContaining({ parentConfirmed: false })
      );
      expect(mockSendAdminSplitSettlementCancelledAlert).toHaveBeenCalledWith(
        expect.objectContaining({ parentUnpaid: true })
      );
    });

    it("does not cancel when a payment won the lock first (CAS count 0): already_processed, no member email, no admin notice", async () => {
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: IB_SETTLED_PARENT,
        finalPriceCents: 12000,
        guestCount: 2,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });
      // The guarded PENDING -> CANCELLED CAS finds no PENDING row: a payment
      // (or a prior run) resolved it seconds earlier. This is also the
      // idempotent-rerun guard — a second cron pass takes the same branch.
      mockBookingUpdateMany.mockResolvedValue({ count: 0 });

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual([]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      expect(mockRevokePaymentLinksForBooking).not.toHaveBeenCalled();
      expect(mockBookingEventCreate).not.toHaveBeenCalled();
      expect(mockSendSplitGuestPortionCancelledEmail).not.toHaveBeenCalled();
      expect(mockSendAdminSplitSettlementCancelledAlert).not.toHaveBeenCalled();
    });

    it("still auto-charges a past-check-in split child that DOES have a saved card (terminal cancel is only for the no-card path)", async () => {
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentPayment: {
          id: "pay_parent_1",
          stripeCustomerId: "cus_parent_1",
          stripePaymentMethodId: "pm_parent_1",
          // #3269: "DOES have a saved card" means saved through a SetupIntent.
          stripeSetupIntentId: "seti_parent_1",
        },
        finalPriceCents: 12000,
        guestCount: 1,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_child_charge",
        status: "succeeded",
        amount: 12000,
        payment_method: "pm_parent_1",
      });

      const result = await confirmPendingBookings();

      // The saved-card path settles it; the terminal cancel never runs.
      expect(result.cancelledBookingIds).toEqual([]);
      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(mockChargePaymentMethod).toHaveBeenCalled();
      expect(mockSendSplitGuestPortionCancelledEmail).not.toHaveBeenCalled();
    });
  });

  // #1993 Part B — derived alert cadence: a pure function of elapsed time, no
  // schema, no counter. Alert on extension windows 1, 2, 3, then every 7th.
  describe("#1993 derived admin-alert cadence", () => {
    it("computes the 1-based extension window from the original hold expiry", () => {
      const origin = new Date("2026-07-01T00:00:00.000Z");
      const ext = 2 * 24 * 60 * 60 * 1000;
      // Before/at the origin is window 1 (clamped, never 0 or negative).
      expect(splitSettlementExtensionNumber(origin, origin)).toBe(1);
      expect(
        splitSettlementExtensionNumber(origin, new Date(origin.getTime() - 1000))
      ).toBe(1);
      expect(
        splitSettlementExtensionNumber(origin, new Date(origin.getTime() + ext))
      ).toBe(2);
      expect(
        splitSettlementExtensionNumber(
          origin,
          new Date(origin.getTime() + 6 * ext)
        )
      ).toBe(7);
    });

    it("alerts on windows 1, 2, 3, is silent on 4-6, alerts again on 7 and 14", () => {
      expect(shouldAlertOnSplitSettlementExtension(1)).toBe(true);
      expect(shouldAlertOnSplitSettlementExtension(2)).toBe(true);
      expect(shouldAlertOnSplitSettlementExtension(3)).toBe(true);
      expect(shouldAlertOnSplitSettlementExtension(4)).toBe(false);
      expect(shouldAlertOnSplitSettlementExtension(5)).toBe(false);
      expect(shouldAlertOnSplitSettlementExtension(6)).toBe(false);
      expect(shouldAlertOnSplitSettlementExtension(7)).toBe(true);
      expect(shouldAlertOnSplitSettlementExtension(8)).toBe(false);
      expect(shouldAlertOnSplitSettlementExtension(14)).toBe(true);
    });

    it("fires the admin alert on the first extension window (payment-link branch)", async () => {
      // Default dates: origin = checkIn(2026-07-15) - 7d = 2026-07-08; now
      // 2026-07-09 => window 1 => alert.
      const booking = makePendingBooking("child_1", {
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: IB_SETTLED_PARENT,
        finalPriceCents: 12000,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      await confirmPendingBookings();

      expect(mockSendAdminSplitSettlementUnpaidAlert).toHaveBeenCalledTimes(1);
    });

    it("stays silent on a capped extension window (4) while still extending the hold and re-minting", async () => {
      // Anchor the origin at 2026-07-02 (now - 7d => window 4, silent) by making
      // the hold-days-derived first expiry land there and check-in far enough in
      // the future that the terminal branch does not fire.
      mockGetNonMemberHoldDays.mockResolvedValue(40);
      const booking = makePendingBooking("child_1", {
        checkIn: "2026-08-11",
        checkOut: "2026-08-13",
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentBooking: IB_SETTLED_PARENT,
        finalPriceCents: 12000,
      });
      // Origin = max(checkIn - 40d, createdAt) = max(2026-07-02, 2026-03-01).
      booking.createdAt = new Date("2026-03-01T00:00:00.000Z");
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });

      const result = await confirmPendingBookings();

      // Hold still extended (low-churn continues) but no admin alert this window.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "child_1", status: "PENDING" }),
          data: { nonMemberHoldUntil: expect.any(Date) },
        })
      );
      expect(mockSendAdminSplitSettlementUnpaidAlert).not.toHaveBeenCalled();
      expect(result.failedBookingIds).toEqual([]);
    });
  });

  // #1992 (Option 1) — the auto-charge claim closes the residual #1967 window:
  // an in-flight /pay link PaymentIntent (client secret already handed to the
  // member's browser before the claim revoked the links) is best-effort
  // cancelled on Stripe BEFORE the saved-card charge. A cancel that loses to
  // the member's confirm is expected and tolerated: the #1992 duplicate-capture
  // auto-refund in markBookingPaymentSucceeded is the backstop.
  describe("#1992 superseded link-intent cancellation before the auto-charge", () => {
    function primeChargeableSplitChild() {
      const booking = makePendingBooking("child_1", {
        hasPaymentMethod: false,
        parentBookingId: "parent_1",
        parentPayment: {
          id: "pay_parent_1",
          stripeCustomerId: "cus_parent_1",
          stripePaymentMethodId: "pm_parent_1",
          // #3269: chargeable means SetupIntent-saved, not merely populated.
          stripeSetupIntentId: "seti_parent_1",
        },
        finalPriceCents: 12000,
        guestCount: 1,
      });
      mockPendingBookings([booking]);
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_child_charge",
        status: "succeeded",
        amount: 12000,
        payment_method: "pm_parent_1",
      });
      return booking;
    }

    it("cancels the in-flight link intent AND charges the saved card, cancel strictly before the charge", async () => {
      primeChargeableSplitChild();
      mockPaymentTransactionFindMany.mockResolvedValue([
        { id: "txn_link", stripePaymentIntentId: "pi_link_inflight" },
      ]);
      mockCancelPaymentIntentIfCancellable.mockResolvedValue({
        id: "pi_link_inflight",
        status: "canceled",
      });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledTimes(1);
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_link_inflight"
      );
      expect(mockChargePaymentMethod).toHaveBeenCalledTimes(1);
      // Ordering: the cancel narrows the window BEFORE the charge creates the
      // second instrument.
      expect(
        mockCancelPaymentIntentIfCancellable.mock.invocationCallOrder[0]
      ).toBeLessThan(mockChargePaymentMethod.mock.invocationCallOrder[0]);
    });

    it("scopes the sweep to in-flight PRIMARY Stripe intents on the claim's payment and EXCLUDES every saved-card charge ATTEMPT row, recognised by the key prefix on `reference` (#3267)", async () => {
      primeChargeableSplitChild();

      await confirmPendingBookings();

      expect(mockPaymentTransactionFindMany).toHaveBeenCalledWith({
        where: {
          paymentId: "pay_child_1",
          kind: "PRIMARY",
          source: "STRIPE",
          status: { in: ["PENDING", "PROCESSING"] },
          stripePaymentIntentId: { not: null },
          amountCents: { gt: 0 },
          // Never the row this run is replaying (a legacy shared-key row or a
          // same-card link intent the claim chose as the attempt): here a fresh
          // attempt, so its id — which has no intent yet anyway.
          id: { not: ATTEMPT_ROW_ID },
          // An attempt row — the cron's own, the admin route's or
          // charge-saved-method's — carries `pending_charge_…` on `reference`.
          // A still-unresolved one on this card IS this run's attempt (about to
          // be asked about), so cancelling its intent here would cancel this
          // run's own charge. A link intent carries no reference and stays in
          // scope; a NULL reference must be matched explicitly because a
          // negated `startsWith` alone would drop it.
          OR: [
            { reference: null },
            { NOT: { reference: { startsWith: "pending_charge_" } } },
          ],
        },
        select: { id: true, stripePaymentIntentId: true },
      });
    });

    it("never sweeps a saved-card charge attempt row (whichever path minted it, recognised by its key on `reference`), while a link intent alongside it is still cancelled (#3267)", async () => {
      primeChargeableSplitChild();
      // Exercise the REAL OR-filter semantics against a mixed ledger: a
      // 3DS-pending attempt row (must be excluded — before #3267 this was
      // recognised by reason, which never covered the admin route's rows), an
      // in-flight link intent with a NULL reference (must stay in scope), and a
      // LEGACY pre-#3267 saved-card row (reason set, no reference) that the
      // claim did NOT take over — here because this mock hands the claim's own
      // read an empty ledger, and in production because it had already resolved.
      // A legacy row the claim DOES see is ended before this query runs and its
      // status drops it; that path is pinned in its own test below.
      const rows = [
        {
          id: "txn_admin_attempt_3ds",
          stripePaymentIntentId: "pi_admin_attempt_3ds",
          reference: "pending_charge_child_1_txn_admin_attempt_3ds",
          reason: "admin_confirm_pending_guests_charge",
        },
        {
          id: "txn_link",
          stripePaymentIntentId: "pi_link_inflight",
          reference: null,
          reason: null,
        },
        {
          id: "txn_legacy_shared_key",
          stripePaymentIntentId: "pi_legacy_shared_key",
          reference: null,
          reason: "pending_saved_method_charge",
        },
      ];
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: {
          where: {
            OR?: [
              { reference: null },
              { NOT: { reference: { startsWith: string } } },
            ];
          };
        }) => {
          // The attempt module's own read inside the claim has no OR filter
          // and, for this test, finds no earlier attempt.
          if (!args.where.OR) return [];
          const prefix = args.where.OR[1].NOT.reference.startsWith;
          return rows
            .filter(
              (row) => row.reference === null || !row.reference.startsWith(prefix)
            )
            .map(({ id, stripePaymentIntentId }) => ({
              id,
              stripePaymentIntentId,
            }));
        }
      );
      mockCancelPaymentIntentIfCancellable.mockResolvedValue({
        id: "pi_link_inflight",
        status: "canceled",
      });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledTimes(2);
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_link_inflight"
      );
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_legacy_shared_key"
      );
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalledWith(
        "pi_admin_attempt_3ds"
      );
    });

    it("makes no cancel call when no in-flight link intent exists", async () => {
      primeChargeableSplitChild();
      mockPaymentTransactionFindMany.mockResolvedValue([]);

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).toHaveBeenCalledTimes(1);
    });

    it("tolerates losing the cancel race (intent already succeeded → not cancellable): the charge still proceeds and the duplicate lands in the #1992 reconcile backstop", async () => {
      primeChargeableSplitChild();
      mockPaymentTransactionFindMany.mockResolvedValue([
        { id: "txn_link", stripePaymentIntentId: "pi_link_inflight" },
      ]);
      // cancelPaymentIntentIfCancellable returns null when the intent is in a
      // non-cancellable state (e.g. it already succeeded).
      mockCancelPaymentIntentIfCancellable.mockResolvedValue(null);
      mockMarkBookingPaymentSucceeded.mockResolvedValue({
        outcome: "duplicate_capture_refunded",
        bookingId: "child_1",
        bumpedBookingIds: [],
      });

      const result = await confirmPendingBookings();

      // Charge recorded, no crash; the booking counts as settled.
      expect(mockChargePaymentMethod).toHaveBeenCalledTimes(1);
      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(result.failedBookingIds).toHaveLength(0);
      // The settling link path already sent the confirmation email and queued
      // the Xero invoice — the duplicate outcome must not repeat either.
      expect(mockSendConfirmedEmail).not.toHaveBeenCalled();
      expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
    });

    it("tolerates a cancel API error (best-effort): logged, charge proceeds, booking confirms", async () => {
      primeChargeableSplitChild();
      mockPaymentTransactionFindMany.mockResolvedValue([
        { id: "txn_link", stripePaymentIntentId: "pi_link_inflight" },
      ]);
      mockCancelPaymentIntentIfCancellable.mockRejectedValue(
        new Error("Stripe cancel raced a parallel confirm")
      );

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(result.failedBookingIds).toHaveLength(0);
      expect(mockChargePaymentMethod).toHaveBeenCalledTimes(1);
    });

    it("tolerates the sweep lookup itself failing (best-effort): the charge is never blocked", async () => {
      primeChargeableSplitChild();
      // Only the SWEEP's read fails (recognised by its OR filter); the attempt
      // module's read inside the claim — the same mock, a different `where` —
      // still answers, because a claim that cannot read the ledger must not
      // charge at all (#3267), which is a different test.
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) => {
          if (args.where.OR) throw new Error("ledger read failed");
          return [];
        }
      );

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["child_1"]);
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
      expect(mockChargePaymentMethod).toHaveBeenCalledTimes(1);
    });

    it("cancels multiple in-flight intents independently: one cancel failing does not skip the next", async () => {
      primeChargeableSplitChild();
      mockPaymentTransactionFindMany.mockResolvedValue([
        { id: "txn_link_1", stripePaymentIntentId: "pi_link_1" },
        { id: "txn_link_2", stripePaymentIntentId: "pi_link_2" },
      ]);
      mockCancelPaymentIntentIfCancellable
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ id: "pi_link_2", status: "canceled" });

      const result = await confirmPendingBookings();

      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenNthCalledWith(
        1,
        "pi_link_1"
      );
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenNthCalledWith(
        2,
        "pi_link_2"
      );
      expect(result.confirmedBookingIds).toEqual(["child_1"]);
    });
  });
  /*
    #2870 — WHOSE CIVIL DAY ENDS THE HOLD.

    The two branches below decide `PENDING -> CANCELLED` for a booking whose
    check-in day has ended. The request-origin one RELEASES REAL CAPACITY. Both
    were bound by comment to the payment link's mint boundary "so the two can
    never disagree", and both resolved that boundary in `APP_TIME_ZONE` — the
    deployment's `TZ` seed — while the mint, the pay page and the approval email
    moved onto the club's PERSISTED zone (#3068). They now call one function that
    takes the zone.

    Measured before this block existed: replacing the threaded `clubZone` with
    `APP_TIME_ZONE` at both sites left all 57 tests in this file GREEN. The two
    highest-consequence sites in the change had no coverage of the defect at all.

    ## Why the fixtures are searched for rather than written down

    Discriminating needs `now` to fall strictly between the club's boundary and
    BOTH wrong answers' — `APP_TIME_ZONE`'s and the host's own resolved zone.
    `divergentClubZone` guarantees three DIFFERENT answers, which is not the same
    thing: a club boundary sitting between the two wrong ones would leave the
    observable identical to one of them. So this searches the same candidate list
    for a (zone, check-in day) pair that really does straddle, and THROWS with the
    three boundaries printed when none exists. A premise failure is a failure and
    never a skip (owner decision, #2870).
  */
  describe("#2870 the terminal cancel closes on the CLUB's civil day", () => {
    /** The instant this file's `beforeEach` pins. */
    const NOW = new Date("2026-07-09T00:00:00.000Z");

    const CANDIDATE_ZONES = [
      "Pacific/Pago_Pago",
      "Pacific/Honolulu",
      "America/Denver",
      "America/Sao_Paulo",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Pacific/Kiritimati",
    ] as const;

    /** `yyyy-MM-dd`, `offset` days from the pinned now. */
    function dayOffsetFromNow(offset: number): string {
      return new Date(NOW.getTime() + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }

    /** The civil date an instant falls on in a zone — an independent oracle. */
    function civilDateIn(zone: string, at: Date): string {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at);
    }

    /**
     * The last millisecond whose civil date in `zone` is `day`, by bisecting
     * `Intl`. Deliberately shares no offset arithmetic with the code under test.
     */
    function endOfCivilDay(zone: string, day: string): number {
      const anchor = Date.parse(`${day}T00:00:00.000Z`);
      let lo = anchor - 2 * 86_400_000;
      let hi = anchor + 2 * 86_400_000;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (civilDateIn(zone, new Date(mid)) <= day) lo = mid;
        else hi = mid;
      }
      return lo;
    }

    const environmentZone = APP_TIME_ZONE;
    const hostZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

    /**
     * A club zone and a check-in day for which the club's day has NOT ended while
     * both wrong answers say it has. So the correct behaviour is to EXTEND the
     * hold, and either mutant cancels the booking and releases its beds.
     */
    function straddlingFixture(): { zone: string; checkIn: string } {
      const tried: string[] = [];
      for (let offset = -3; offset <= 0; offset += 1) {
        const checkIn = dayOffsetFromNow(offset);
        const environmentEnd = endOfCivilDay(environmentZone, checkIn);
        const hostEnd = endOfCivilDay(hostZone, checkIn);
        if (environmentEnd > NOW.getTime() || hostEnd > NOW.getTime()) continue;
        for (const zone of CANDIDATE_ZONES) {
          if (zone === environmentZone || zone === hostZone) continue;
          const clubEnd = endOfCivilDay(zone, checkIn);
          if (clubEnd > NOW.getTime()) return { zone, checkIn };
          tried.push(`${checkIn} ${zone} -> ${new Date(clubEnd).toISOString()}`);
        }
      }
      throw new Error(
        "No (club zone, check-in day) pair leaves the club's day still running " +
          `while both APP_TIME_ZONE (${environmentZone}) and the host (${hostZone}) ` +
          "say it has ended. Without one, this assertion cannot tell the club's " +
          "persisted zone from either wrong answer and would pass for both. " +
          `Tried: ${tried.join(", ") || "no candidate day had both wrong answers ended"}.`,
      );
    }

    const FIXTURE = straddlingFixture();

    beforeEach(() => {
      // The club HAS chosen a zone, so the real reader resolves the persisted
      // value rather than the environment seed. Only the row is a fake.
      mockClubTimeSettingsFindUnique.mockResolvedValue({
        timeZone: FIXTURE.zone,
      });
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 5,
        nightDetails: [],
      });
    });

    it("proves the fixture really splits the club's day from both wrong answers", () => {
      // Without this the tests below could pass against a tree that read
      // APP_TIME_ZONE. Stated separately so an ICU or candidate-list change fails
      // here, legibly, rather than as a cancelled/extended mismatch.
      expect(endOfCivilDay(environmentZone, FIXTURE.checkIn)).toBeLessThanOrEqual(
        NOW.getTime(),
      );
      expect(endOfCivilDay(hostZone, FIXTURE.checkIn)).toBeLessThanOrEqual(
        NOW.getTime(),
      );
      expect(endOfCivilDay(FIXTURE.zone, FIXTURE.checkIn)).toBeGreaterThan(
        NOW.getTime(),
      );
    });

    it("does NOT cancel a request booking whose club day is still running, and keeps its beds", async () => {
      mockPendingBookings([
        makePendingBooking("b_zone", {
          checkIn: FIXTURE.checkIn,
          checkOut: dayOffsetFromNow(2),
          hasPaymentMethod: false,
          originBookingRequest: { id: "req_zone" },
          finalPriceCents: 14_000,
        }),
      ]);

      const result = await confirmPendingBookings();

      expect(
        result.cancelledBookingIds,
        "INV-CONFIG-002: the club's check-in day has not ended, so the requester's " +
          "/pay link is still live and this booking must keep its hold. Closing " +
          "the day on APP_TIME_ZONE cancels it and RELEASES ITS BEDS a whole club " +
          "day early, and REVOKES THE MEMBER'S LINK with them: the terminal " +
          "branch calls `revokePaymentLinksForBooking` in the same transaction, " +
          "which is why the assertion below is `not.toHaveBeenCalled()`. So the " +
          "harm is not a live link on a dead booking — it is a member who was " +
          "given a deadline, and finds the link dead and their beds gone before " +
          "it arrives.",
      ).toEqual([]);
      expect(mockReconcileBedAllocationsForBooking).not.toHaveBeenCalled();
      expect(mockRevokePaymentLinksForBooking).not.toHaveBeenCalled();
      // The hold was extended instead, which is the branch that must run.
      expect(mockBookingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { nonMemberHoldUntil: expect.any(Date) },
        }),
      );
    });

    it("does NOT cancel a split child whose club day is still running", async () => {
      mockPendingBookings([
        makePendingBooking("child_zone", {
          checkIn: FIXTURE.checkIn,
          checkOut: dayOffsetFromNow(2),
          hasPaymentMethod: false,
          parentBookingId: "parent_zone",
          parentBooking: {
            id: "parent_zone",
            status: "CONFIRMED",
            payment: {
              id: "pay_parent",
              source: "INTERNET_BANKING",
              stripeCustomerId: null,
              stripePaymentMethodId: null,
            },
          },
          finalPriceCents: 12_000,
        }),
      ]);

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual([]);
      // The link mint is the branch that runs instead — and it is handed the
      // club's zone, which is what keeps the mint and this decision in step.
      expect(mockMintSplitGuestPaymentLinkIfAbsent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "child_zone" }),
        FIXTURE.zone,
      );
    });

    it("still cancels once the CLUB's day has genuinely ended", async () => {
      // The boundary is a real boundary, not an absence of the branch: four days
      // back is past the end of the check-in day in every zone on earth.
      mockPendingBookings([
        makePendingBooking("b_past", {
          checkIn: dayOffsetFromNow(-4),
          checkOut: dayOffsetFromNow(-2),
          hasPaymentMethod: false,
          originBookingRequest: { id: "req_past" },
          finalPriceCents: 14_000,
        }),
      ]);

      const result = await confirmPendingBookings();

      expect(result.cancelledBookingIds).toEqual(["b_past"]);
    });

    it("reads the club's zone once per RUN, not once per booking, and never inside a lock transaction", async () => {
      mockPendingBookings([
        makePendingBooking("b_one", {
          checkIn: FIXTURE.checkIn,
          checkOut: dayOffsetFromNow(2),
          hasPaymentMethod: false,
          originBookingRequest: { id: "req_one" },
        }),
        makePendingBooking("b_two", {
          checkIn: FIXTURE.checkIn,
          checkOut: dayOffsetFromNow(2),
          hasPaymentMethod: false,
          originBookingRequest: { id: "req_two" },
        }),
      ]);

      await confirmPendingBookings();

      expect(
        mockClubTimeSettingsFindUnique,
        "Two bookings, one settings read. A read per booking would sit inside " +
          "`resolveHoldWindowUnderLock`, which holds pg_advisory_xact_lock(1) AND " +
          "the per-lodge capacity lock for the whole callback — so every cancel, " +
          "capture, hold-release and capacity claim in the system would wait on a " +
          "settings query. It would also let two bookings in one tick be judged " +
          "against different club days.",
      ).toHaveBeenCalledTimes(1);

      // THE OTHER HALF, and the call count above cannot stand in for it: a read
      // that moved INSIDE `resolveHoldWindowUnderLock` but still ran once per
      // run keeps that count at 1 and passes. Two bookings only catch a read
      // that became per-booking. This counter catches the placement.
      expect(
        zoneReadsInsideTransaction,
        "`resolveHoldWindowUnderLock` holds pg_advisory_xact_lock(1) AND the " +
          "per-lodge capacity lock for its whole callback. A `clubTimeSettings` " +
          "query in there is a settings read under both — resolve the zone " +
          "before the transaction and thread it in (`payment-link-expiry.ts`).",
      ).toBe(0);
    });
  });

  describe("#3267 one saved-card charge attempt is one durable ledger row with its own Stripe key (INV-PAY-055)", () => {
    function capacityAvailable() {
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 10,
        nightDetails: [],
      });
    }

    it("REPLAYS an unresolved earlier attempt on the same card: Stripe is asked about THAT intent, no second charge is made, and the same row records the outcome", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      // The admin clicked earlier and the intent is still awaiting 3DS; the
      // attempt row is recognised by the key built from its own id.
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_admin",
                  status: "PROCESSING",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_b1",
                  stripePaymentIntentId: "pi_admin",
                  reference: "pending_charge_b1_txn_admin",
                  reason: "admin_confirm_pending_guests_charge",
                },
              ]
      );
      mockGetPaymentIntent.mockResolvedValue({
        id: "pi_admin",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_b1",
      });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["b1"]);
      expect(mockGetPaymentIntent).toHaveBeenCalledWith("pi_admin");
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_admin", status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] } },
        data: {
          stripePaymentIntentId: "pi_admin",
          status: "SUCCEEDED",
          amountCents: 10000,
          paymentMethodId: "pm_b1",
        },
      });
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_admin" })
      );
    });

    it("ends an unresolved attempt on a card that has since been replaced, cancels its intent before charging the new card, and mints a fresh key", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_old_card",
                  status: "PROCESSING",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_retired",
                  stripePaymentIntentId: "pi_old_card",
                  reference: "pending_charge_b1_txn_old_card",
                  reason: "pending_hold_auto_charge",
                },
              ]
      );
      mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_fresh",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_b1",
      });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual(["b1"]);
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_old_card", status: { in: ["PENDING", "PROCESSING"] } },
        data: {
          status: "FAILED",
          reason: "pending_hold_auto_charge:superseded_by_new_card",
        },
      });
      expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_old_card");
      expect(
        mockCancelPaymentIntentIfCancellableWithResult.mock.invocationCallOrder[0]!
      ).toBeLessThan(mockChargePaymentMethod.mock.invocationCallOrder[0]!);
      expect(mockChargePaymentMethod).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodId: "pm_b1", idempotencyKey: attemptKeyFor("b1") })
      );
    });

    /** A captured PRIMARY row on the still-pending booking, last written `capturedAgoMs` before now (2026-07-09T00:00Z). */
    function primeCapturedRow(capturedAgoMs: number) {
      const updatedAt = new Date(Date.now() - capturedAgoMs);
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_paid",
                  status: "SUCCEEDED",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_b1",
                  stripePaymentIntentId: "pi_paid",
                  reference: null,
                  reason: null,
                  createdAt: updatedAt,
                  updatedAt,
                },
              ]
      );
    }
    const HOUR = 60 * 60 * 1000;
    const WINDOW = 2 * 24 * HOUR;

    it("REFUSES to charge when a captured PRIMARY row already sits on the still-pending booking: nothing claimed, nothing charged, loud alert, failed id", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      // Captured an hour ago: this is the first run since, so it alerts.
      primeCapturedRow(1 * HOUR);

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      // The claim transaction THREW, so it rolled back: no compensating release
      // runs (there is nothing to hand back).
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeUndefined();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: "pi_paid",
          errorMessage: expect.stringContaining("already recorded"),
        })
      );
    });

    describe("the refusal alert follows the #1993 cadence, once per window, anchored on when the cron could FIRST have observed the refusal (#3267 fix round 2)", () => {
      // Two clocks, deliberately separate: `capturedAgoMs` is when the ledger
      // row that witnesses the refusal was last written, `dueAgoMs` is when the
      // hold expired and this cron's charge arm could first reach the booking.
      // The anchor is the LATER of the two. Anchoring on the row alone is the
      // defect this table exists to pin: a capture recorded days before the
      // hold expires makes the first observation land mid-window, and that
      // window's one alert is skipped.
      it.each([
        ["window 1, first run (the hold expired an hour ago, captured an hour before that) -> ALERTS", 1 * HOUR, 1 * HOUR, true],
        ["window 1, a later run (observable for 24 hours already) -> silent", 24 * HOUR, 24 * HOUR, false],
        ["window 2, first run -> ALERTS", WINDOW + 2 * HOUR, WINDOW + 2 * HOUR, true],
        ["window 4, first run -> silent (the cadence caps windows 4-6)", 3 * WINDOW + 1 * HOUR, 3 * WINDOW + 1 * HOUR, false],
        ["window 7, first run -> ALERTS", 6 * WINDOW + 1 * HOUR, 6 * WINDOW + 1 * HOUR, true],
        ["window 7, a later run -> silent", 6 * WINDOW + 5 * HOUR, 6 * WINDOW + 5 * HOUR, false],
        // The traced worked example. The money was captured five days before
        // the hold expired, so `SavedCardChargeRefusedError.since` is already
        // 120 hours old at the very first run that can see it. Anchored on the
        // row alone that is 120 % 48 = 24 hours into window 3 — no alert — and
        // the next residues fall in capped windows, so the first alert would
        // not arrive for twelve days while captured money sat on a booking
        // reading pending.
        ["captured five days before the hold expired: the FIRST observation -> ALERTS", 120 * HOUR, 1 * HOUR, true],
        // And the other way round, so the anchor cannot quietly become "the
        // hold expiry" instead of "the later of the two": a booking whose hold
        // expired five days ago but whose money was captured an hour ago is one
        // hour into ITS window 1.
        ["the hold expired five days ago, captured an hour ago: the cadence starts at the capture -> ALERTS", 1 * HOUR, 120 * HOUR, true],
      ])("%s; the refusal is logged and the booking counted failed on every run regardless", async (_label, capturedAgoMs, dueAgoMs, alerts) => {
        mockPendingBookings([
          makePendingBooking("b1", {
            holdUntil: new Date(Date.now() - dueAgoMs).toISOString(),
          }),
        ]);
        capacityAvailable();
        primeCapturedRow(capturedAgoMs);

        const result = await confirmPendingBookings();

        expect(result.failedBookingIds).toEqual(["b1"]);
        expect(mockChargePaymentMethod).not.toHaveBeenCalled();
        expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(alerts ? 1 : 0);
      });

      it("the helpers: a run is the first in its window only within one run-interval of the window boundary", () => {
        const since = new Date("2026-07-01T00:00:00.000Z");
        const at = (ms: number) => new Date(since.getTime() + ms);
        expect(CONFIRM_PENDING_RUN_INTERVAL_MS).toBe(3 * HOUR);
        expect(isFirstRunInExtensionWindow(since, since)).toBe(true);
        expect(isFirstRunInExtensionWindow(since, at(3 * HOUR - 1))).toBe(true);
        expect(isFirstRunInExtensionWindow(since, at(3 * HOUR))).toBe(false);
        expect(isFirstRunInExtensionWindow(since, at(WINDOW))).toBe(true);
        expect(isFirstRunInExtensionWindow(since, at(WINDOW + 3 * HOUR))).toBe(false);
        // Cadence AND first run: window 4 is capped even on its first run;
        // window 7 alerts on its first run only.
        expect(shouldAlertOnSavedCardChargeRefusal(since, at(3 * WINDOW + HOUR))).toBe(false);
        expect(shouldAlertOnSavedCardChargeRefusal(since, at(6 * WINDOW + HOUR))).toBe(true);
        expect(shouldAlertOnSavedCardChargeRefusal(since, at(6 * WINDOW + 4 * HOUR))).toBe(false);
      });
    });

    it("REFUSES to re-send an unanswered attempt's key once it is older than Stripe's replay window (attempt_key_expired): nothing charged, the row left for a person, alert on the same cadence", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      // A PENDING attempt row with no intent, minted 23h + 1h ago: its key
      // expired an hour ago, so this is the first run since — alert.
      const createdAt = new Date(Date.now() - 24 * HOUR);
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_unanswered",
                  status: "PENDING",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_b1",
                  stripePaymentIntentId: null,
                  reference: "pending_charge_b1_txn_unanswered",
                  reason: "pending_hold_auto_charge",
                  createdAt,
                  updatedAt: createdAt,
                },
              ]
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      expect(
        mockPaymentTransactionUpdateMany.mock.calls.find(([call]) => call?.where?.id === "txn_unanswered")
      ).toBeUndefined();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("more than 23 hours ago") })
      );
    });

    it("an AMBIGUOUS failure (api_error) leaves the attempt row PENDING — the next run replays it — while the claim is still released and admins alerted", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "api_error", message: "Stripe is having a moment" })
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(
        mockPaymentTransactionUpdateMany.mock.calls.find(
          ([call]) => call?.where?.id === ATTEMPT_ROW_ID && call?.data?.status === "FAILED"
        )
      ).toBeUndefined();
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeDefined();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    });

    it("a retrieved intent that has died (canceled) closes the attempt (FAILED) so the next run is fresh, and the booking goes back to pending", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_dead",
                  status: "PROCESSING",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_b1",
                  stripePaymentIntentId: "pi_dead",
                  reference: "pending_charge_b1_txn_dead",
                  reason: "pending_hold_auto_charge",
                },
              ]
      );
      mockGetPaymentIntent.mockResolvedValue({
        id: "pi_dead",
        status: "canceled",
        amount: 10000,
        payment_method: "pm_b1",
      });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "txn_dead", status: { in: ["PENDING", "PROCESSING"] } },
          data: expect.objectContaining({ status: "FAILED" }),
        })
      );
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeDefined();
    });

    it("a LEGACY shared-key row (no reference) still PROCESSING on the SAME card is replayed by retrieve — waited on, never charged beside — and the #1992 sweep leaves it alone by id (#3267 fix round)", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      const legacy = {
        id: "txn_legacy",
        status: "PROCESSING",
        amountCents: 10000,
        refundedAmountCents: 0,
        paymentMethodId: "pm_b1",
        stripePaymentIntentId: "pi_legacy",
        reference: null,
        reason: "pending_hold_auto_charge",
        createdAt: new Date("2026-07-08T21:00:00.000Z"),
        updatedAt: new Date("2026-07-08T21:00:00.000Z"),
      };
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown; id?: { not: string } } }) =>
          args.where.OR
            ? // The sweep's read: honour its by-id exclusion the way Postgres would.
              [legacy].filter((row) => row.id !== args.where.id?.not).map(({ id, stripePaymentIntentId }) => ({ id, stripePaymentIntentId }))
            : [legacy]
      );
      mockGetPaymentIntent.mockResolvedValue({ id: "pi_legacy", status: "processing", amount: 10000, payment_method: "pm_b1" });

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      expect(mockGetPaymentIntent).toHaveBeenCalledWith("pi_legacy");
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentTransactionCreate).not.toHaveBeenCalled();
      // The sweep asked with the replayed row excluded, so it never cancelled it.
      expect(mockPaymentTransactionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: "txn_legacy" } }) })
      );
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
      // Recorded PROCESSING on the legacy row, and the claim handed back.
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: "txn_legacy" }), data: expect.objectContaining({ status: "PROCESSING" }) })
      );
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeDefined();
    });

    it("a LEGACY shared-key row on ANOTHER card is ENDED by the claim and its live intent WAITED on — never left to the cancel-only #1992 sweep, which is the deploy-cutover double charge (#3267 fix round 3)", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      // Pre-#3267 shape: minted under the shared key `pending_charge_b1`, so no
      // `reference`; the member has since saved pm_b1, so the row's card is
      // stale. Its intent is `processing` — Stripe will refuse to cancel it.
      const legacy = {
        id: "txn_legacy_other_card",
        status: "PROCESSING",
        amountCents: 10000,
        refundedAmountCents: 0,
        paymentMethodId: "pm_retired",
        stripePaymentIntentId: "pi_legacy_other_card",
        reference: null,
        reason: "pending_hold_auto_charge",
        createdAt: new Date("2026-07-08T21:00:00.000Z"),
        updatedAt: new Date("2026-07-08T21:00:00.000Z"),
      };
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? // The sweep's read runs after the claim has committed the row as
              // FAILED, and the sweep asks only for PENDING/PROCESSING rows.
              []
            : [legacy]
      );
      mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
      mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
        stripeError({ type: "invalid_request_error", code: "payment_intent_unexpected_state" })
      );
      mockGetPaymentIntent.mockResolvedValue({
        id: "pi_legacy_other_card",
        status: "processing",
        amount: 10000,
        payment_method: "pm_retired",
      });

      const result = await confirmPendingBookings();

      // Ended under the claim, with the intent handed to the charge step.
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_legacy_other_card", status: { in: ["PENDING", "PROCESSING"] } },
        data: {
          status: "FAILED",
          reason: "pending_hold_auto_charge:superseded_by_new_card",
        },
      });
      expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith(
        "pi_legacy_other_card"
      );
      // The retrieve-and-consider path, never the cancel-only sweep whose
      // "not cancellable, likely already succeeded" was the double charge.
      expect(mockGetPaymentIntent).toHaveBeenCalledWith("pi_legacy_other_card");
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalledWith(
        "pi_legacy_other_card"
      );
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      // The claim is handed back, so the next run asks about the intent again.
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeDefined();
    });

    it("a superseded attempt whose intent is still PROCESSING (the member re-saved a card mid-flight) is waited on: Stripe refuses the cancel, the intent is read back, no charge is made on the new card, and its row is revived so the next run waits again (#3267 fix round)", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: { where: { OR?: unknown } }) =>
          args.where.OR
            ? []
            : [
                {
                  id: "txn_old_card",
                  status: "PROCESSING",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  paymentMethodId: "pm_retired",
                  stripePaymentIntentId: "pi_old_card",
                  reference: "pending_charge_b1_txn_old_card",
                  reason: "pending_hold_auto_charge",
                  createdAt: new Date("2026-07-08T21:00:00.000Z"),
                  updatedAt: new Date("2026-07-08T21:00:00.000Z"),
                },
              ]
      );
      mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: "You cannot cancel this PaymentIntent because it has a status of processing." })
      );
      mockGetPaymentIntent.mockResolvedValue({ id: "pi_old_card", status: "processing", amount: 10000, payment_method: "pm_retired" });
      // The live intent's row is committed, so settle's pre-check on the unique
      // intent id finds it: without this the fake would answer "no row for this
      // intent" for a row the same fake has just returned from findMany, and
      // the real write would hit the unique constraint instead of the keep
      // branch (`stripePaymentIntentId` is unique).
      mockPaymentTransactionFindUnique.mockImplementation(
        async ({ where }: { where: { id?: string; stripePaymentIntentId?: string } }) =>
          where.stripePaymentIntentId === "pi_old_card"
            ? { id: "txn_old_card", paymentId: "pay_b1" }
            : null
      );

      const result = await confirmPendingBookings();

      expect(result.confirmedBookingIds).toEqual([]);
      expect(result.failedBookingIds).toEqual([]);
      expect(mockChargePaymentMethod).not.toHaveBeenCalled();
      expect(mockGetPaymentIntent).toHaveBeenCalledWith("pi_old_card");
      // Ended under the claim, then revived once found live.
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_old_card", status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED", reason: "pending_hold_auto_charge:superseded_by_new_card" },
      });
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: "pi_old_card", status: "FAILED" },
        data: { status: "PROCESSING" },
      });
      // The fresh row minted for the new card is removed in favour of the live one.
      expect(mockPaymentTransactionDeleteMany).toHaveBeenCalledWith({
        where: { id: ATTEMPT_ROW_ID, stripePaymentIntentId: null },
      });
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeDefined();
    });

    it("does NOT release a claim the webhook has already settled: the retrieve said processing, the booking reads PAID under the release's locks — the stale answer is refused by the row's own guard, nothing is thrown, no alert (#3267 fix round)", async () => {
      const booking = makePendingBooking("b1");
      mockBookingFindMany.mockResolvedValue([booking]);
      // The status-only re-read inside the release finds the webhook's PAID.
      mockBookingFindUnique.mockImplementation(async ({ select }: { select?: { status?: boolean } }) =>
        select?.status && Object.keys(select).length === 1 ? { status: "PAID" } : booking
      );
      capacityAvailable();
      mockChargePaymentMethod.mockResolvedValue({ id: "pi_race", status: "processing", amount: 10000, payment_method: "pm_b1" });
      // The forward-only guard refuses the stale write; the row reads SUCCEEDED.
      mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
      mockPaymentTransactionFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
        where.id ? { status: "SUCCEEDED" } : null
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual([]);
      expect(result.confirmedBookingIds).toEqual([]);
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ATTEMPT_ROW_ID, status: { in: ["PENDING", "PROCESSING"] } } })
      );
      expect(mockReconcilePaymentAggregates).not.toHaveBeenCalled();
      expect(
        mockBookingUpdateMany.mock.calls.find(
          ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
        )
      ).toBeUndefined();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });

    it("a claim lost to an actor OTHER than the settling webhook is an anomaly: the booking reads CANCELLED under the release's locks, so it is logged at error level and counted failed (#3267 fix round 2)", async () => {
      // Before #3267 this arm threw "Pending-hold charge release lost its
      // CONFIRMED claim", which put the booking in `failedBookingIds` and
      // alerted. The fix round replaced the throw with a warn for EVERY
      // non-CONFIRMED status, which accepted a mid-charge CANCELLED silently.
      // PAID is the expected webhook-won case (the test above); anything else
      // still has to reach a person.
      const logger = (await import("@/lib/logger")).default;
      const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      try {
        const booking = makePendingBooking("b1");
        mockBookingFindMany.mockResolvedValue([booking]);
        mockBookingFindUnique.mockImplementation(async ({ select }: { select?: { status?: boolean } }) =>
          select?.status && Object.keys(select).length === 1 ? { status: "CANCELLED" } : booking
        );
        capacityAvailable();
        mockChargePaymentMethod.mockResolvedValue({ id: "pi_race", status: "processing", amount: 10000, payment_method: "pm_b1" });
        // The attempt row takes the `processing` answer normally; the anomaly
        // is the booking's status, not the ledger's.
        mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });

        const result = await confirmPendingBookings();

        expect(result.failedBookingIds).toEqual(["b1"]);
        expect(result.confirmedBookingIds).toEqual([]);
        const said = (spy: typeof error, needle: string) =>
          spy.mock.calls.some(([, message]) => typeof message === "string" && message.includes(needle));
        expect(said(error, "lost its CONFIRMED claim to another actor")).toBe(true);
        expect(said(warn, "already PAID at release")).toBe(false);
        // Still no release: the status-guarded update would match nothing.
        expect(
          mockBookingUpdateMany.mock.calls.find(
            ([call]) => call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING"
          )
        ).toBeUndefined();
      } finally {
        error.mockRestore();
        warn.mockRestore();
      }
    });

    it("says what the LEDGER says, not what the intent said: a `canceled` answer the webhook has already overtaken with a capture is reported as captured, not as an ended attempt (#3267 fix round)", async () => {
      // Why this is not cosmetic: the terminal intent statuses used to be
      // re-listed here as well as in `ledgerStatusForPaymentIntent`, so the two
      // could disagree — and when the forward-only guard refuses a stale answer
      // the intent's status is the WRONG one to believe. `canceled` arriving
      // after a capture is exactly that shape (the #1992 sweep cancels an
      // intent whose sibling has already settled the booking).
      const logger = (await import("@/lib/logger")).default;
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
      try {
        const booking = makePendingBooking("b1");
        mockBookingFindMany.mockResolvedValue([booking]);
        mockBookingFindUnique.mockImplementation(
          async ({ select }: { select?: { status?: boolean } }) =>
            select?.status && Object.keys(select).length === 1
              ? { status: "PAID" }
              : booking
        );
        capacityAvailable();
        mockChargePaymentMethod.mockResolvedValue({ id: "pi_race", status: "canceled", amount: 10000, payment_method: "pm_b1" });
        mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
        mockPaymentTransactionFindUnique.mockImplementation(
          async ({ where }: { where: { id?: string } }) =>
            where.id ? { status: "SUCCEEDED" } : null
        );

        await confirmPendingBookings();

        const said = (spy: typeof warn, needle: string) =>
          spy.mock.calls.some(([, message]) => typeof message === "string" && message.includes(needle));
        expect(said(info, "captured after the retrieve")).toBe(true);
        expect(said(warn, "ended without a capture")).toBe(false);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });
  });

  describe("#3268 an unusable saved card is terminal for the cron, never retried forever", () => {
    const INCIDENT_MESSAGE =
      "The provided PaymentMethod was previously used with a PaymentIntent without Customer attachment or was detached from a Customer. It may not be used again.";

    function capacityAvailable() {
      mockCheckCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 10,
        nightDetails: [],
      });
    }

    function releasedClaimCall() {
      return mockBookingUpdateMany.mock.calls.find(
        ([call]) =>
          call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING",
      );
    }

    // #3267 split the ledger `updateMany` traffic in two: the retire path's
    // card clear (matched by pm id, INV-PAY-054) and the attempt module's
    // status-guarded FAILED mark on a definite refusal (matched by row id,
    // INV-PAY-055). Tell them apart by shape rather than by count.
    function ledgerCardClearCalls() {
      return mockPaymentTransactionUpdateMany.mock.calls.filter(
        ([call]) => call?.where?.paymentMethodId !== undefined,
      );
    }
    function attemptFailedMarkCall() {
      return mockPaymentTransactionUpdateMany.mock.calls.find(
        ([call]) => call?.where?.id === ATTEMPT_ROW_ID && call?.data?.status === "FAILED",
      );
    }

    it("invalid_request_error about the pm: releases the claim, retires the card everywhere, tells the member once and admins once", async () => {
      // Default fixture: hold expired 2026-07-08, now 2026-07-09 — window 1.
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(result.confirmedBookingIds).toEqual([]);

      // The capacity claim is released first, exactly as before.
      const release = releasedClaimCall();
      expect(release).toBeDefined();

      // Then the card is retired: detached at Stripe, cleared from every
      // Payment row and every ledger row carrying that exact id.
      expect(mockDetachPaymentMethod).toHaveBeenCalledTimes(1);
      expect(mockDetachPaymentMethod).toHaveBeenCalledWith("pm_b1");
      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockPaymentUpdateMany).toHaveBeenCalledWith({
        where: { stripePaymentMethodId: "pm_b1" },
        data: { stripePaymentMethodId: null },
      });
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { paymentMethodId: "pm_b1" },
        data: { paymentMethodId: null },
      });
      // #3267 / INV-PAY-055, the ordering both sides depend on: the attempt row
      // is marked FAILED (a definite refusal) BEFORE the retire nulls the card
      // off every ledger row. Were the row still PENDING when its card was
      // nulled, the next attempt would read "unresolved, no card, no intent"
      // and replay a key whose stored body names the retired card.
      const failedMark = attemptFailedMarkCall();
      expect(failedMark).toBeDefined();
      const cardClear = ledgerCardClearCalls()[0];
      expect(cardClear).toBeDefined();
      expect(
        mockPaymentTransactionUpdateMany.mock.invocationCallOrder[
          mockPaymentTransactionUpdateMany.mock.calls.indexOf(failedMark!)
        ]!
      ).toBeLessThan(
        mockPaymentTransactionUpdateMany.mock.invocationCallOrder[
          mockPaymentTransactionUpdateMany.mock.calls.indexOf(cardClear!)
        ]!
      );
      // Release BEFORE retire: the clear is not made under the claim's locks.
      const releaseOrder = mockBookingUpdateMany.mock.invocationCallOrder[
        mockBookingUpdateMany.mock.calls.indexOf(release!)
      ]!;
      expect(mockPaymentUpdateMany.mock.invocationCallOrder[0]!).toBeGreaterThan(releaseOrder);

      // ONE member notice, with the "No emails" switch's booking context.
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "b1",
          recipientMemberId: "member_b1",
          email: "b1@example.com",
          firstName: "Test",
        }),
      );

      // ONE admin alert, in plain English, quoting Stripe.
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [
        { errorMessage: string; memberName: string },
      ];
      expect(alert.memberName).toBe("Test User");
      expect(alert.errorMessage).toContain("found unusable");
      expect(alert.errorMessage).toContain("removed from the booking");
      expect(alert.errorMessage).toContain("save a new card");
      expect(alert.errorMessage).toContain(INCIDENT_MESSAGE);
    });

    it("clears the PARENT's row when a split child was charging a borrowed parent card the member had SAVED through a SetupIntent — after #3269 a one-off parent card can no longer reach the charge arm, so this is the shape a terminal refusal retires", async () => {
      mockPendingBookings([
        makePendingBooking("child_1", {
          hasPaymentMethod: false,
          parentBookingId: "parent_1",
          parentPayment: {
            id: "pay_parent_1",
            stripeCustomerId: "cus_parent_1",
            stripePaymentMethodId: "pm_parent_1",
            // The parent SAVED this card (SetupIntent), which is the only way a
            // parent card reaches the child's charge arm once #3269 lands.
            stripeSetupIntentId: "seti_parent_1",
          },
          finalPriceCents: 12000,
          guestCount: 1,
        }),
      ]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["child_1"]);
      expect(mockDetachPaymentMethod).toHaveBeenCalledWith("pm_parent_1");
      // By pm id, not by booking: this is what stops the next run re-borrowing it.
      expect(mockPaymentUpdateMany).toHaveBeenCalledWith({
        where: { stripePaymentMethodId: "pm_parent_1" },
        data: { stripePaymentMethodId: null },
      });
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    });

    it("soft decline inside the first window: today's behaviour — release, admin alert, retry next run; nothing cleared", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({
          type: "card_error",
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(releasedClaimCall()).toBeDefined();
      expect(mockDetachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
      expect(ledgerCardClearCalls()).toHaveLength(0);
      // #3267: a soft decline is still a DEFINITE Stripe answer, so the attempt
      // row is ended and the next run mints a fresh key — retry, on a new attempt.
      expect(attemptFailedMarkCall()).toBeDefined();
      expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: "Your card has insufficient funds." }),
      );
    });

    it("soft decline still failing two windows after the charge became due: terminal", async () => {
      // Hold expired 2026-07-04, now 2026-07-09: five days overdue = window 3.
      mockPendingBookings([makePendingBooking("b1", { holdUntil: "2026-07-04" })]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({
          type: "card_error",
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockDetachPaymentMethod).toHaveBeenCalledWith("pm_b1");
      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
      expect(alert.errorMessage).toContain("two days");
      expect(alert.errorMessage).toContain("insufficient funds");
    });

    it("counts the window from the hold the claim actually acted on, clamped to creation — a last-minute booking is not exhausted on its first decline", async () => {
      // Booked 2026-07-08 for a stay whose hold deadline (checkIn - 7d) was
      // already a week in the past at creation. Anchoring on that deadline
      // would call the FIRST soft decline exhausted; the createdAt clamp is
      // what gives the member their two days.
      const booking = makePendingBooking("b_late", {
        checkIn: "2026-07-10",
        checkOut: "2026-07-12",
        holdUntil: "2026-07-03",
      });
      booking.createdAt = new Date("2026-07-08T00:00:00.000Z");
      mockPendingBookings([booking]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds" }),
      );

      await confirmPendingBookings();

      expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
      expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    });

    it("api_error is retried however overdue the hold is", async () => {
      mockPendingBookings([makePendingBooking("b1", { holdUntil: "2026-07-01" })]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "api_error", message: "Stripe is having a moment" }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockDetachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
      expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: "Stripe is having a moment" }),
      );
    });

    it("a permanently declined card (decline_code lost_card) is terminal on the very first attempt", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "card_error", code: "card_declined", decline_code: "lost_card", message: "Your card was declined." }),
      );

      await confirmPendingBookings();

      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
      expect(alert.errorMessage).toContain("decline lost_card");
    });

    it("a member-email failure does not throw, does not undo the clear, and the admin alert still goes", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );
      mockSendSavedCardChargeFailedEmail.mockRejectedValue(new Error("SES down"));

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
      expect(alert.errorMessage).toContain("found unusable");
    });

    it("a detach Stripe refuses with invalid_request_error (already detached or gone) is swallowed and the rows are still cleared", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );
      mockDetachPaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: "The payment method you provided is not attached to a customer" }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockDetachPaymentMethod).toHaveBeenCalledTimes(1);
      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(ledgerCardClearCalls()).toHaveLength(1);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    });

    it("a detach that fails for any other reason (api_error) clears nothing, tells the member nothing, and falls back to the ordinary retry alert quoting the charge error", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );
      mockDetachPaymentMethod.mockRejectedValue(
        stripeError({ type: "api_error", message: "Stripe is having a moment" }),
      );

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      expect(mockDetachPaymentMethod).toHaveBeenCalledTimes(1);
      // The card may still be attached at Stripe, so it must stay on the rows:
      // "a cleared card is always a detached card" (INV-PAY-054).
      expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
      expect(ledgerCardClearCalls()).toHaveLength(0);
      expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
      // One alert, and it is the pre-#3268 retry alert carrying the CHARGE
      // error's own words — not the terminal "found unusable" account, which
      // would claim a retirement that did not happen.
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
      expect(alert.errorMessage).toBe(INCIDENT_MESSAGE);
      expect(alert.errorMessage).not.toContain("found unusable");
    });

    it("when the claim release itself fails, the terminal alert says the booking is stuck confirmed-unpaid — never 'stays pending'", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );
      // The claim (PENDING -> CONFIRMED) lands; the release (CONFIRMED -> PENDING)
      // is the write that fails.
      mockBookingUpdateMany.mockImplementation(async (call: any) => {
        if (call?.where?.status === "CONFIRMED" && call?.data?.status === "PENDING") {
          throw new Error("release lost its connection");
        }
        return { count: 1 };
      });

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1"]);
      // The card is still retired and both notices still go — the member's
      // card is unusable whether or not the release landed.
      expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
      expect(alert.errorMessage).toContain("found unusable");
      expect(alert.errorMessage).not.toContain("stays pending");
      expect(alert.errorMessage).toContain("still marked confirmed but unpaid");
    });

    it("a failure inside the terminal decision falls back to today's release-and-alert, and never escapes the loop", async () => {
      mockPendingBookings([
        makePendingBooking("b1"),
        makePendingBooking("b2", { holdUntil: "2026-07-07" }),
      ]);
      capacityAvailable();
      mockChargePaymentMethod.mockRejectedValue(
        stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE }),
      );
      mockPaymentUpdateMany.mockRejectedValueOnce(new Error("DB down"));

      const result = await confirmPendingBookings();

      expect(result.failedBookingIds).toEqual(["b1", "b2"]);
      // b1: the clear threw, so the generic alert went out with Stripe's words;
      // b2: retired normally. Two admin alerts, one member email.
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(2);
      expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
      const messages = mockSendAdminPaymentFailureAlert.mock.calls.map(
        ([call]) => (call as { errorMessage: string }).errorMessage,
      );
      expect(messages[0]).toBe(INCIDENT_MESSAGE);
      expect(messages[1]).toContain("found unusable");
    });

    it("leaves the PROCESSING / requires_action branch alone (an intent RETURNED, not thrown, is not a charge failure)", async () => {
      mockPendingBookings([makePendingBooking("b1")]);
      capacityAvailable();
      mockChargePaymentMethod.mockResolvedValue({
        id: "pi_auto_1",
        status: "requires_action",
        amount: 10000,
        payment_method: "pm_b1",
      });

      await confirmPendingBookings();

      expect(mockDetachPaymentMethod).not.toHaveBeenCalled();
      expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
      expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
    });
  });
});
