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
 * WHICH SIDE EVERY REASON FALLS ON. Every one, stated.
 *
 * This was a Set of the quiet reasons, with everything unlisted defaulting to
 * actionable. That default is the safe direction, but it makes the most
 * important property of a new reason — what the screen will ask of an officer
 * — something you get by saying nothing. Review pointed out the obvious
 * alternative was already in use three declarations below, and costs the same:
 * an exhaustive `Record` keyed by the reason union. A reason added later now
 * fails to compile until somebody chooses its side, which is `INV-SSOT`'s
 * preference for unrepresentable over policed, applied to the thing that
 * actually matters here.
 *
 * `STRAND_TOTAL_DISAGREES` is a DISAGREEMENT (#3547): it used to arrive inside
 * `STRAND_EVIDENCE_UNREADABLE` and so inherited the quiet wording, but two
 * numbers both on file that do not agree is something an officer can resolve.
 */
const BOOKING_MONEY_REASON_KIND = {
  NO_SURVIVING_STRANDS: "EVIDENCE_ABSENT",
  STRAND_EVIDENCE_UNREADABLE: "EVIDENCE_ABSENT",
  STRAND_TOTAL_DISAGREES: "DISAGREEMENT",
  HEADLINE_TOTAL_MISMATCH: "DISAGREEMENT",
  PROMO_BUILD_UP_NOT_KNOWN: "EVIDENCE_ABSENT",
  PROMO_BUILD_UP_MISMATCH: "DISAGREEMENT",
  DISCOUNT_COMPONENT_MISMATCH: "DISAGREEMENT",
  FINAL_PRICE_RELATION_MISMATCH: "DISAGREEMENT",
} as const satisfies Record<
  BookingMoneyReconciliationReason,
  BookingMoneyUnreconciledKind
>;

/** Which kind a set of reasons describes. See the type's docblock for the rule. */
export function bookingMoneyUnreconciledKind(
  reasons: readonly BookingMoneyReconciliationReason[],
): BookingMoneyUnreconciledKind {
  return reasons.every(
    (reason) => BOOKING_MONEY_REASON_KIND[reason] === "EVIDENCE_ABSENT",
  )
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
 * `STRAND_EVIDENCE_UNREADABLE` is a guest some or all of whose night rows carry
 * no usable amount — `NO_STORED_NIGHT_PRICES` when none of them do,
 * `PARTIAL_STORED_NIGHT_PRICES` when only some do, which is what a parked edit
 * that GAINS nights leaves behind. Two causes, not one: an earlier draft of
 * this wording said "no nightly prices at all" and was simply false for the
 * partial case, which review caught. Reconciliation reads at WHOLE_GUEST grain,
 * where an even-share row that sums correctly is EXACT, so that cause never
 * arrives here at all; and #3547 moved rows that do not sum to the guest's own
 * recorded total to `STRAND_TOTAL_DISAGREES`, because that one is actionable;
 * `PROMO_BUILD_UP_NOT_KNOWN` is a promotion whose per-night rows carry a null
 * amount.
 */
type BookingMoneyEvidenceAbsentReason = {
  [R in BookingMoneyReconciliationReason]: (typeof BOOKING_MONEY_REASON_KIND)[R] extends "EVIDENCE_ABSENT"
    ? R
    : never;
}[BookingMoneyReconciliationReason];

/**
 * Keyed by the evidence-absent reasons DERIVED from the map above, not by a
 * second hand-written list. It was `Partial<Record<Reason, string>>`, which
 * meant moving a reason to the quiet side and forgetting its sentence
 * compiled cleanly and fell back to the terse internal text on screen — the
 * same class of wrong-words-to-an-officer failure this pull request is fixing.
 * Now a quiet reason without a sentence does not compile, and a sentence for a
 * reason that is not quiet does not either.
 */
export const BOOKING_MONEY_EVIDENCE_ABSENT_WHY: Record<
  BookingMoneyEvidenceAbsentReason,
  string
> = {
  NO_SURVIVING_STRANDS:
    "No guests remain on this booking, so there are no per-guest amounts left to add up.",
  STRAND_EVIDENCE_UNREADABLE:
    "For at least one guest, some or all of the nights have no price recorded against them, so that guest's stay cannot be added up.",
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
    // The index is still guarded at runtime: this helper is only ever called
    // for an all-quiet verdict, but it is exported and a caller could hand it
    // anything. A reason with no sentence falls back to the internal text
    // rather than rendering an empty bullet.
    why:
      (
        BOOKING_MONEY_EVIDENCE_ABSENT_WHY as Partial<
          Record<BookingMoneyReconciliationReason, string>
        >
      )[reason] ?? `${BOOKING_MONEY_RECONCILIATION_REASON_TEXT[reason]}.`,
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
    "at least one guest strand has some or all night prices unrecorded",
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
