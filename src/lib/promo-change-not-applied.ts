/**
 * #3179 (epic #2797): what a member is told when an edit SAVED but the
 * promotional-code part of it did not happen.
 *
 * ## The decision this implements
 *
 * The owner's answer on #3179 (31 Aug 2026) was "save what can be honoured, and
 * warn clearly about what cannot": the dates and the party are usually what the
 * member came for and they work, so refusing the whole edit would remove
 * something that functions in order to fix something that does not. What was
 * wrong was the SILENCE, and this module is the fix for it.
 *
 * The owner also named the cost, and it is the reason the wording here is longer
 * than a label: a partial save is a subtle thing to take in at a glance, so a
 * member who does not read the message walks away believing something happened
 * that did not. Every sentence below is therefore doing work — what did not
 * happen, why, what that means for the price and the code, and who to ask.
 *
 * ## ONE HOME, and why that is the constraint rather than a preference
 *
 * Five surfaces say this: the edit preview, the saved edit's response (which
 * holds the panel open), the "Booking Modified" email, the booking's own history
 * timeline, and the audit row behind it. `promo-cap-coverage.ts` exists for
 * exactly the same reason one step away, and this epic has spent its length
 * closing cases where two surfaces told one member two stories. A club that
 * wants to soften any of this edits these strings, once, and every surface
 * follows.
 *
 * ## THIS WORDING IS DEVELOPER-EDITABLE, NOT ADMIN-EDITABLE, and that is a
 * divergence from how the constraint on the issue was phrased
 *
 * Stated here plainly rather than left to be discovered, because the issue asks
 * for a copy module "a different club must be able to soften WITHOUT A CODE
 * CHANGE", and editing this file IS a code change. What a club gets is one
 * place to change, reviewed and shipped like any other change; what it does not
 * get is an admin screen with a text box.
 *
 * That is deliberate, and it is what its two siblings do. `promo-cap-coverage.ts`
 * (#2390) and `booking-financial-review-copy.ts` (#3033) are both plain modules
 * composing sentences onto these same screens and this same email, and neither
 * is admin-editable. Making this one the exception would put three sentences
 * that appear in the same paragraph under two different editing models, which is
 * a worse inconsistency than the one it removes: an officer softening this
 * sentence in an admin screen would find the two beside it unchanged and
 * unreachable.
 *
 * The mechanism it is NOT is `BOOKING_MESSAGE_KEYS`, the admin-editable
 * booking-message registry. Those are rendered by a screen that fetches message
 * bodies; this sentence is composed per-request from the member's own request
 * and travels on the quote and the save response, which is what
 * `promoCapCoverageMessage` does beside it. Registering the edit panel as a
 * message-render surface to make one sentence editable would be a much larger
 * change than the one the issue asks for, and would move only this sentence.
 *
 * If a club does want all three admin-editable, that is one piece of work over
 * the three modules rather than a carve-out for this one.
 *
 * ## Why the reason is a parameter and not a fixed sentence
 *
 * Two different things stop a promotional-code change, and telling a member the
 * wrong one is worse than telling them nothing:
 *
 *  - `STAY_IN_PROGRESS` — the stay has already started. Both the preview
 *    (`modify-quote`) and the save (`resolveTargetDates`) refuse a promo change
 *    outright on that path today, so this arm is defence in depth: if either
 *    refusal is ever relaxed, the member is told rather than silenced.
 *  - `AMOUNT_UNDER_REVIEW` — the edit committed its structural half and parked
 *    its money for a person to price (`INV-MOD-028`). Nothing is repriced on
 *    that branch and no promotion is re-run, so a code the member applied in the
 *    same request is dropped. THIS is the reachable one: the member edit panel
 *    shows the promo card on a stay that has not started, and a booking whose
 *    stored night prices cannot be read parks on its first edit.
 *
 * The `AMOUNT_UNDER_REVIEW` wording deliberately does not reuse
 * `FINANCIAL_REVIEW_WORKING_IT_OUT` from `booking-financial-review-copy.ts`. That
 * sentence is composed onto the SAME screens and the SAME email as this one, so
 * borrowing it would print "the club is working it out" twice in adjacent
 * paragraphs. This says only the part that module does not: that a promotional
 * code cannot be moved while the pricing is with a person.
 */

