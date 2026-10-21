/** Client-safe card-refund wording shared by checkout and the booking narrative (INV-SSOT-001). */
import type { ClubFormat } from "@/lib/club-format";
import type { CardRefundState } from "@/lib/manual-refund-task-settlement-rules";
import { cardRefundOnItsWay } from "@/lib/booking-modified-email-copy";
import { formatCents } from "@/lib/utils";

/** Existing reconciliation facts, not a claim that the whole charge was refunded. */
export interface CapacityCancellationRefund {
  chargedAmountCents: number;
  plannedRefundCents: number;
}

/**
 * #4125: what the club follows up - a dead card refund, a part no refund
 * covers - appended to a clause after "; ", or the whole clause when nothing
 * else is said (`INV-SSOT`).
 */
export function withClubFollowUp(clause: string, subjects: string[]): string {
  if (subjects.length === 0) return clause;
  const followUp = `the club will be in touch about ${subjects.join(" and ")}`;
  return clause ? `${clause}; ${followUp}` : followUp;
}

/** #4097, #4125: one card refund, by where it stands - the shortfall's card part and a whole card refund alike (`INV-SSOT`). */
export function cardRefundClause(
  amount: string,
  state: CardRefundState,
  refundedOn: string | null,
): string {
  switch (state) {
    case "on-its-way":
      return cardRefundOnItsWay(amount);
    case "paid-another-way":
      return `${amount} could not go back to your card and was paid back to you another way`;
    case "stalled":
      return `${amount} is being refunded to you`;
    case "settled":
      return `${amount} was refunded to your card${refundedOn ? ` on ${refundedOn}` : ""}`;
  }
}

/** A failed/unknown attempt never proves money reached the card, or that an automatic retry exists. */
export function capacityCancellationRecovery(value: unknown, format: ClubFormat) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "CANCELLED" || typeof candidate.refunded !== "boolean") {
    return null;
  }

  let clause = withClubFollowUp("", ["your refund"]);
  let fullyRefunded = false;
  const facts = candidate.capacityRefund as
    | Partial<CapacityCancellationRefund>
    | null
    | undefined;
  if (facts && typeof facts === "object") {
    const { chargedAmountCents, plannedRefundCents } = facts;
    if (
      candidate.refunded &&
      typeof chargedAmountCents === "number" &&
      Number.isSafeInteger(chargedAmountCents) &&
      chargedAmountCents > 0 &&
      typeof plannedRefundCents === "number" &&
      Number.isSafeInteger(plannedRefundCents) &&
      plannedRefundCents > 0 &&
      plannedRefundCents <= chargedAmountCents
    ) {
      const remainingCents = chargedAmountCents - plannedRefundCents;
      clause = withClubFollowUp(
        cardRefundClause(formatCents(plannedRefundCents, format), "settled", null),
        remainingCents > 0 ? [`the remaining ${formatCents(remainingCents, format)}`] : [],
      );
      fullyRefunded = remainingCents === 0;
    }
  }

  return {
    heading: fullyRefunded
      ? "Booking cancelled - payment refunded"
      : "Booking cancelled - refund needs attention",
    message: `The booking was cancelled because lodge capacity was no longer available. ${clause.charAt(0).toUpperCase() + clause.slice(1)}. Reload the booking to see its current status. Do not try another payment.`,
  };
}
