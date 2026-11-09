import { MemberMoneyReservationRefused } from "./store";

/**
 * #4516 (M4c): whether a card refund sender's failure is a refused reservation, bare or as the cause of the
 * `PartialRefundError` the sender wraps every failure in (matched by name: the sender's module is outside the
 * boundary). A refusal is never retried: the next attempt meets the same caps, so the recovery runner stops the
 * row for the treasurer (`unretryableRecoveryCause`) and a webhook sender holds the capture instead of asking
 * Stripe to redeliver. Pure: a plain-Node command and every legacy reader can ask it.
 */
export function isCardRefundReservationRefusal(error: unknown): boolean {
  if (error instanceof MemberMoneyReservationRefused) return true;
  return error instanceof Error && error.name === "PartialRefundError" && error.cause instanceof MemberMoneyReservationRefused;
}