/** What the member asked for, and therefore what did not happen. */
export type PromoChangeRequested = "apply" | "remove";

/** Why this edit could not carry it. See the module docblock. */
export type PromoChangeNotAppliedReason =
  | "STAY_IN_PROGRESS"
  | "AMOUNT_UNDER_REVIEW";

/**
 * Whether the member is reading this BEFORE pressing Save (the quote) or after
 * (the save response, the email, the history).
 *
 * It changes the tense and nothing else. One home still holds both, because the
 * alternative is the preview and the save writing their own sentences — which is
 * the failure this module exists to prevent.
 */
export type PromoChangePhase = "preview" | "saved";

export interface PromoChangeNotAppliedNotice {
  requested: PromoChangeRequested;
  reason: PromoChangeNotAppliedReason;
  /** The code the sentence names — uppercased, the way every surface shows it. */
  promoCode: string;
  message: string;
}

/** The skim-stopper above the sentence. Surfaces that have a heading use it. */
export function promoChangeNotAppliedHeading(phase: PromoChangePhase): string {
  return phase === "saved"
    ? "Part of your change was not applied"
    : "Part of this change will not be applied";
}

/** The label the email and the history use for the row that carries it. */
export const PROMO_CHANGE_NOT_APPLIED_LABEL = "Promo code not applied";

/**
 * WHAT IS STILL TRUE OF THE CODE ALREADY ON THE BOOKING, which is the half a
 * fixed sentence got wrong.
 *
 * `describePromoChangeNotApplied` deliberately reports an APPLY even when the
 * requested code is the one already on the booking — see its own note. That
 * decision is right, and the sentence has to be adapted to it: telling a member
 * who re-sent `SPRING24` that "the code has not been used, so it is still
 * available for another booking" is FALSE twice over. The redemption is still on
 * their booking and the discount is still in the total they are looking at.
 *
 * Three shapes, and each says what is true of BOTH codes involved:
 *
 *  - `resent` — the requested code is the one already on the booking (the panel
 *    reaches this through Remove followed by re-entering the same code to change
 *    who it covers, which sends `promoCode` with no `removePromoCode`). Nothing
 *    moved: the code, its discount and its beneficiaries are exactly as they
 *    were.
 *  - `swap` — a different code is already on the booking. The NEW one was not
 *    used and is still free; the OLD one is still there and still discounting
 *    the total on screen, which a sentence naming only the new code leaves the
 *    member to guess at.
 *  - neither — no promotion on the booking, which is the plain case.
 *
 * ONE CLAUSE IS CONDITIONAL ON SOMETHING ELSE THE SAME REQUEST DID. "as it was"
 * and "who it covers has not changed" are claims about the redemption's
 * BENEFICIARIES, and a guest removal in the same request quietly falsifies both:
 * `PromoRedemptionGuestTarget.bookingGuest` is `onDelete: Cascade`, and a parked
 * edit still deletes the rows for the guests it removes, so their target rows go
 * with them while the stored discount is written back untouched. Coverage really
 * did narrow. Nobody is misled into acting WRONGLY by it — the panel builds the
 * promo selection from the guests that remain, so coverage can only ever shrink
 * to a subset the member's own request already excluded — but a sentence that is
 * sometimes false is worse than one sentence fewer, so `guestRemovalsRequested`
 * drops the claim rather than qualifying it. It is dropped and not replaced with
 * a narrower one because saying exactly who is left would mean reading
 * `PromoRedemptionGuestTarget` rows, and this module is pure and synchronous by
 * contract (see `describePromoChangeNotApplied`).
 */
