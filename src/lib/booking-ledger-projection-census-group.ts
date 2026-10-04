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
import { groupSettlementRefundKey, groupSettlementShareKey } from "@/lib/booking-ledger-posting-keys";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import type { ReversibleChargeLine } from "@/lib/booking-ledger-charge-line";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import {
  needsPerChildCommittedRefund,
  organiserChildRefundEvidenceFromRows,
  planGroupChildLines,
} from "@/lib/booking-ledger-group-child-plan";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { deserializeRefundPlan, organiserChildCommittedRefundFrom } from "@/lib/group-settlement-refund-plan";
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
 * is the child's payment (the settle writes both from its price), under a
 * settlement that captured — SUCCEEDED, PARTIALLY_REFUNDED or REFUNDED
 * (`isCapturedPaymentStatus`); the refund is the frozen plan's share for the
 * child. Null when it does.
 */
export function groupSettlementSourceDrift(row: BookingLedgerCensusRow, line: CensusLedgerLine): string | null {
  const settlement = row.groupSettlement;
  const bookingId = row.booking.id;
  if (!settlement || settlement.id !== line.anchorId) return `no group settlement ${line.anchorId} paid this booking`;
  const card = settlement.source === "STRIPE";
  if (line.postingKey === groupSettlementShareKey(settlement.id, bookingId)) {
    if (line.kind !== (card ? "CARD_CAPTURE" : "BANK_RECEIPT")) return `a ${line.kind} share on a ${settlement.source} settlement`;
    // The share's evidence is that the settlement CAPTURED, not that it still
    // holds the money: an organiser cancel at 100% leaves it REFUNDED, and the
    // share it paid stands, its refunds posted beside it (#3854 K2).
    if (!isCapturedPaymentStatus(settlement.status)) return `settlement ${settlement.id} is ${settlement.status}, never captured`;
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

/** Planned postings as the census reads lines: ids and a posting instant of the plan's own. */
function plannedLines(postings: readonly BookingLedgerPosting[], postedAt: Date, idPrefix: string): Array<{ line: CensusLedgerLine; posting: BookingLedgerPosting }> {
  return postings.map((posting, index) => ({
    posting,
    line: {
      id: `${idPrefix}${index}`,
      side: posting.side,
      kind: posting.kind,
      sign: posting.sign,
      quantity: posting.quantity,
      unitCents: posting.unitCents,
      amountCents: ledgerLineAmountCents(posting),
      bookingGuestId: posting.bookingGuestId ?? null,
      nightStart: posting.nightStart ?? null,
      nightEndExclusive: posting.nightEndExclusive ?? null,
      anchorKind: posting.anchorKind,
      anchorId: posting.anchorId,
      settlementMethod: posting.settlementMethod ?? null,
      reversesLineId: posting.reversesLineId ?? null,
      postingKey: posting.postingKey,
      postedAt,
    },
  }));
}

/**
 * #3854 F1: the lines the back-post would post on a group-settled child that
 * holds none, planned in memory from the census's one snapshot through the
 * planners the back-post posts by — the confirmation
 * (`planConfirmationChargeLines`), the share and plan refund
 * (`planGroupChildLines`, the back-post's own group planner), and the
 * cancellation with the kept figure the back-post would use
 * (`planCancellationChargeLines`). Null wherever the back-post would refuse or
 * post something these do not plan — an unpriced or unreconciled confirmation,
 * shares that do not add up, a child no settlement paid, a change fee, an
 * unreadable snapshot — or would post nothing: the census then holds the child.
 * Writes nothing.
 */
export function plannedGroupChildLines(row: BookingLedgerCensusRow): CensusLedgerLine[] | null {
  const { booking, payment, groupSettlement: settlement, groupChild: evidence } = row;
  if (!evidence || !settlement || !payment) return null;
  // An edit's change fee would post a line of its own; the history is not one this plans.
  if (row.modifications.some((modification) => modification.changeFeeCents > 0)) return null;
  const confirmation = planConfirmationChargeLines(evidence.pricing);
  if (confirmation.unpricedStrandIds.length > 0 || !confirmation.reconciles) return null;
  const child = { id: booking.id, lodgeId: evidence.pricing.lodgeId, status: booking.status, cancelledWithoutSnapshot: evidence.cancelledWithoutSnapshot };
  const group = planGroupChildLines({
    child,
    payment,
    settlement,
    siblings: evidence.siblings,
    perChildCommittedRefundCents:
      needsPerChildCommittedRefund(child, settlement) && settlement.stripePaymentIntentId
        ? organiserChildCommittedRefundFrom(
            payment.refundedAmountCents,
            organiserChildRefundEvidenceFromRows({
              paymentId: payment.id,
              paymentIntentId: settlement.stripePaymentIntentId,
              refunds: row.refunds,
              operations: row.recoveryOperations,
            }),
          )
        : null,
  });
  if (group === null || group.kind === "refuse") return null;
  // Posted after every edit the booking holds, as the back-post posts now.
  const postedAt = new Date(Math.max(0, ...row.modifications.map((modification) => modification.createdAt.getTime())) + 1);
  const lines = plannedLines([...confirmation.postings, ...group.postings], postedAt, "planned-");
  if (booking.status === "CANCELLED") {
    const kept = group.cancellationKeptCents !== null ? { keptCents: group.cancellationKeptCents } : evidence.snapshotKept;
    if (kept === null) return null;
    const chargeLines: ReversibleChargeLine[] = lines.flatMap(({ line: { id }, posting }) =>
      posting.kind === "GUEST_NIGHT" || posting.kind === "PROMOTION" || posting.kind === "CHANGE_FEE"
        ? [
            {
              id,
              kind: posting.kind,
              sign: posting.sign,
              quantity: posting.quantity,
              unitCents: posting.unitCents,
              bookingGuestId: posting.bookingGuestId ?? null,
              nightStart: posting.nightStart ?? null,
              nightEndExclusive: posting.nightEndExclusive ?? null,
              rateMembershipTypeId: posting.rateMembershipTypeId ?? null,
              ageTier: posting.ageTier ?? null,
              guestNames: [...(posting.guestNames ?? [])],
              narration: posting.narration,
              reversesLineId: posting.reversesLineId ?? null,
            },
          ]
        : [],
    );
    const cancellation = planCancellationChargeLines({ bookingId: booking.id, lodgeId: child.lodgeId, ...kept, chargeLines, adjustmentLines: [] });
    if (cancellation.kind === "none") return null;
    lines.push(...plannedLines(cancellation.postings, postedAt, "planned-cancel-"));
  }
  return lines.length === 0 ? null : lines.map(({ line }) => line);
}
