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
 * The gate is applied HERE, at the data boundary, and never in JSX. Two of the
 * readers — the bookings list and the organiser group card — are `"use client"`
 * components, so a verdict one of them declines to render has still been
 * serialised into that browser's payload, reasons and all; the rest render it
 * into the HTML the same page returns. Withholding it from the projection is
 * the only version of this that is true for both.
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
    ? ` · ${bookingMoneyUnreconciledCopy(view.reconciliation.reasons).amountQualifier}`
    : "";
}

/**
 * WHICH OF TWO SITUATIONS AN UNRECONCILED VERDICT DESCRIBES (#3278).
 *
 * `UNRECONCILED` was one label over two things that call for opposite
 * responses, and an officer was being asked to tell them apart unaided:
 *
 * - **A DISAGREEMENT.** Every part is recorded and the numbers do not add up.
 *   An officer can read the parts, find the discrepancy and fix or explain it.
 *   This is the finding the feature exists to surface.
 * - **EVIDENCE_ABSENT.** The records needed to check were never kept, so the
 *   question cannot be answered by looking — today or ever. It is a property
 *   of the era the booking comes from, not a task.
 *
 * Both stay `UNRECONCILED`: unknown evidence is never turned into a pass
 * (#2797), nothing is suppressed, and no population is hidden by status. What
 * changes is only what the screen ASKS OF THE READER. Telling an officer to
 * review a booking whose records were never kept is a to-do they cannot close,
 * on a population that only grows as bookings age — and an officer who meets a
 * dozen of those learns to skim the banner, which is how the one that matters
 * gets missed. The owner named that risk on 20 September 2026; this is the
 * answer to it, chosen over suppressing historical bookings by status, which
 * would have turned unknown evidence into a pass.
 *
 * MIXED SETS RESOLVE TO `DISAGREEMENT`, deliberately. A booking can carry both
 * kinds at once, and the actionable one must not be muted by an unactionable
 * sibling. So this reads "is there anything here an officer could act on?",
 * and only a verdict whose every reason is evidence-absent gets the quieter
 * wording.
 */
export type BookingMoneyUnreconciledKind = "DISAGREEMENT" | "EVIDENCE_ABSENT";

/**
 * The reasons that mean the records were never kept, rather than that the
 * recorded numbers disagree. Exhaustive by construction: the kind function
 * below treats every reason NOT named here as a disagreement, so a reason
 * added later is actionable until somebody deliberately says otherwise — which
 * is the fail-loud direction.
 */
const BOOKING_MONEY_EVIDENCE_ABSENT_REASONS: ReadonlySet<BookingMoneyReconciliationReason> =
  new Set<BookingMoneyReconciliationReason>([
    "NO_SURVIVING_STRANDS",
    "STRAND_EVIDENCE_UNREADABLE",
    "PROMO_BUILD_UP_NOT_KNOWN",
    // `STRAND_TOTAL_DISAGREES` is deliberately NOT here (#3547). It used to
    // arrive inside `STRAND_EVIDENCE_UNREADABLE` and so inherited the quiet
    // wording, but two numbers that are both on file and do not agree is
    // something an officer can go and resolve. Its absence from this set is
    // what makes it a disagreement, so it is written down rather than left to
    // be inferred from a gap.
  ]);

/** Which kind a set of reasons describes. See the type's docblock for the rule. */
export function bookingMoneyUnreconciledKind(
  reasons: readonly BookingMoneyReconciliationReason[],
): BookingMoneyUnreconciledKind {
  return reasons.every((reason) => BOOKING_MONEY_EVIDENCE_ABSENT_REASONS.has(reason))
    ? "EVIDENCE_ABSENT"
    : "DISAGREEMENT";
}

/**
 * The wording for a verdict, picked by kind. One call so no surface decides
 * the question locally — which is how the single spelling was lost last time.
 */
export function bookingMoneyUnreconciledCopy(
  reasons: readonly BookingMoneyReconciliationReason[],
) {
  return bookingMoneyUnreconciledKind(reasons) === "EVIDENCE_ABSENT"
    ? BOOKING_MONEY_RECONCILIATION_COPY.evidenceAbsent
    : BOOKING_MONEY_RECONCILIATION_COPY.disagreement;
}

