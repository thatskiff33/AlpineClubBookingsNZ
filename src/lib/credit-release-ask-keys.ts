/**
 * #4253 (`INV-ADDPAY-045`): THE KEYS OF THE CARD PAYMENT REQUEST FOR CREDIT RELEASED
 * WHEN A CREDIT NOTE WAS SPENT IN XERO OUTSIDE THE APP. Pure, so the recovery runner
 * and the Diagnostics pack can build and read them without a database client.
 *
 * The request is scoped to the RELEASE ROW (`MemberCredit`), the fact it answers, and
 * not to an edit: no `BookingModification` is involved. `payment-recovery-keys.ts`
 * re-exports the prefix, which is where every recovery key's shape is spelled (#4076).
 */
export const CREDIT_RELEASE_ASK_RECOVERY_PREFIX = "credit_release_ask_";

// The recovery key, the Stripe key and the ledger reason of a credit-release request.
// Built and read back here, never sliced at a call site: the ordinary replay's parser
// knows only the two edit-scoped prefixes and answers null for this one, so the runner
// tests `isCreditReleaseAskRecoveryKey` BEFORE that parser and hands the row to its
// own module.
export function buildCreditReleaseAskRecoveryIdempotencyKey(releaseCreditId: string) {
  return `${CREDIT_RELEASE_ASK_RECOVERY_PREFIX}${releaseCreditId}`;
}

export function buildCreditReleaseAskStripeIdempotencyKey(releaseCreditId: string) {
  return `credit_release_ask_pi_${releaseCreditId}`;
}

export function isCreditReleaseAskRecoveryKey(idempotencyKey: string | null | undefined): boolean {
  return Boolean(idempotencyKey?.startsWith(CREDIT_RELEASE_ASK_RECOVERY_PREFIX));
}

export function creditReleaseIdForAskRecoveryKey(idempotencyKey: string | null | undefined): string | null {
  if (!isCreditReleaseAskRecoveryKey(idempotencyKey)) return null;
  const id = (idempotencyKey as string).slice(CREDIT_RELEASE_ASK_RECOVERY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * The `reason` on a credit-release request's intent metadata and `PaymentTransaction`
 * row. It names the CAUSE, so every surface that words an unpaid request can say
 * why it exists without guessing from the amount (`INV-ADDPAY-045`).
 */
export const CREDIT_RELEASE_ASK_REASON = "credit_released_outside_app";

/**
 * #5008 (`INV-ADDPAY-053`): the `reason` on the request a deposit settle raises for the
 * rest of the booking's worth, the cause `balance`. It lives beside the credit-release
 * reason because both name a request's cause on the same `PaymentTransaction` rows, and
 * `additional-ask-cause.ts` reads both from here.
 */
export const DEPOSIT_BALANCE_ASK_REASON = "deposit_balance";
