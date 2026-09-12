/**
 * Shared, PURE contract for the #3340 superseded-payment auto-refund
 * `BookingEvent`.
 *
 * A booking edit replaces the charge the previous edit raised. If the member
 * confirms the OLD intent inside the window before it is cancelled, the recovery
 * queue refunds that capture. Until #3340 nothing recorded it: no audit row, no
 * booking event, no member mail and no admin alert, so Stripe's own receipt was
 * the only notice anybody got - a member wrote in asking what had happened, and
 * that is the only reason the defect was found at all.
 *
 * It is recorded as a REFUNDED event carrying the discriminator below, exactly
 * as #2008 records the duplicate-capture auto-refund, and for the same reason:
 * `buildCancelledPostPaymentNarrative` pattern-matches the first REFUNDED event
 * as a LATER cancellation's settlement clause, and this refund is nothing of the
 * kind - it returns a payment that was taken against a charge the club had
 * already replaced. Every consumer that pattern-matches REFUNDED events MUST
 * exclude it via `isSupersededAdditionalRefundEvent`.
 *
 * Free of the database client and the logger so the pure narrative resolver can
 * import the predicate without pulling `@/lib/prisma` into its bundle.
 */
import { BookingEventType } from "@prisma/client";

import { formatCents } from "@/lib/utils";

/** Snapshot discriminator marking a REFUNDED event as a #3340 supersede refund. */
export const SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND =
  "superseded_payment_refund" as const;

/**
 * Honest, member-neutral copy stored on the event's `reason`. Rendered on the
 * booking-history timeline; never enters the cancellation narrative.
 */
export const SUPERSEDED_ADDITIONAL_REFUND_EVENT_REASON =
  "A payment taken against a charge a later booking change had already replaced was refunded in full.";

/**
 * WHAT IS STILL OWING AFTER THE REFUND, AS ONE SENTENCE — because zero is a real
 * and reassuring answer, not an empty row (#3340).
 *
 * It lives HERE, with the event's own copy, rather than inside the coded email
 * template, because it is sent to the editor as a composed `{{owingSentence}}`
 * token as well as rendered (#3340 fix round). The editable default a club can
 * rewrite used to read "Still owing on this booking: {{amountOwing}}"
 * unconditionally, so a club that touched the editor sent "Still owing on this
 * booking: $0.00" on what is meant to be a reassurance email - the coded
 * template and the editor's copy disagreeing about one fact, which is the shape
 * `INV-SSOT-001` exists to prevent. One function, both surfaces.
 */
export function supersededRefundOwingSentence(amountOwingCents: number): string {
  return amountOwingCents > 0
    ? `There is still ${formatCents(amountOwingCents)} to pay on this booking. You can pay it from your booking page.`
    : "Nothing further is owing on this booking.";
}

/** Frozen facts stored on the supersede-refund BookingEvent snapshot. */
export interface SupersededAdditionalRefundEventSnapshot {
  kind: typeof SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND;
  /** The superseded PaymentIntent that was captured and then refunded. */
  supersededPaymentIntentId: string;
  /** Amount refunded, integer cents (mirrors the event's `amountCents`). */
  refundedAmountCents: number;
  /**
   * What the booking still owed once the refund had been reconciled, in cents.
   * Frozen here because it is the figure the member was told, and a later edit
   * must not make the club's own record of that sentence untrue.
   */
  amountOwingAfterRefundCents: number;
}

/**
 * Narrow an arbitrary event snapshot to a supersede-refund snapshot, or null
 * when it is not one.
 */
export function asSupersededAdditionalRefundSnapshot(
  value: unknown,
): SupersededAdditionalRefundEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind ===
      SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND
  ) {
    return value as SupersededAdditionalRefundEventSnapshot;
  }
  return null;
}

/**
 * True when a durable event is the #3340 supersede auto-refund: a REFUNDED event
 * carrying the discriminator snapshot. The booking narrative excludes these so
 * the auto-refund is never misread as a cancellation's settlement.
 */
export function isSupersededAdditionalRefundEvent(event: {
  type: BookingEventType;
  snapshot: unknown;
}): boolean {
  return (
    event.type === BookingEventType.REFUNDED &&
    asSupersededAdditionalRefundSnapshot(event.snapshot) !== null
  );
}
