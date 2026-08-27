import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Stripe
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");

const mockChargePaymentMethod = vi.fn();
// #1992: the auto-charge claim sweeps and cancels in-flight /pay link intents
// before charging the saved card (best-effort, outside any transaction).
const mockCancelPaymentIntentIfCancellable = vi.fn();
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
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
  cancelPaymentIntentIfCancellable: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellable(...args),
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

vi.mock("../payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
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
vi.mock("../email", () => ({
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
  mintSplitGuestPaymentLinkIfAbsent: (...args: unknown[]) =>
    mockMintSplitGuestPaymentLinkIfAbsent(...args),
  revokePaymentLinkById: (...args: unknown[]) =>
    mockRevokePaymentLinkById(...args),
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
const mockPaymentTransactionFindMany = vi.fn();
const mockPromoRedemptionFindUnique = vi.fn();
// #1993 Part A: the terminal branch records a CANCELLED booking event in-tx.
const mockBookingEventCreate = vi.fn().mockResolvedValue({ id: "evt_1" });
const mockEmailLogFindFirst = vi.fn().mockResolvedValue(null);
const mockEmailLogCreate = vi.fn().mockResolvedValue({ id: "emaillog_1" });
const mockPrismaTransaction = vi.fn();
const mockExecuteRaw = vi.fn();
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
    },
    paymentTransaction: {
      findMany: (...args: unknown[]) => mockPaymentTransactionFindMany(...args),
    },
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
    parentPayment?: {
      id: string;
      stripePaymentMethodId: string;
      stripeCustomerId: string;
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
      } | null;
    } | null;
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
    mockCancelPaymentIntentIfCancellable.mockResolvedValue(null);
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
    const expectedIdempotencyKey = ["pending", "charge", "b1"].join("_");
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

  it("charges a split non-member child using the parent booking's saved card", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
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
        stripePaymentMethodId: "pm_parent_1",
      }),
      update: expect.objectContaining({
        amountCents: 12000,
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
      }),
    });
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

  it("cancels a split non-member child without charge or invoice when capacity is gone", async () => {
    const booking = makePendingBooking("child_1", {
      hasPaymentMethod: false,
      parentBookingId: "parent_1",
      parentPayment: {
        id: "pay_parent_1",
        stripeCustomerId: "cus_parent_1",
        stripePaymentMethodId: "pm_parent_1",
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

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_b1",
        paymentIntentId: "pi_auto_1",
        amountCents: 10000,
        status: "PROCESSING",
      })
    );
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
    expect(mockEmailLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId: "child_1",
          templateName: "split-guest-payment-link",
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

    it("scopes the sweep to in-flight PRIMARY Stripe intents on the claim's payment and EXCLUDES every pending_charge_-keyed charge (the cron's own prior auto-charge AND charge-saved-method's 3DS-pending charge)", async () => {
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
          // Both reasons mint under the shared `pending_charge_<bookingId>`
          // Stripe idempotency key this run's charge replays — cancelling
          // either row would make Stripe answer this run's charge with the
          // cancelled intent (settlement stalls until the key expires). NULL
          // reasons stay in scope.
          OR: [
            { reason: null },
            {
              reason: {
                notIn: [
                  "pending_hold_auto_charge",
                  "pending_saved_method_charge",
                ],
              },
            },
          ],
        },
        select: { id: true, stripePaymentIntentId: true },
      });
    });

    it("never sweeps charge-saved-method's 3DS-pending intent (reason pending_saved_method_charge shares the pending_charge_ key), while a link intent alongside it is still cancelled", async () => {
      primeChargeableSplitChild();
      // Exercise the REAL OR-filter semantics against a mixed ledger: a
      // 3DS-pending saved-method charge row (must be excluded) and an
      // in-flight link intent with a NULL reason (must stay in scope).
      const rows = [
        {
          id: "txn_saved_method_3ds",
          stripePaymentIntentId: "pi_saved_method_3ds",
          reason: "pending_saved_method_charge",
        },
        {
          id: "txn_link",
          stripePaymentIntentId: "pi_link_inflight",
          reason: null,
        },
      ];
      mockPaymentTransactionFindMany.mockImplementation(
        async (args: {
          where: {
            OR: [
              { reason: null },
              { reason: { notIn: string[] } },
            ];
          };
        }) => {
          const excluded = args.where.OR[1].reason.notIn;
          return rows
            .filter(
              (row) => row.reason === null || !excluded.includes(row.reason)
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
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledTimes(1);
      expect(mockCancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_link_inflight"
      );
      expect(mockCancelPaymentIntentIfCancellable).not.toHaveBeenCalledWith(
        "pi_saved_method_3ds"
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
      mockPaymentTransactionFindMany.mockRejectedValue(
        new Error("ledger read failed")
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
});