type PromoChangeShape = "resent" | "swap" | "plain";

function normaliseCode(code: string | null | undefined): string {
  return code?.trim().toUpperCase() ?? "";
}

function shapeOf(
  requested: PromoChangeRequested,
  promoCode: string,
  currentPromoCode: string | null | undefined,
): PromoChangeShape {
  if (requested === "remove") return "plain";
  const current = normaliseCode(currentPromoCode);
  if (!current) return "plain";
  return current === normaliseCode(promoCode) ? "resent" : "swap";
}

function headlineOf(
  requested: PromoChangeRequested,
  phase: PromoChangePhase,
  promoCode: string,
  shape: PromoChangeShape,
): string {
  if (requested === "remove") {
    return phase === "saved"
      ? `Promo code ${promoCode} was not removed from this booking.`
      : `Promo code ${promoCode} will not be removed from this booking.`;
  }
  if (shape === "resent") {
    // "Promo code SPRING24 was not applied" would be misread as "you have no
    // discount" by a member who still has one. What did not happen is their
    // CHANGE to it.
    return phase === "saved"
      ? `Your change to promo code ${promoCode} was not applied to this booking.`
      : `Your change to promo code ${promoCode} will not be applied to this booking.`;
  }
  return phase === "saved"
    ? `Promo code ${promoCode} was not applied to this booking.`
    : `Promo code ${promoCode} will not be applied to this booking.`;
}

function reasonOf(reason: PromoChangeNotAppliedReason): string {
  return reason === "STAY_IN_PROGRESS"
    ? "A promotional code cannot be added to or taken off a stay that has already started."
    : "This change is with the club to price, and a promotional code cannot be added or taken off while that is happening.";
}

function consequenceOf(
  requested: PromoChangeRequested,
  shape: PromoChangeShape,
  currentPromoCode: string | null | undefined,
  guestRemovalsRequested: boolean,
): string {
  if (requested === "remove") {
    return "The price still includes it, and the code stays on this booking rather than being free to use on another one.";
  }
  if (shape === "resent") {
    return guestRemovalsRequested
      ? "The code stays on this booking, and the price still includes its discount."
      : "The code stays on this booking exactly as it was, and the price still includes its discount. Who it covers has not changed either.";
  }
  const unused =
    "The price does not include a discount for it, and the code has not been used, so it is still available for another booking.";
  if (shape === "swap") {
    // The OLD code carries the identical claim, and loses it for the identical
    // reason: its own target rows cascade away with the removed guest too.
    const stillThere = guestRemovalsRequested
      ? `Promo code ${normaliseCode(currentPromoCode)} stays on this booking, and the price still includes its discount.`
      : `Promo code ${normaliseCode(currentPromoCode)} stays on this booking as it was, and the price still includes its discount.`;
    return `${unused} ${stillThere}`;
  }
  return unused;
}

function closingOf(phase: PromoChangePhase): string {
  return phase === "saved"
    ? "Everything else in this change was saved. Contact the club if you need the promotional code changed on this stay."
    : "Everything else in this change will be saved. Contact the club if you need the promotional code changed on this stay.";
}

/**
 * The one sentence-set every surface uses.
 *
 * Composed from four clauses rather than frozen as one paragraph, for the reason
 * `booking-financial-review-copy.ts` gives: the surfaces place it differently
 * and one of them (the panel) puts a heading above it.
 */
