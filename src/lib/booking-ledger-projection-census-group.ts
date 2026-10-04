/**
 * WHAT THE BOOKING-LEDGER CENSUS KNOWS OF A GROUP ORGANISER'S SETTLEMENT
 * (#3854, on #3583's census, `INV-MONEY-037`; design
 * `docs/design/booking-ledger.md` §5.2, §6).
 *
 * A child its organiser settled holds lines anchored `GROUP_SETTLEMENT`: its
 * share (`groupSettlementShareKey`) and, under a frozen mirror plan, its
 * refund (`groupSettlementRefundKey`). These are the predicates the census
 * judges them by, from the child's snapshot row. Pure: it reads nothing.
 */
import { organiserHasPaidSettlement } from "@/lib/group-organiser-paid";
import { groupSettlementRefundKey, groupSettlementShareKey } from "@/lib/booking-ledger-posting-keys";
import { deserializeRefundPlan } from "@/lib/group-settlement-refund-plan";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";

/** The share and refund keys' namespace, for the census's key-to-anchor table. */
export const GROUP_SETTLEMENT_KEY_EXAMPLES = [groupSettlementShareKey("s", "b"), groupSettlementRefundKey("s", "b")] as const;

/** What the settlement's frozen `{childId: cents}` mirror plan hands back on this child. */
function plannedMirrorRefundCents(row: BookingLedgerCensusRow): number {
  const settlement = row.groupSettlement;
  return settlement ? (deserializeRefundPlan(settlement.refundPlan).get(row.booking.id) ?? 0) : 0;
}

/**
 * Does the settlement still say what a `GROUP_SETTLEMENT` line says? The share
 * is the child's payment (the settle writes both from its price); the refund is
 * the frozen plan's share for the child. Null when it does.
 */
export function groupSettlementSourceDrift(row: BookingLedgerCensusRow, line: CensusLedgerLine): string | null {
  const settlement = row.groupSettlement;
  const bookingId = row.booking.id;
  if (!settlement || settlement.id !== line.anchorId) return `no group settlement ${line.anchorId} paid this booking`;
  const card = settlement.source === "STRIPE";
  if (line.postingKey === groupSettlementShareKey(settlement.id, bookingId)) {
    if (line.kind !== (card ? "CARD_CAPTURE" : "BANK_RECEIPT")) return `a ${line.kind} share on a ${settlement.source} settlement`;
    if (!organiserHasPaidSettlement(settlement)) return `settlement ${settlement.id} is ${settlement.status}, not paid`;
    const paid = row.payment?.amountCents ?? 0;
    return line.amountCents === paid ? null : `the child's payment holds ${paid}, the share line ${line.amountCents}`;
  }
  if (line.postingKey === groupSettlementRefundKey(settlement.id, bookingId)) {
    if (line.kind !== (card ? "CARD_REFUND" : "BANK_REFUND")) return `a ${line.kind} refund on a ${settlement.source} settlement`;
    const planned = plannedMirrorRefundCents(row);
    return line.amountCents === -planned ? null : `the settlement's plan refunds ${planned}, the line ${line.amountCents}`;
  }
  return `a line under group settlement ${settlement.id} keyed ${line.postingKey ?? "(none)"}`;
}

/**
 * The refunds an Internet Banking settlement's mirror plan posted as
 * `BANK_REFUND`, positive: the same transaction raised `refundedAmountCents`
 * by them, so the REFUNDED identity counts them beside `CARD_REFUND`.
 */
export function groupSettlementBankRefundCents(lines: readonly CensusLedgerLine[]): number {
  return -lines
    .filter((line) => line.kind === "BANK_REFUND" && line.anchorKind === "GROUP_SETTLEMENT")
    .reduce((sum, line) => sum + line.amountCents, 0);
}

/**
 * A pre-#3653 card plan's refund still in flight: the group has ONE recovery
 * operation for the whole plan, anchored on the organiser's or the first
 * child's payment, so each child's share of it is sized from the plan — and
 * only while the child's own refund line has not posted (`IN_FLIGHT_REFUND`).
 */
export function inFlightGroupPlanRefundCents(row: BookingLedgerCensusRow): number {
  const settlement = row.groupSettlement;
  if (!settlement?.refundRecoveryInFlight) return 0;
  const key = groupSettlementRefundKey(settlement.id, row.booking.id);
  if (row.lines.some((line) => line.postingKey === key)) return 0;
  return plannedMirrorRefundCents(row);
}
