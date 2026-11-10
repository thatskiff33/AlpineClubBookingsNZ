import type { LedgerLineKind, MemberMoneyAccount, MemberMoneyOrigin } from "@prisma/client";

/**
 * THE CAPTURE KINDS (#3583, #4516, `INV-SSOT`): the booking-ledger SETTLEMENT
 * kinds that record money the club received, as `captureShape` in
 * `booking-ledger-settlement-posting.ts` posts them. Each carries the cash
 * account and origin its member-money receipt (R06/R07/R08) posts to.
 *
 * One exhaustive map, read by the settlement planner (its return type), the
 * booking-ledger census and the receipt hook and census, so a capture kind
 * cannot reach one of them without the others: a kind added here needs its
 * cash account, and a kind the planner posts must be named here.
 */
export type CaptureKind = Extract<LedgerLineKind, "CARD_CAPTURE" | "BANK_RECEIPT" | "CASH_RECORDED">;

export const CAPTURE_KIND_RECEIPTS = {
  CARD_CAPTURE: { cash: "STRIPE_CLEARING", origin: "STRIPE" },
  BANK_RECEIPT: { cash: "BANK", origin: "XERO" },
  CASH_RECORDED: { cash: "CASH", origin: "OFFICER" },
} as const satisfies Record<CaptureKind, { cash: MemberMoneyAccount; origin: MemberMoneyOrigin }>;

export const CAPTURE_KINDS: readonly CaptureKind[] = Object.keys(CAPTURE_KIND_RECEIPTS) as CaptureKind[];

/** The cash accounts a receipt debits, one per capture kind. */
export const CAPTURE_CASH_ACCOUNTS: readonly MemberMoneyAccount[] = CAPTURE_KINDS.map((kind) => CAPTURE_KIND_RECEIPTS[kind].cash);
