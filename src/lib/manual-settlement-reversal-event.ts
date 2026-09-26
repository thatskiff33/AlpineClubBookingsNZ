/**
 * Shared, PURE contract for the B5 (#2262) manual mark-paid REVERSAL
 * BookingEvent.
 *
 * Reversing a manual cash settlement is not a cancellation — the booking is
 * still live, it is simply back to being unpaid — but BookingEventType has no
 * neutral member for "the settlement was un-recorded", and a durable,
 * never-pruned history entry is mandatory for a money-state change.
 *
 * So the reversal is recorded as a CANCELLED BookingEvent carrying this
 * discriminator in its `snapshot`, exactly as #2008 did for the duplicate-capture
 * auto-refund, and every consumer that pattern-matches CANCELLED events (today:
 * the shared member/admin narrative, which reads the FIRST CANCELLED event as
 * "when this booking was cancelled") MUST exclude it via
 * `isManualSettlementMarkerEvent`. Without that exclusion a booking that is
 * reversed and LATER genuinely cancelled would show the member the reversal's
 * date as its cancellation date.
 *
 * This module is intentionally free of the database client and logger so the
 * pure narrative resolver can import the predicate without pulling
 * `@/lib/prisma` into its bundle. It depends only on the `@prisma/client` enum,
 * which the narrative already imports.
 */
import { BookingEventType } from "@prisma/client";

/** Snapshot discriminator marking a CANCELLED event as a #2262 manual reversal. */
export const MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND =
  "manual_mark_paid_reversed" as const;

/**
 * Honest, member-neutral copy stored on the event's `reason`. There is no
 * admin timeline that renders BookingEvent reasons today — the reversal's
 * operator-visible trail is its `AuditLog` entry
 * (`booking-payment.manual-payment.mark-unpaid`) — so this string exists as
 * durable, self-describing history on the event row itself. It never enters
 * the member/guest narrative (see `isManualSettlementMarkerEvent`).
 */
export const MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON =
  "Manually recorded payment reversed — the booking is unpaid again and was not cancelled.";

/** Frozen facts stored on the reversal BookingEvent snapshot. */
export interface ManualSettlementReversalEventSnapshot {
  kind: typeof MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND;
  /** The booking status stored at settle time, before the DRAFT coercion. */
  storedPreviousStatus: string;
  /** The status the booking was actually restored to. */
  restoredStatus: string;
  /**
   * Recovery operations this reversal DELETED (HIGH #1). The rows are gone by
   * design — their full content is preserved on the reversal's AuditLog entry.
   */
  closedRecoveryOperationIds: string[];
  /** Whether a restored CONFIRMED internet-banking hold deadline was cleared. */
  clearedInternetBankingHold: boolean;
  /** The acting admin's free-text note, when one was given. */
  note: string | null;
}

/**
 * Narrow an arbitrary event snapshot to a manual-reversal snapshot, or null
 * when it is not one.
 */
export function asManualSettlementReversalSnapshot(
  value: unknown
): ManualSettlementReversalEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind ===
      MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND
  ) {
    return value as ManualSettlementReversalEventSnapshot;
  }
  return null;
}

/**
 * Snapshot discriminator marking a CANCELLED event as the #2262 reciprocal
 * fence firing: an inbound Xero PAID landed on a manually settled booking and
 * the pipeline deliberately wrote nothing. Same reasoning as the reversal — a
 * durable, never-pruned admin marker with no neutral event type to carry it.
 */
export const MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND =
  "manual_settlement_xero_conflict" as const;

export const MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON =
  "Xero reported this booking's invoice paid after a cash settlement was recorded — reconcile by hand. The booking was not cancelled.";

export interface ManualSettlementConflictEventSnapshot {
  kind: typeof MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND;
  invoiceId: string | null;
  invoiceNumber: string | null;
  bookingStatus: string;
}

export function asManualSettlementConflictSnapshot(
  value: unknown
): ManualSettlementConflictEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND
  ) {
    return value as ManualSettlementConflictEventSnapshot;
  }
  return null;
}

/**
 * #3638: the same marker shape for a SECOND INSTRUMENT. Xero reports cash on
 * the Internet Banking invoice of a booking a card payment had already
 * settled (the switch-to-Internet-Banking race, or any other path that leaves
 * both open). The inbound path records the bank receipt it was told about and
 * moves no money; this event is the durable admin-only record that the club may
 * now hold the price twice.
 */
export const SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND =
  "second_instrument_xero_conflict" as const;

export const SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON =
  "Xero reported this booking's invoice paid after a card payment had already settled it — the club may hold the price twice; reconcile by hand. The booking was not cancelled.";

export interface SecondInstrumentSettlementConflictEventSnapshot {
  kind: typeof SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND;
  invoiceId: string | null;
  invoiceNumber: string | null;
  bookingStatus: string;
  /** The PaymentSource of the captured PRIMARY row that settled first. */
  settledBySource: string;
  /** Its Stripe PaymentIntent, when it has one. */
  settledByPaymentIntentId: string | null;
}

export function asSecondInstrumentSettlementConflictSnapshot(
  value: unknown
): SecondInstrumentSettlementConflictEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind ===
      SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND
  ) {
    return value as SecondInstrumentSettlementConflictEventSnapshot;
  }
  return null;
}

/**
 * The constant `reason` of every admin-only settlement marker above. The
 * DB-level twin of `isManualSettlementMarkerEvent` for relation filters that
 * cannot read the snapshot discriminator (the stuck-state crash detector), so
 * adding a marker here is the one edit both exclusions need.
 */
export const SETTLEMENT_MARKER_EVENT_REASONS = [
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
] as const;

/**
 * True when a durable CANCELLED event is one of the admin-only settlement
 * markers: the two #2262 markers (a manual mark-paid reversal, or the
 * reciprocal-fence conflict) or #3638's second-instrument conflict. NONE
 * cancels the booking, so every consumer that pattern-matches CANCELLED events
 * must exclude them.
 */
export function isManualSettlementMarkerEvent(event: {
  type: BookingEventType;
  snapshot: unknown;
}): boolean {
  return (
    event.type === BookingEventType.CANCELLED &&
    (asManualSettlementReversalSnapshot(event.snapshot) !== null ||
      asManualSettlementConflictSnapshot(event.snapshot) !== null ||
      asSecondInstrumentSettlementConflictSnapshot(event.snapshot) !== null)
  );
}
