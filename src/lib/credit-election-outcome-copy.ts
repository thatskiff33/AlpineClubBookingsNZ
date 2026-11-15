import type { StoredCreditElectionOutcome } from "@/lib/booking-credit-election";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

// Only the member-facing fields cross this display boundary; the balance and
// ledger metadata stay owned by the server's StoredCreditElectionOutcome. The
// balance is a raw ledger sum that can be negative, so it is not validated here.
type CreditElectionDisplayOutcome = Pick<StoredCreditElectionOutcome,
  "requestedCents" | "appliedCents" | "shortfallCents" | "shortfallReason" | "fullyCovered">;

type ShortfallReason = StoredCreditElectionOutcome["shortfallReason"];
// One record defines both the valid shortfall reasons and their wording, so a
// reason added to the server outcome cannot compile without copy here.
const SHORTFALL_COPY = {
  none: "",
  balance: "you no longer hold that much credit",
  price: "the booking no longer costs that much",
  balance_and_price: "you no longer hold that much credit and the booking no longer costs that much",
} satisfies Record<ShortfallReason, string>;

function isShortfallReason(value: unknown): value is ShortfallReason {
  return typeof value === "string" && Object.hasOwn(SHORTFALL_COPY, value);
}

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Ignore malformed/older payloads rather than inventing a credit application. */
export function parseCreditElectionOutcome(value: unknown): CreditElectionDisplayOutcome | null {
  if (!value || typeof value !== "object") return null;
  const { requestedCents, appliedCents, shortfallCents, shortfallReason, fullyCovered } =
    value as Record<string, unknown>;
  if (!isCents(requestedCents) || !isCents(appliedCents) || !isCents(shortfallCents) ||
      typeof fullyCovered !== "boolean") return null;
  if (requestedCents - appliedCents !== shortfallCents) return null;
  if (!isShortfallReason(shortfallReason)) return null;
  if ((shortfallCents === 0) !== (shortfallReason === "none")) return null;
  return { requestedCents, appliedCents, shortfallCents, shortfallReason, fullyCovered };
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
    message = `You asked to use ${formatCents(outcome.requestedCents, format)} credit. ${applied} was applied because ${SHORTFALL_COPY[outcome.shortfallReason]}. Any unused credit stays on your account.`;
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