/** Everything this feature calls itself, in one place. */
export const BOOKING_MONEY_RECONCILIATION_COPY = {
  /** Heading or panel title for the feature itself. */
  featureName: "Booking money reconciliation",
  /**
   * The two kinds, worded for what each asks of the reader. A disagreement is
   * a task; absent evidence is a statement of fact with nothing to action, and
   * saying so is the whole point of the split.
   */
  disagreement: {
    /** The short chip, where it sits in a row of other chips. */
    chipLabel: "Money review",
    /** Follows an amount inline — see `bookingMoneyReviewSuffix`. */
    amountQualifier: "recorded amount needs review",
    /** The banner above the booking. */
    noticeTitle: "Recorded booking money needs officer review",
    noticeBody:
      "Do not treat the stored total as reconciled until an officer has checked the recorded parts. No amount has been changed automatically.",
  },
  evidenceAbsent: {
    chipLabel: "Not checkable",
    amountQualifier: "recorded amount cannot be checked",
    noticeTitle: "This booking's money cannot be checked",
    noticeBody:
      "The records needed to check the stored total were not kept when this booking was made. There is nothing to action here: no amount has been changed, and reviewing the booking cannot resolve it.",
  },
  /** The transaction-history panel, where both states are shown. */
  currentStateLabel: "Current money reconciliation",
  reconciledDetail:
    "The stored booking headline reconciles with its recorded build-up.",
  derivedStateNote:
    "This is the current derived state, not a historical transaction.",
  stateLabel: {
    RECONCILED: "Reconciled",
    UNRECONCILED: "Unreconciled",
    /** Still unreconciled — this names WHY, where there is room to. */
    UNRECONCILED_EVIDENCE_ABSENT: "Unreconciled — records not kept",
  },
} as const satisfies Record<string, string | Record<string, string>>;

/**
 * WHY a booking cannot be checked, one sentence per reason.
 *
 * The other reason text below says WHAT is wrong, in the vocabulary of the
 * records. That is right for a discrepancy, where the officer is going to go
 * and look. It is not enough here: if the screen tells somebody a booking
 * cannot be checked and does not say why, the only thing they can do is wonder
 * whether it is their problem. These sentences name the cause and are written
 * so the answer to "can I do something about this?" is plainly no.
 *
 * Each one states the condition the code actually tests, not a guess at
 * history. `NO_SURVIVING_STRANDS` is `guests.length === 0`;
 * `STRAND_EVIDENCE_UNREADABLE` is a guest with no usable stored night rows at
 * all. Reconciliation reads evidence at WHOLE_GUEST grain, where an even-share
 * row that sums correctly is EXACT — so of the three causes the underlying
 * reader can return, only two ever reach here, and #3547 moved one of those
 * (rows that do not sum to that guest's own recorded total) to
 * `STRAND_TOTAL_DISAGREES` because it is actionable. The wording below says
 * only what can actually arrive;
 * `PROMO_BUILD_UP_NOT_KNOWN` is a promotion whose per-night rows carry a null
 * amount.
 */
export const BOOKING_MONEY_EVIDENCE_ABSENT_WHY: Partial<
  Record<BookingMoneyReconciliationReason, string>
> = {
  NO_SURVIVING_STRANDS:
    "No guests remain on this booking, so there are no per-guest amounts left to add up.",
  STRAND_EVIDENCE_UNREADABLE:
    "At least one guest has no nightly prices recorded at all, so there is nothing to add up for them.",
  PROMO_BUILD_UP_NOT_KNOWN:
    "The discount on this booking was stored as a single figure, without the per-night breakdown needed to check it.",
};

/**
 * The reasons a booking cannot be checked, each with its cause, ready to list.
 * Falls back to the general reason text if a reason ever reaches here without
 * its own sentence — visible and wrong-looking rather than silently blank.
 */
export function bookingMoneyEvidenceAbsentReasons(
  reasons: readonly BookingMoneyReconciliationReason[],
): readonly { reason: BookingMoneyReconciliationReason; why: string }[] {
  return reasons.map((reason) => ({
    reason,
    why:
      BOOKING_MONEY_EVIDENCE_ABSENT_WHY[reason] ??
      `${BOOKING_MONEY_RECONCILIATION_REASON_TEXT[reason]}.`,
  }));
}

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
    "at least one guest strand has no stored night price evidence at all",
  STRAND_TOTAL_DISAGREES:
    "at least one guest's stored night prices do not add up to that guest's own recorded total",
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
