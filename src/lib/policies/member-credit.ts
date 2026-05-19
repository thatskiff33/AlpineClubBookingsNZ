export const ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT =
  "This idempotency key was already used for a different adjustment request";

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
  return `${amountCents > 0 ? "+" : ""}${amountCents} cents`;
}

export function validateAdjustmentAmount(amountCents: number): void {
  if (amountCents === 0) {
    throw new Error("Adjustment amount cannot be zero");
  }
}

export function validateNegativeAdjustmentAgainstBalance(
  amountCents: number,
  balanceCents: number
): void {
  if (amountCents < 0 && balanceCents + amountCents < 0) {
    throw new Error(
      `Cannot deduct ${Math.abs(amountCents)} cents: only ${balanceCents} cents available`
    );
  }
}

export function validateCreditApplicationAmount(amountCents: number): void {
  if (amountCents <= 0) {
    throw new Error("Credit amount must be positive");
  }
}

export function validateCreditApplicationAgainstBalance(
  amountCents: number,
  balanceCents: number
): void {
  validateCreditApplicationAmount(amountCents);

  if (balanceCents < amountCents) {
    throw new Error(
      `Insufficient credit balance: ${balanceCents} cents available, ${amountCents} cents requested`
    );
  }
}

export function calculateAppliedCreditAmount(amountCents: number): number {
  validateCreditApplicationAmount(amountCents);
  return -amountCents;
}

export function calculateRestoredCreditAmount(
  appliedCredits: CreditAmountEntry[]
): number {
  return appliedCredits.reduce((sum, credit) => sum + Math.abs(credit.amountCents), 0);
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
    throw new Error(ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT);
  }
}
