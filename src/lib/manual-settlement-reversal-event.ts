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
 * Honest, member-neutral copy stored on the event's `reason`. The staff
 * booking timeline renders it (#3638, through `SETTLEMENT_MARKERS`), beside
 * the reversal's `AuditLog` entry
 * (`booking-payment.manual-payment.mark-unpaid`); it never enters the
 * member/guest narrative (see `isManualSettlementMarkerEvent`).
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
 * THE ONE LIST of admin-only settlement markers (#3638, `INV-SSOT`). Each is a
 * CANCELLED BookingEvent that cancels nothing, so every consumer that
 * pattern-matches CANCELLED events must exclude all of them, and the staff
 * timeline shows them. Every exclusion and the timeline derive from this list:
 * the snapshot `kind` is what `isManualSettlementMarkerEvent` tests, the
 * `reason` is what relation filters that cannot read the snapshot test (the
 * stuck-state crash detector), and the `adminTitle`/`tone` are what the staff
 * timeline renders. Adding a marker is one entry here.
 *
 * A `reason` is matched against stored rows, so rewording one silently stops
 * the DB-level exclusion matching every row written before the change: add
 * the old string as a second entry rather than editing it in place.
 */
export const SETTLEMENT_MARKERS = [
  {
    kind: MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
    reason: MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
    adminTitle: "Manual payment reversed",
    tone: "warning",
  },
  {
    kind: MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND,
    reason: MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
    adminTitle: "Xero payment on a cash-settled booking",
    tone: "danger",
  },
  {
    kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
    reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
    adminTitle: "May have been paid twice (card and Xero)",
    tone: "danger",
  },
] as const satisfies readonly {
  kind: string;
  reason: string;
  adminTitle: string;
  tone: "warning" | "danger";
}[];

export type SettlementMarker = (typeof SETTLEMENT_MARKERS)[number];

/** Every marker's constant `reason`, for DB relation filters. */
export const SETTLEMENT_MARKER_EVENT_REASONS: readonly string[] =
  SETTLEMENT_MARKERS.map((marker) => marker.reason);

const SETTLEMENT_MARKERS_BY_KIND = new Map<string, SettlementMarker>(
  SETTLEMENT_MARKERS.map((marker) => [marker.kind, marker]),
);

/**
 * The registry entry a durable event is, or null when it is not a settlement
 * marker. The three `as*Snapshot` narrowers above are typed views of one
 * marker's snapshot; membership is decided here.
 */
export function settlementMarkerOf(event: {
  type: BookingEventType;
  snapshot: unknown;
}): SettlementMarker | null {
  if (event.type !== BookingEventType.CANCELLED) return null;
  const kind =
    event.snapshot && typeof event.snapshot === "object"
      ? (event.snapshot as { kind?: unknown }).kind
      : undefined;
  return typeof kind === "string"
    ? (SETTLEMENT_MARKERS_BY_KIND.get(kind) ?? null)
    : null;
}

/**
 * A settlement marker as the STAFF booking timeline shows it (#3638). Pure, so
 * the page's data loader can map its events without a query of its own.
 */
export interface SettlementMarkerTimelineEntry {
  id: string;
  occurredAt: Date;
  amountCents: number | null;
  title: string;
  detail: string;
  tone: SettlementMarker["tone"];
}

/**
 * Every settlement marker among a booking's events, for the staff timeline.
 * The detail is the reason stored on the event row (self-describing history),
 * with the Xero invoice number when the marker carries one. Callers gate this
 * on staff access: the markers name money the member may not have been told
 * about yet.
 */
export function settlementMarkerTimelineEntries(
  events: readonly {
    id: string;
    type: BookingEventType;
    occurredAt: Date;
    amountCents: number | null;
    reason: string | null;
    snapshot: unknown;
  }[],
): SettlementMarkerTimelineEntry[] {
  return events.flatMap((event) => {
    const marker = settlementMarkerOf(event);
    if (!marker) return [];
    const invoiceNumber = (event.snapshot as { invoiceNumber?: unknown })
      .invoiceNumber;
    const invoiceClause =
      typeof invoiceNumber === "string" && invoiceNumber
        ? ` Xero invoice ${invoiceNumber}.`
        : "";
    return [
      {
        id: event.id,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        title: marker.adminTitle,
        detail: (event.reason ?? marker.reason) + invoiceClause,
        tone: marker.tone,
      },
    ];
  });
}

/**
 * True when a durable CANCELLED event is one of the admin-only settlement
 * markers in `SETTLEMENT_MARKERS`. NONE cancels the booking, so every consumer
 * that pattern-matches CANCELLED events must exclude them.
 */
export function isManualSettlementMarkerEvent(event: {
  type: BookingEventType;
  snapshot: unknown;
}): boolean {
  return settlementMarkerOf(event) !== null;
}
