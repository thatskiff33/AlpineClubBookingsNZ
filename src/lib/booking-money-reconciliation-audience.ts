import type {
  BookingMoneyReconciliation,
  BookingMoneyReconciliationReason,
} from "@/lib/booking-money-reconciliation";

/**
 * WHO MAY READ A BOOKING'S MONEY VERDICT, WHAT ITS ABSENCE MEANS, AND WHAT IT
 * IS CALLED — one home for all three (#3278, `INV-SSOT-001`).
 *
 * ## The audience
 *
 * OFFICER-ONLY (owner decision, 20 September 2026). A member sees their
 * amounts exactly as they did before this feature existed, with no review
 * mark on them. The reason is not squeamishness: three of the surfaces that
 * print a booking amount print ANOTHER MEMBER'S — the organiser group card
 * renders a row per joiner, each joiner being a different member's booking,
 * and the bookings list selects bookings the viewer is merely a guest on and
 * prints the owner's figure. An integrity verdict about one member's money is
 * not another member's to read, and "is this stored total provable" is an
 * officer's question in any case.
 *
 * The gate is applied HERE, at the data boundary, and never in JSX: three of
 * the four readers are client components, so a verdict a component declines to
 * render has still been serialised into that browser's payload. Withholding it
 * from the projection is the only version of this that is true.
 *
 * ## The absence
 *
 * `WITHHELD` is a state with a name, and there is no `null`. Before this
 * module there were four readers and four meanings for "no verdict": required
 * and non-nullable in two, nullable and read through `?.` in the organiser
 * card — where a null rendered as nothing, indistinguishable from a booking
 * that reconciles — and, on the officer history panel, "withheld from you".
 * Those last two collide: with a gate in place, the `?.` shape would silently
 * downgrade every joiner to unmarked rather than fail visibly, which is
 * fail-open. A required, non-nullable field of a two-armed union makes the
 * collision unrepresentable rather than policed, which is what `INV-SSOT`
 * asks for.
 *
 * ## The wording
 *
 * One object. The same sentence used to be a verbatim literal in three
 * components plus a chip variant, with three further spellings elsewhere in
 * the tree. Changing what this feature calls itself must be one edit.
 */
export type BookingMoneyReconciliationView =
  | { visibility: "VISIBLE"; reconciliation: BookingMoneyReconciliation }
  | { visibility: "WITHHELD" };

/**
 * The one withheld value. Readers never construct a view — they receive one
 * from the gate below — but tests and the census script need to name it.
 */
export const BOOKING_MONEY_RECONCILIATION_WITHHELD: BookingMoneyReconciliationView =
  { visibility: "WITHHELD" };

/**
 * THE GATE. Every projection that carries a verdict towards a rendered surface
 * goes through this, with the viewer it already holds.
 *
 * `canSeeAdminTools` is the booking area's own officer predicate — a Full
 * Admin or a `bookings:edit` holder — and is deliberately the SAME predicate
 * the booking-detail history loader uses for the rest of a booking's private
 * integrity evidence, rather than a second answer to the same question. It is
 * named rather than positional so a boolean meaning something else cannot be
 * passed by accident.
 */
export function bookingMoneyReconciliationForViewer(
  reconciliation: BookingMoneyReconciliation,
  viewer: { canSeeAdminTools: boolean },
): BookingMoneyReconciliationView {
  return viewer.canSeeAdminTools
    ? { visibility: "VISIBLE", reconciliation }
    : BOOKING_MONEY_RECONCILIATION_WITHHELD;
}

/**
 * "Does this viewer have a review mark to render for this booking" — the one
 * spelling of the gate-and-state test the marking surfaces share. A reader
 * asking `view.reconciliation.state` itself would be re-deciding the audience
 * question on its own.
 */
export function bookingMoneyNeedsOfficerReview(
  view: BookingMoneyReconciliationView,
): view is {
  visibility: "VISIBLE";
  reconciliation: Extract<BookingMoneyReconciliation, { state: "UNRECONCILED" }>;
} {
  return (
    view.visibility === "VISIBLE" && view.reconciliation.state === "UNRECONCILED"
  );
}

/**
 * The qualifier that follows a rendered amount inline, or the empty string.
 *
 * Gate, separator and wording in one call, because the three inline surfaces
 * that use it had one copy of each. `·` is the middot the surrounding
 * rows already separate with.
 */
export function bookingMoneyReviewSuffix(
  view: BookingMoneyReconciliationView,
): string {
  return bookingMoneyNeedsOfficerReview(view)
    ? ` · ${BOOKING_MONEY_RECONCILIATION_COPY.amountQualifier}`
    : "";
}

/** Everything this feature calls itself, in one place. */
export const BOOKING_MONEY_RECONCILIATION_COPY = {
  /** Heading or panel title for the feature itself. */
  featureName: "Booking money reconciliation",
  /** The short chip, where it sits in a row of other chips. */
  chipLabel: "Money review",
  /** Follows an amount inline — see `bookingMoneyReviewSuffix`. */
  amountQualifier: "recorded amount needs review",
  /** The banner above the booking. */
  noticeTitle: "Recorded booking money needs officer review",
  noticeBody:
    "Do not treat the stored total as reconciled until an officer has checked the recorded parts. No amount has been changed automatically.",
  /** The transaction-history panel, where both states are shown. */
  currentStateLabel: "Current money reconciliation",
  reconciledDetail:
    "The stored booking headline reconciles with its recorded build-up.",
  derivedStateNote:
    "This is the current derived state, not a historical transaction.",
  stateLabel: {
    RECONCILED: "Reconciled",
    UNRECONCILED: "Unreconciled",
  },
} as const satisfies Record<string, string | Record<string, string>>;

/**
 * One plain-English sentence per reason, for every surface that explains a
 * verdict rather than merely marking one. The raw reason tokens stay the
 * stored/exported vocabulary; nothing renders them to a person.
 */
export const BOOKING_MONEY_RECONCILIATION_REASON_TEXT: Record<
  BookingMoneyReconciliationReason,
  string
> = {
  NO_SURVIVING_STRANDS: "no surviving guest price strands are recorded",
  STRAND_EVIDENCE_UNREADABLE:
    "at least one guest strand has incomplete or inexact stored price evidence",
  HEADLINE_TOTAL_MISMATCH:
    "the stored booking total differs from the recorded guest totals",
  PROMO_BUILD_UP_NOT_KNOWN:
    "the recorded promotion build-up is missing or not knowable",
  PROMO_BUILD_UP_MISMATCH:
    "the stored promotion adjustment differs from its recorded build-up",
  DISCOUNT_COMPONENT_MISMATCH:
    "the legacy discount component differs from the signed promotion adjustment",
  FINAL_PRICE_RELATION_MISMATCH:
    "the stored final price differs from the booking total plus its promotion adjustment",
};

/** The reasons as one readable sentence fragment, for a tooltip or a line. */
export function bookingMoneyReviewReasonText(
  reasons: readonly BookingMoneyReconciliationReason[],
): string {
  return reasons
    .map((reason) => BOOKING_MONEY_RECONCILIATION_REASON_TEXT[reason])
    .join("; ");
}
