import { prisma } from "./prisma";
import {
  AdminCreditAdjustmentRequestStatus,
  BookingEventType,
  CreditType,
  Prisma,
} from "@prisma/client";
import { createAuditLog } from "./audit";
import { recordBookingEvent } from "./booking-events";
import { isPrismaUniqueConstraintError } from "./prisma-errors";
import { applyLocalRefundAllocation } from "./payment-transactions";
import logger from "@/lib/logger";
import {
  assertMatchingIdempotentAdjustmentRequest,
  calculateAppliedCreditAmount,
  calculateRestoredCreditAmount,
  formatAdjustmentAmount,
  validateAdjustmentAmount,
  validateCreditApplicationAmount,
  validateCreditApplicationAgainstBalance,
  validateNegativeAdjustmentAgainstBalance,
} from "@/lib/policies/member-credit";

const MEMBER_CREDIT_LOCK_NAMESPACE = "member-credit-ledger";

const adminAdjustmentRequestSelect = {
  id: true,
  memberId: true,
  amountCents: true,
  description: true,
  idempotencyKey: true,
  status: true,
  requestedById: true,
} satisfies Prisma.AdminCreditAdjustmentRequestSelect;

type AdminAdjustmentRequestRecord = Prisma.AdminCreditAdjustmentRequestGetPayload<{
  select: typeof adminAdjustmentRequestSelect;
}>;

const bookingModificationCreditSelect = {
  id: true,
  memberId: true,
  amountCents: true,
  type: true,
  sourceBookingId: true,
  sourceBookingModificationId: true,
  xeroCreditNoteId: true,
} satisfies Prisma.MemberCreditSelect;

type BookingModificationCreditRecord = Prisma.MemberCreditGetPayload<{
  select: typeof bookingModificationCreditSelect;
}>;

const adminAdjustmentRequestListSelect = {
  id: true,
  memberId: true,
  amountCents: true,
  description: true,
  status: true,
  requestedById: true,
  reviewedById: true,
  reviewedAt: true,
  createdAt: true,
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  requestedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },
  reviewedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },
  approvedCredit: {
    select: {
      id: true,
      createdAt: true,
    },
  },
} satisfies Prisma.AdminCreditAdjustmentRequestSelect;

export type AdminAdjustmentRequestListItem =
  Prisma.AdminCreditAdjustmentRequestGetPayload<{
    select: typeof adminAdjustmentRequestListSelect;
  }>;

/**
 * Get a member's available credit balance (sum of all credit entries).
 * Positive entries = credit added, negative entries = credit used.
 */
export async function getMemberCreditBalance(
  memberId: string,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx || prisma;
  const result = await db.memberCredit.aggregate({
    where: { memberId },
    _sum: { amountCents: true },
  });
  return result._sum.amountCents ?? 0;
}

/**
 * Create a credit entry for a cancellation refund held as credit.
 */
export async function createCancellationCredit(
  memberId: string,
  amountCents: number,
  bookingId: string,
  xeroCreditNoteId?: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const db = tx || prisma;
  await db.memberCredit.create({
    data: {
      memberId,
      amountCents,
      type: CreditType.CANCELLATION_REFUND,
      description: `Cancellation refund for booking ${bookingId.slice(0, 8)}`,
      sourceBookingId: bookingId,
      xeroCreditNoteId: xeroCreditNoteId ?? null,
    },
  });

  // Durable CREDITED settlement fact for the cancellation narrative (issue
  // #740). Written on the base client so it is not tied to the caller's
  // transaction; the CANCELLED event with the policy snapshot is written by
  // the cancellation flow.
  await recordBookingEvent({
    bookingId,
    type: BookingEventType.CREDITED,
    amountCents,
    reason: "Cancellation refund held as account credit.",
  });
}

/**
 * Create a credit entry for a booking modification refund held as account credit.
 *
 * When `paymentId` is provided, the credit is also allocated against the
 * payment's captured transactions (`applyLocalRefundAllocation`), exactly as
 * the cancellation credit path does (#1031): a credit-settled reduction
 * consumes refundable value like a card refund, so `refundedAmountCents` must
 * reflect it or a later cancel refunds the same cents twice.
 */