export function promoChangeNotAppliedMessage(input: {
  requested: PromoChangeRequested;
  reason: PromoChangeNotAppliedReason;
  promoCode: string;
  phase: PromoChangePhase;
  /**
   * The code on the booking right now, when there is one. It changes what is
   * TRUE of the price the member is looking at, not merely how the sentence
   * reads — omitting it on a booking that carries a promotion produces a
   * message that states two false things. See `shapeOf`.
   */
  currentPromoCode?: string | null;
  /**
   * Whether the SAME request removed a guest from the booking. Required rather
   * than defaulted, because a caller that forgets it would answer "no removals"
   * silently and re-state the coverage claim this exists to suppress. See
   * `PromoChangeShape`.
   */
  guestRemovalsRequested: boolean;
}): string {
  const {
    requested,
    reason,
    promoCode,
    phase,
    currentPromoCode,
    guestRemovalsRequested,
  } = input;
  const shape = shapeOf(requested, promoCode, currentPromoCode);
  return [
    headlineOf(requested, phase, promoCode, shape),
    reasonOf(reason),
    consequenceOf(requested, shape, currentPromoCode, guestRemovalsRequested),
    closingOf(phase),
  ].join(" ");
}

/**
 * Turn a modification request into the notice, or `null` when this edit dropped
 * nothing the member asked for.
 *
 * Pure and synchronous — no database, no settings read — because it is called
 * from the quote route outside any transaction AND from inside the save's
 * lock-holding transaction (`INV-LOCK-004`: nothing new reads under those
 * locks).
 *
 * ## What counts as a dropped request
 *
 * A removal is only dropped when there is something to remove: `removePromoCode`
 * on a booking carrying no promotion leaves the booking in exactly the state the
 * member asked for, and warning about it would be a false alarm.
 *
 * An APPLY is reported whenever the request carries a code, INCLUDING one that
 * matches the code already on the booking. That is deliberate: the same code can
 * arrive with different beneficiaries (`promoGuestIds`), and the priced path
 * treats a resent code as a removal followed by a fresh application. Deciding it
 * is a no-op here would need a second, cleverer answer to "did anything change?"
 * than the path itself uses, and being wrong in that direction re-creates the
 * silence this exists to remove. Over-telling is a nuisance; under-telling is the
 * defect.
 *
 * Removal wins when a request somehow carries both, because that is the order
 * `applyPromoCodeChanges` resolves them in (`input.promoCode && !input.removePromoCode`).
 */
export function describePromoChangeNotApplied(input: {
  /** `BatchModifyInput.promoCode` as the member sent it. */
  requestedPromoCode: string | null | undefined;
  /** `BatchModifyInput.removePromoCode`. */
  removePromoCodeRequested: boolean;
  /** The code on the booking right now, if any. */
  currentPromoCode: string | null | undefined;
  /**
   * Whether this same request removes a guest from the booking — the resolved
   * removals, not the raw ids, so an id naming nobody cannot suppress anything.
   *
   * REQUIRED, and deliberately not defaulted: a new call site that omitted it
   * would answer "no removals" by omission and print a coverage claim its own
   * request had just falsified (`PromoChangeShape`).
   */
  guestRemovalsRequested: boolean;
  reason: PromoChangeNotAppliedReason;
  phase: PromoChangePhase;
}): PromoChangeNotAppliedNotice | null {
  const { reason, phase } = input;
  const current = input.currentPromoCode?.trim().toUpperCase() ?? "";
  const requestedCode = input.requestedPromoCode?.trim().toUpperCase() ?? "";

  if (input.removePromoCodeRequested) {
    if (!current) return null;
    return {
      requested: "remove",
      reason,
      promoCode: current,
      message: promoChangeNotAppliedMessage({
        requested: "remove",
        reason,
        promoCode: current,
        phase,
        guestRemovalsRequested: input.guestRemovalsRequested,
      }),
    };
  }

  if (!requestedCode) return null;
  return {
    requested: "apply",
    reason,
    promoCode: requestedCode,
    message: promoChangeNotAppliedMessage({
      requested: "apply",
      reason,
      promoCode: requestedCode,
      phase,
      // REQUIRED here, not decorative: this is the arm that reports a resent or
      // swapped code, and without it the sentence tells a member holding a live
      // discount that their code is unused and free for another booking.
      currentPromoCode: current,
      guestRemovalsRequested: input.guestRemovalsRequested,
    }),
  };
}
