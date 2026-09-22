// test seam
import { formatCents, formatSignedCents } from "@/lib/utils";
export const ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT =
  "This idempotency key was already used for a different adjustment request";

export class MemberCreditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberCreditValidationError";
  }
}

export interface AdminAdjustmentRequestComparison {
  memberId: string;
  amountCents: number;
  description: string;
  requestedById: string;
}

export interface CreditAmountEntry {
  amountCents: number;
}

export function formatAdjustmentAmount(amountCents: number): string {
  return formatSignedCents(amountCents);
}

export function validateAdjustmentAmount(amountCents: number): void {
  if (amountCents === 0) {
    throw new MemberCreditValidationError("Adjustment amount cannot be zero");
  }
}

export function validateNegativeAdjustmentAgainstBalance(
  amountCents: number,
  balanceCents: number
): void {
  if (amountCents < 0 && balanceCents + amountCents < 0) {
    throw new MemberCreditValidationError(
      `Cannot deduct ${formatCents(Math.abs(amountCents))}: only ${formatCents(balanceCents)} available`
    );
  }
}

export function validateCreditApplicationAmount(amountCents: number): void {
  if (amountCents <= 0) {
    throw new MemberCreditValidationError("Credit amount must be positive");
  }
}

export function validateCreditApplicationAgainstBalance(
  amountCents: number,
  balanceCents: number
): void {
  validateCreditApplicationAmount(amountCents);

  if (balanceCents < amountCents) {
    throw new MemberCreditValidationError(
      `Insufficient credit balance: ${formatCents(balanceCents)} available, ${formatCents(amountCents)} requested`
    );
  }
}

export function calculateAppliedCreditAmount(amountCents: number): number {
  validateCreditApplicationAmount(amountCents);
  return -amountCents;
}

/**
 * Credit still applied to a booking, as a positive cents amount — the correct
 * default restore total.
 *
 * This is the SIGNED net of the BOOKING_APPLIED rows (`max(0, -Σ amount)`), NOT
 * `Σ|amount|`. Before F20 (#1887) every BOOKING_APPLIED row was negative, so the
 * two were equal. The F20 clamp appends a POSITIVE BOOKING_APPLIED offset row to
 * return an over-consumed slice on a pre-payment reprice, so `Σ|amount|` now
 * over-counts by 2×excess; a default (no-override) restore keyed on the abs-sum
 * would mint credit from nothing. Netting is exact for any mix of signs and
 * identical to the old abs-sum when all rows are negative.
 */
export function calculateRestoredCreditAmount(
  appliedCredits: CreditAmountEntry[]
): number {
  const net = appliedCredits.reduce((sum, credit) => sum + credit.amountCents, 0);
  return Math.max(0, -net);
}

export function assertMatchingIdempotentAdjustmentRequest(
  request: AdminAdjustmentRequestComparison,
  expected: AdminAdjustmentRequestComparison
): void {
  if (
    request.memberId !== expected.memberId ||
    request.amountCents !== expected.amountCents ||
    request.description !== expected.description ||
    request.requestedById !== expected.requestedById
  ) {
    throw new MemberCreditValidationError(ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT);
  }
}