export async function createBookingModificationCredit(
  memberId: string,
  amountCents: number,
  bookingId: string,
  bookingModificationId: string,
  xeroCreditNoteId?: string,
  tx?: Prisma.TransactionClient,
  paymentId?: string
): Promise<void> {
  const db = tx || prisma;
  const existingCredit = await findBookingModificationCredit(
    db,
    bookingModificationId
  );
  if (existingCredit) {
    await assertMatchingBookingModificationCredit(db, existingCredit, {
      memberId,
      amountCents,
      bookingId,
      bookingModificationId,
      xeroCreditNoteId,
    });
    return;
  }

  try {
    await db.memberCredit.create({
      data: {
        memberId,
        amountCents,
        type: CreditType.BOOKING_MODIFICATION_REFUND,
        description: `Booking reduction credit for booking ${bookingId.slice(0, 8)}`,
        sourceBookingId: bookingId,
        sourceBookingModificationId: bookingModificationId,
        xeroCreditNoteId: xeroCreditNoteId ?? null,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const replayedCredit = await findBookingModificationCredit(
      db,
      bookingModificationId
    );
    if (!replayedCredit) {
      throw error;
    }
    await assertMatchingBookingModificationCredit(db, replayedCredit, {
      memberId,
      amountCents,
      bookingId,
      bookingModificationId,
      xeroCreditNoteId,
    });
    // Replay: the allocation happened atomically with the original credit.
    return;
  }

  if (paymentId) {
    await applyLocalRefundAllocation({
      paymentId,
      amountCents,
      store: db,
    });
  }
}

async function findBookingModificationCredit(
  db: Prisma.TransactionClient | typeof prisma,
  bookingModificationId: string
): Promise<BookingModificationCreditRecord | null> {
  return db.memberCredit.findUnique({
    where: { sourceBookingModificationId: bookingModificationId },
    select: bookingModificationCreditSelect,
  });
}

async function assertMatchingBookingModificationCredit(
  db: Prisma.TransactionClient | typeof prisma,
  existingCredit: BookingModificationCreditRecord,
  expected: {
    memberId: string;
    amountCents: number;
    bookingId: string;
    bookingModificationId: string;
    xeroCreditNoteId?: string;
  }
): Promise<void> {
  if (
    existingCredit.memberId !== expected.memberId ||
    existingCredit.amountCents !== expected.amountCents ||
    existingCredit.type !== CreditType.BOOKING_MODIFICATION_REFUND ||
    existingCredit.sourceBookingId !== expected.bookingId ||
    existingCredit.sourceBookingModificationId !== expected.bookingModificationId
  ) {
    throw new Error(
      `Booking modification credit ${expected.bookingModificationId} already exists with different ledger details`
    );
  }

  const expectedXeroCreditNoteId = expected.xeroCreditNoteId ?? null;
  if (
    existingCredit.xeroCreditNoteId &&
    expectedXeroCreditNoteId &&
    existingCredit.xeroCreditNoteId !== expectedXeroCreditNoteId
  ) {
    throw new Error(
      `Booking modification credit ${expected.bookingModificationId} already links to a different Xero credit note`
    );
  }

  if (!existingCredit.xeroCreditNoteId && expectedXeroCreditNoteId) {
    await db.memberCredit.update({
      where: { id: existingCredit.id },
      data: { xeroCreditNoteId: expectedXeroCreditNoteId },
    });
  }
}

/**
 * Apply credit to a booking (creates a negative entry).
 * Validates that the member has sufficient balance.
 * Must be called within a transaction to prevent race conditions.
 */
/**
 * Total account credit locally applied to a booking, as a positive cents amount
 * (`|Σ BOOKING_APPLIED|`). This is the ledger truth the effective booking price is
 * derived from: `effectivePriceCents = finalPriceCents − deriveBookingAppliedCreditCents`.
 *
 * Reads ALL BOOKING_APPLIED rows (not the `xeroCreditNoteId: null` unallocated
 * subset the Xero allocation engine keys on): the applied total is what every
 * payment amount was minted against and is stable across allocation stamping, so
 * it is the correct basis for the card/IB effective-price guards (#1641, mirroring
 * the #1620 switch-to-internet-banking derive). Restores live in CANCELLED
 * bookings (a positive CANCELLATION_REFUND row + status CANCELLED), which the card
 * payment path never reconciles, so no restore subtraction is needed here.
 */
export async function deriveBookingAppliedCreditCents(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<number> {
  const agg = await db.memberCredit.aggregate({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
    },
    _sum: { amountCents: true },
  });
  return Math.max(0, -(agg._sum.amountCents ?? 0));
}

export async function applyCreditToBooking(
  memberId: string,
  amountCents: number,
  bookingId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  validateCreditApplicationAmount(amountCents);

  await lockMemberCreditLedger(memberId, tx);

  const balance = await getMemberCreditBalance(memberId, tx);
  validateCreditApplicationAgainstBalance(amountCents, balance);

  await tx.memberCredit.create({
    data: {
      memberId,
      amountCents: calculateAppliedCreditAmount(amountCents),
      type: CreditType.BOOKING_APPLIED,
      description: `Applied to booking ${bookingId.slice(0, 8)}`,
      appliedToBookingId: bookingId,
    },
  });
}

/**
 * Restore credit that was previously applied to a booking (on cancellation).
 * Creates a positive CANCELLATION_REFUND entry to reverse the applied credit.
 *
 * `restoreAmountCentsOverride` (#1164 / D7): the member-cancellation path passes
 * the tiered restore amount so the applied-credit slice is penalised by the same
 * cancellation tier as the card slice. When omitted, the FULL applied total is
 * restored — the payment-reconciliation `capacity_failed` system void relies on
 * this default (a system void must never penalise the member).
 */
export async function restoreCreditFromBooking(
  memberId: string,
  bookingId: string,
  tx?: Prisma.TransactionClient,
  restoreAmountCentsOverride?: number
): Promise<number> {
  const db = tx || prisma;

  // Find all BOOKING_APPLIED credits for this booking
  const appliedCredits = await db.memberCredit.findMany({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
    },
  });

  if (appliedCredits.length === 0) {
    return 0;
  }

  const totalApplied = calculateRestoredCreditAmount(appliedCredits);

  // Cap the override at what was actually applied. INVARIANT the cap relies on:
  // payment.creditAppliedCents (the mirror the cancel path tiers) == Σ
  // BOOKING_APPLIED (this ledger sum). If the mirror ever exceeds the ledger,
  // the cap makes actual < preview — the SAFE direction (never over-restore).
  // Do NOT remove the cap as "dead code".
  const amount =
    restoreAmountCentsOverride === undefined
      ? totalApplied
      : Math.max(0, Math.min(restoreAmountCentsOverride, totalApplied));

  if (amount <= 0) {
    return 0;
  }

  // Create a positive entry to restore the credit
  await db.memberCredit.create({
    data: {
      memberId,
      amountCents: amount,
      type: CreditType.CANCELLATION_REFUND,
      description: `Credit restored from cancelled booking ${bookingId.slice(0, 8)}`,
      sourceBookingId: bookingId,
    },
  });

  return amount;
}

/**
 * Get credit transaction history for a member.
 */
export async function getMemberCreditHistory(memberId: string) {
  return prisma.memberCredit.findMany({
    where: { memberId },
    include: {
      sourceBooking: {
        select: { id: true, checkIn: true, checkOut: true },
      },
      appliedToBooking: {
        select: { id: true, checkIn: true, checkOut: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get credit transaction history for a member, including admin approval metadata.
 */
export async function getAdminMemberCreditHistory(memberId: string) {
  return prisma.memberCredit.findMany({
    where: { memberId },
    include: {
      sourceBooking: {
        select: { id: true, checkIn: true, checkOut: true },
      },
      appliedToBooking: {
        select: { id: true, checkIn: true, checkOut: true },
      },
      requestedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      approvedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      approvalRequest: {
        select: { createdAt: true, reviewedAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get pending admin adjustment requests for a member.
 */
export async function getPendingAdminAdjustmentRequests(memberId: string) {
  return prisma.adminCreditAdjustmentRequest.findMany({
    where: {
      memberId,
      status: AdminCreditAdjustmentRequestStatus.PENDING,
    },
    include: {
      requestedBy: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get admin adjustment requests across all members for the shared review queue.
 */
export async function getAdminAdjustmentRequests(
  status: AdminCreditAdjustmentRequestStatus | "ALL" = AdminCreditAdjustmentRequestStatus.PENDING
): Promise<AdminAdjustmentRequestListItem[]> {
  return prisma.adminCreditAdjustmentRequest.findMany({
    where:
      status === "ALL"
        ? undefined
        : {
            status,
          },
    select: adminAdjustmentRequestListSelect,
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Serialize all writers of one member's credit ledger. Take this advisory lock
 * (transaction-scoped) at the top of any transaction that reads-then-writes a
 * member's MemberCredit rows so balance validations and restores cannot
 * interleave. Exported for the orphaned-applied-credit backfill (#1547), which
 * re-checks its heal predicate under this lock to stay idempotent.
 */
export async function lockMemberCreditLedger(
  memberId: string,
  tx: Prisma.TransactionClient
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${MEMBER_CREDIT_LOCK_NAMESPACE}),
      hashtext(${memberId})
    )
  `;
}

async function validateNegativeAdjustmentBalance(
  memberId: string,
  amountCents: number,
  tx?: Prisma.TransactionClient
) {
  if (amountCents < 0) {
    const balance = await getMemberCreditBalance(memberId, tx);
    validateNegativeAdjustmentAgainstBalance(amountCents, balance);
  }
}

async function findAdminAdjustmentRequestByIdempotencyKey(
  requestedById: string,
  idempotencyKey: string
): Promise<AdminAdjustmentRequestRecord | null> {
  return prisma.adminCreditAdjustmentRequest.findUnique({
    where: {
      requestedById_idempotencyKey: {
        requestedById,
        idempotencyKey,
      },
    },
    select: adminAdjustmentRequestSelect,
  });
}

/**
 * Create an admin manual credit adjustment request.
 * A second admin must approve the request before the credit is applied.
 */
export async function createAdminAdjustmentRequest(
  memberId: string,
  amountCents: number,
  description: string,
  adminId: string,
  idempotencyKey: string,
  ipAddress?: string
) {
  validateAdjustmentAmount(amountCents);

  const existingRequest = await findAdminAdjustmentRequestByIdempotencyKey(
    adminId,
    idempotencyKey
  );

  if (existingRequest) {
    assertMatchingIdempotentAdjustmentRequest(existingRequest, {
      memberId,
      amountCents,
      description,
      requestedById: adminId,
    });

    logger.info(
      {
        memberId,
        amountCents,
        adminId,
        requestId: existingRequest.id,
        idempotencyKey,
      },
      "Admin credit adjustment request replayed"
    );

    return {
      request: existingRequest,
      replayed: true,
    };
  }

  try {
    const request = await prisma.$transaction(async (tx) => {
      const createdRequest = await tx.adminCreditAdjustmentRequest.create({
        data: {
          memberId,
          amountCents,
          description,
          idempotencyKey,
          requestedById: adminId,
        },
        select: adminAdjustmentRequestSelect,
      });

      await validateNegativeAdjustmentBalance(memberId, amountCents, tx);

      await createAuditLog(
        {
          action: "member.credit.adjustment.request",
          memberId: adminId,
          targetId: memberId,
          details: `Requested admin credit adjustment ${createdRequest.id}: ${formatAdjustmentAmount(amountCents)}. Reason: ${description}`,
          ipAddress,
        },
        tx
      );

      return createdRequest;
    });

    logger.info(
      { memberId, amountCents, adminId, requestId: request.id, idempotencyKey },
      "Admin credit adjustment request created"
    );

    return {
      request,
      replayed: false,
    };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      const replayedRequest = await findAdminAdjustmentRequestByIdempotencyKey(
        adminId,
        idempotencyKey
      );

      if (replayedRequest) {
        assertMatchingIdempotentAdjustmentRequest(replayedRequest, {
          memberId,
          amountCents,
          description,
          requestedById: adminId,
        });

        logger.info(
          {
            memberId,
            amountCents,
            adminId,
            requestId: replayedRequest.id,
            idempotencyKey,
          },
          "Admin credit adjustment request replayed after unique conflict"
        );

        return {
          request: replayedRequest,
          replayed: true,
        };
      }
    }

    throw error;
  }
}

/**
 * Review a pending admin adjustment request.
 * Approval applies the adjustment and stamps both admins onto the credit row.
 */
export async function reviewAdminAdjustmentRequest(
  memberId: string,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  adminId: string,
  ipAddress?: string
) {
  const result = await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(memberId, tx);

    const request = await tx.adminCreditAdjustmentRequest.findUnique({
      where: { id: requestId },
      select: adminAdjustmentRequestSelect,
    });

    if (!request || request.memberId !== memberId) {
      throw new Error("Adjustment request not found");
    }

    if (request.status !== AdminCreditAdjustmentRequestStatus.PENDING) {
      throw new Error("This adjustment request has already been reviewed");
    }

    if (request.requestedById === adminId) {
      throw new Error("A different admin must approve this adjustment");
    }

    if (decision === "APPROVE") {
      validateAdjustmentAmount(request.amountCents);
      await validateNegativeAdjustmentBalance(
        request.memberId,
        request.amountCents,
        tx
      );
    }

    const reviewedAt = new Date();
    const updated = await tx.adminCreditAdjustmentRequest.updateMany({
      where: {
        id: request.id,
        memberId,
        status: AdminCreditAdjustmentRequestStatus.PENDING,
      },
      data: {
        status:
          decision === "APPROVE"
            ? AdminCreditAdjustmentRequestStatus.APPROVED
            : AdminCreditAdjustmentRequestStatus.REJECTED,
        reviewedById: adminId,
        reviewedAt,
      },
    });

    if (updated.count !== 1) {
      throw new Error("This adjustment request has already been reviewed");
    }

    if (decision === "REJECT") {
      await createAuditLog(
        {
          action: "member.credit.adjustment.reject",
          memberId: adminId,
          targetId: memberId,
          details: `Rejected admin credit adjustment ${request.id}: ${formatAdjustmentAmount(request.amountCents)}. Requested by ${request.requestedById}. Reason: ${request.description}`,
          ipAddress,
        },
        tx
      );

      return {
        decision,
        request,
        credit: null,
      };
    }

    const credit = await tx.memberCredit.create({
      data: {
        memberId: request.memberId,
        amountCents: request.amountCents,
        type: CreditType.ADMIN_ADJUSTMENT,
        description: request.description,
        requestedById: request.requestedById,
        approvedById: adminId,
        approvalRequestId: request.id,
      },
    });

    await createAuditLog(
      {
        action: "member.credit.adjustment.approve",
        memberId: adminId,
        targetId: memberId,
        details: `Approved admin credit adjustment ${request.id} as credit ${credit.id}: ${formatAdjustmentAmount(request.amountCents)}. Requested by ${request.requestedById}. Reason: ${request.description}`,
        ipAddress,
      },
      tx
    );

    return {
      decision,
      request,
      credit,
    };
  });

  logger.info(
    {
      memberId,
      requestId: result.request.id,
      creditId: result.credit?.id,
      amountCents: result.request.amountCents,
      adminId,
    },
    result.decision === "APPROVE"
      ? "Admin credit adjustment approved"
      : "Admin credit adjustment rejected"
  );

  return result;
}
