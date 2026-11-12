import type { StoredCreditElectionOutcome } from "@/lib/booking-credit-election";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

// Only the member-facing fields cross this display boundary; ledger metadata
// stays owned by the server's StoredCreditElectionOutcome contract.
type CreditElectionDisplayOutcome = Pick<StoredCreditElectionOutcome,
  "requestedCents" | "appliedCents" | "shortfallCents" | "shortfallReason" |
  "availableBalanceCents" | "fullyCovered">;

/** Ignore malformed/older payloads rather than inventing a credit application. */
export function parseCreditElectionOutcome(value: unknown): CreditElectionDisplayOutcome | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const { requestedCents, appliedCents, shortfallCents, availableBalanceCents,
    shortfallReason, fullyCovered } = data;
  const cents = [requestedCents, appliedCents, shortfallCents, availableBalanceCents];
  if (!cents.every((amount) => typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0)) return null;
  if (typeof requestedCents !== "number" || typeof appliedCents !== "number" ||
      typeof shortfallCents !== "number" || typeof availableBalanceCents !== "number" ||
      typeof fullyCovered !== "boolean") return null;
  if (appliedCents > availableBalanceCents || appliedCents > requestedCents ||
      requestedCents - appliedCents !== shortfallCents) return null;
  if (shortfallReason !== "none" && shortfallReason !== "balance" &&
      shortfallReason !== "price" && shortfallReason !== "balance_and_price") return null;
  if ((shortfallCents === 0) !== (shortfallReason === "none")) return null;
  return { requestedCents, appliedCents, shortfallCents, availableBalanceCents,
    shortfallReason, fullyCovered };
}

/** One wording for card forms, credit-only completion and recovery refusals. */
export function creditElectionOutcomeCopy(
  outcome: CreditElectionDisplayOutcome | null,
  format: ClubFormat,
  chargedAmountCents?: number | null,
): string | null {
  if (!outcome) return null;
  const applied = formatCents(outcome.appliedCents, format);
  let message: string;
  if (outcome.shortfallCents > 0) {
    const reasons = {
      none: "",
      balance: "you no longer hold that much credit",
      price: "the booking no longer costs that much",
      balance_and_price: "you no longer hold that much credit and the booking no longer costs that much",
    } satisfies Record<StoredCreditElectionOutcome["shortfallReason"], string>;
    message = `You asked to use ${formatCents(outcome.requestedCents, format)} credit. ${applied} was applied because ${reasons[outcome.shortfallReason]}. Any unused credit stays on your account.`;
  } else if (outcome.appliedCents > 0) {
    message = `Your credit of ${applied} was applied.`;
  } else {
    return null;
  }
  if (outcome.fullyCovered) {
    return `${message} Your credit covered it all. No card payment is needed.`;
  }
  if (chargedAmountCents != null) {
    return `${message} Your card will be charged ${formatCents(chargedAmountCents, format)} today.`;
  }
  return message;
}
