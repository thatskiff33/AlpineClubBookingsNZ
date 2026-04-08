import { prisma } from "./prisma";
import { CreditType, Prisma } from "@prisma/client";
import { logAudit } from "./audit";
import logger from "@/lib/logger";

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
}

/**
 * Apply credit to a booking (creates a negative entry).
 * Validates that the member has sufficient balance.
 * Must be called within a transaction to prevent race conditions.
 */
export async function applyCreditToBooking(
  memberId: string,
  amountCents: number,
  bookingId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  if (amountCents <= 0) {
    throw new Error("Credit amount must be positive");
  }

  const balance = await getMemberCreditBalance(memberId, tx);
  if (balance < amountCents) {
    throw new Error(
      `Insufficient credit balance: ${balance} cents available, ${amountCents} cents requested`
    );
  }

  await tx.memberCredit.create({
    data: {
      memberId,
      amountCents: -amountCents, // Negative = credit used
      type: CreditType.BOOKING_APPLIED,
      description: `Applied to booking ${bookingId.slice(0, 8)}`,
      appliedToBookingId: bookingId,
    },
  });
}

/**
 * Restore credit that was previously applied to a booking (on cancellation).
 * Creates a positive CANCELLATION_REFUND entry to reverse the applied credit.
 */
export async function restoreCreditFromBooking(
  memberId: string,
  bookingId: string,
  tx?: Prisma.TransactionClient
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

  // Sum up the applied amounts (they are negative, so negate to get positive)
  const totalApplied = appliedCredits.reduce(
    (sum, c) => sum + Math.abs(c.amountCents),
    0
  );

  // Create a positive entry to restore the credit
  await db.memberCredit.create({
    data: {
      memberId,
      amountCents: totalApplied,
      type: CreditType.CANCELLATION_REFUND,
      description: `Credit restored from cancelled booking ${bookingId.slice(0, 8)}`,
      sourceBookingId: bookingId,
    },
  });

  return totalApplied;
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
 * Create an admin manual credit adjustment.
 */
export async function createAdminAdjustment(
  memberId: string,
  amountCents: number,
  description: string,
  adminId: string,
  ipAddress?: string
): Promise<void> {
  if (amountCents === 0) {
    throw new Error("Adjustment amount cannot be zero");
  }

  // If negative adjustment, verify balance is sufficient
  if (amountCents < 0) {
    const balance = await getMemberCreditBalance(memberId);
    if (balance + amountCents < 0) {
      throw new Error(
        `Cannot deduct ${Math.abs(amountCents)} cents: only ${balance} cents available`
      );
    }
  }

  await prisma.memberCredit.create({
    data: {
      memberId,
      amountCents,
      type: CreditType.ADMIN_ADJUSTMENT,
      description,
    },
  });

  logAudit({
    action: "member.credit.adjustment",
    memberId: adminId,
    targetId: memberId,
    details: `Admin credit adjustment: ${amountCents > 0 ? "+" : ""}${amountCents} cents. Reason: ${description}`,
    ipAddress,
  });

  logger.info(
    { memberId, amountCents, adminId },
    "Admin credit adjustment created"
  );
}
