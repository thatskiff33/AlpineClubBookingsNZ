/**
 * The two accounts a manual credit grant can post to (#4431).
 *
 * Safe to import from the client: labels, the wire values, and the mapping
 * key. The mint-account module is imported as a type only, so a screen does
 * not take the Xero client. A rename of either mapping key fails here.
 */
import type { MintSliceMappingKey } from "@/lib/xero-applied-credit-mint-accounts";

export const ADMIN_CREDIT_GRANT_ACCOUNTS = ["MEMBER_OWN_MONEY", "GOODWILL"] as const;

export type AdminCreditGrantAccount = (typeof ADMIN_CREDIT_GRANT_ACCOUNTS)[number];

/** Same two strings as `MintSliceMappingKey`. The worker copies the value. */
export const ADMIN_CREDIT_GRANT_MAPPING = {
  MEMBER_OWN_MONEY: "hutFeeRefunds",
  GOODWILL: "goodwillWriteOffs",
} as const satisfies Record<AdminCreditGrantAccount, MintSliceMappingKey>;

export type AdminCreditGrantMappingKey =
  (typeof ADMIN_CREDIT_GRANT_MAPPING)[AdminCreditGrantAccount];

export const ADMIN_CREDIT_GRANT_ACCOUNT_LABEL: Record<AdminCreditGrantAccount, string> = {
  MEMBER_OWN_MONEY: "Member's own money (overpayment, double charge)",
  GOODWILL: "Goodwill",
};

/** Shown when a positive request was stored before an account was chosen. */
export const GRANT_ACCOUNT_MISSING_MESSAGE =
  "This request was made before an account was chosen; reject it and ask for a new one.";

/** A positive grant has to name one of the two accounts. */
export const GRANT_ACCOUNT_REQUIRED_MESSAGE = "Choose which account this credit belongs to.";

/** A deduction never posts a note, so it has no account to name. */
export const DEDUCTION_HAS_NO_ACCOUNT_MESSAGE = "A deduction does not choose a Xero account.";

/**
 * A deduction against credit that already has a Xero note, or is waiting for
 * the note queued at approval. Taking the balance down would leave that note
 * at its full amount.
 */
export const NOTED_CREDIT_DEDUCTION_MESSAGE =
  "This deduction cannot be approved while the member has credit that already has a Xero credit note, because the note would stay at its full amount; reject the request.";

export function isAdminCreditGrantAccount(value: unknown): value is AdminCreditGrantAccount {
  return ADMIN_CREDIT_GRANT_ACCOUNTS.some((account) => account === value);
}

export function adminCreditGrantAccountLabel(account: AdminCreditGrantAccount): string {
  return ADMIN_CREDIT_GRANT_ACCOUNT_LABEL[account];
}

/** The officer audit line names the account. Empty when the request has none. */
export function adminCreditGrantAuditClause(account: AdminCreditGrantAccount | null): string {
  return account ? ` Account: ${ADMIN_CREDIT_GRANT_ACCOUNT_LABEL[account]}.` : "";
}

/**
 * `MEMBER_OWN_MONEY` posts to `hutFeeRefunds`. `GOODWILL` posts to
 * `goodwillWriteOffs`, which still falls back to `hutFeeRefunds` while unset
 * (`INV-INT-021`). The worker copies this key; it does not read the description.
 */
export function adminCreditGrantMappingKey(
  account: AdminCreditGrantAccount,
): AdminCreditGrantMappingKey {
  return ADMIN_CREDIT_GRANT_MAPPING[account];
}
