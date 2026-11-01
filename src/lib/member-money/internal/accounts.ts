import type { MemberMoneyAccount } from "@prisma/client";
import type {
  AccountMappingKey,
  ProposedMemberMoneyMappingKey,
} from "../../xero-account-mapping-keys";

/**
 * Stable economic identities. A mapping key is either a registered settings key
 * (the registry owns its provider code and fallback) or one of the
 * `PROPOSED_MEMBER_MONEY_MAPPING_KEYS`, which is not a setting until the ledger
 * step that first reads it registers it. M1 reads neither.
 */
export const MEMBER_MONEY_ACCOUNTS = {
  MEMBER_RECEIVABLE: { requiresDebtor: true, normalSide: "DEBIT", mappingKey: "memberReceivable", route: "DOCUMENT_CONTROL" },
  STRIPE_CLEARING: { normalSide: "DEBIT", mappingKey: "stripeBankAccount", route: "ACCOUNT" },
  BANK: { normalSide: "DEBIT", mappingKey: "memberReceiptsBankAccount", route: "ACCOUNT", refundMappingKey: "bankTransferRefundAccount" },
  CASH: { normalSide: "DEBIT", mappingKey: "memberCashAccount", route: "ACCOUNT" },
  MEMBER_CREDIT: { requiresDebtor: true, normalSide: "CREDIT", mappingKey: "memberCreditLiability", route: "DOCUMENT_CONTROL" },
  REFUND_PAYABLE: { requiresDebtor: true, normalSide: "CREDIT", mappingKey: "memberRefundPayable", route: "DOCUMENT_CONTROL" },
  BOOKING_REVENUE: { taxedRevenue: true, normalSide: "CREDIT", mappingKey: "hutFeesIncome", route: "ACCOUNT", refundMappingKey: "hutFeeRefunds" },
  SUBSCRIPTION_REVENUE: { taxedRevenue: true, normalSide: "CREDIT", mappingKey: "subscriptionIncome", route: "ACCOUNT" },
  JOINING_FEE_REVENUE: { taxedRevenue: true, normalSide: "CREDIT", mappingKey: "joiningFeeIncome", route: "ACCOUNT" },
  FEE_REVENUE: { taxedRevenue: true, normalSide: "CREDIT", mappingKey: "memberFeesIncome", route: "ACCOUNT" },
  GST_PAYABLE: { normalSide: "CREDIT", mappingKey: "memberGstPayable", route: "DOCUMENT_CONTROL" },
  STRIPE_FEES: { normalSide: "DEBIT", mappingKey: "stripeFees", route: "ACCOUNT" },
  GOODWILL: { normalSide: "DEBIT", mappingKey: "goodwillWriteOffs", route: "ACCOUNT" },
  EXTERNAL_CONTROL: { normalSide: "EITHER", mappingKey: "memberExternalControl", route: "ACCOUNT" },
  OPENING_CONTROL: { normalSide: "EITHER", mappingKey: "memberOpeningControl", route: "ACCOUNT" },
} as const satisfies Record<MemberMoneyAccount, {
  normalSide: "DEBIT" | "CREDIT" | "EITHER";
  mappingKey: AccountMappingKey | ProposedMemberMoneyMappingKey;
  refundMappingKey?: AccountMappingKey;
  route: "ACCOUNT" | "DOCUMENT_CONTROL";
  /** A leg must name its debtor (M1's `member_money_line_shape` CHECK). */
  requiresDebtor?: true;
  /** A revenue account whose legs carry a tax split (`member_money_batch_errors`' tax tie). */
  taxedRevenue?: true;
}>;

type Account = keyof typeof MEMBER_MONEY_ACCOUNTS;
const flagged = <K extends "requiresDebtor" | "taxedRevenue">(flag: K) =>
  (Object.keys(MEMBER_MONEY_ACCOUNTS) as Account[]).filter((account) => flag in MEMBER_MONEY_ACCOUNTS[account]);

/** The accounts whose legs name a debtor, derived from the registry. */
export const DEBTOR_ACCOUNTS: readonly Account[] = flagged("requiresDebtor");

/** The revenue accounts the builder splits tax out of, derived from the registry. */
export const TAXED_REVENUE_ACCOUNTS = flagged("taxedRevenue") as readonly TaxedRevenueAccount[];
export type TaxedRevenueAccount = {
  [K in Account]: (typeof MEMBER_MONEY_ACCOUNTS)[K] extends { taxedRevenue: true } ? K : never;
}[Account];
