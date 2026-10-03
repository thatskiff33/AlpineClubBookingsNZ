/**
 * "The organiser has paid" for an organiser-pays group — defined ONCE
 * (#3672, `INV-PAY-109`, `INV-SSOT`), for the server rule and the organiser's
 * card alike.
 *
 * Paid is a settlement that took the organiser's money and did not hand all of
 * it back: SUCCEEDED or PARTIALLY_REFUNDED (orchestrator decision 2 on #3672).
 * REFUNDED is unpaid: on a live group it is a capture refunded before it
 * settled anyone, so the organiser still owes. PARTIALLY_REFUNDED is written by
 * the organiser cancel and, since #3653, by a joiner's reduction refunded out of
 * the combined payment - a live group that is still paid for, which is why it
 * counts as paid here.
 *
 * Client-safe: plain strings, checked against the Prisma enum by type only.
 *
 * NOT the settle paths' replay guard. `group-settlement.ts` asks "did THIS
 * settlement's apply already run?", which is SUCCEEDED alone, and a
 * refund-history settlement is re-minted rather than treated as paid there.
 */
import type { PaymentStatus } from "@prisma/client";

export const ORGANISER_PAID_SETTLEMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
] as const satisfies readonly PaymentStatus[];

export function organiserHasPaidSettlement(
  settlement: { status: string } | null | undefined
): boolean {
  return (
    settlement != null &&
    (ORGANISER_PAID_SETTLEMENT_STATUSES as readonly string[]).includes(settlement.status)
  );
}
