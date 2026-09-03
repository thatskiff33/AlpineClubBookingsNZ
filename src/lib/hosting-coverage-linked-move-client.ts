/**
 * Browser-side half of #3232's linked-move offer.
 *
 * Keep this module free of Prisma, Node crypto and server-only imports, exactly
 * as its `hosting-coverage-override-client.ts` sibling is. The server owns both
 * digests; the browser only validates the typed 409 and returns the opaque
 * versioned correlator belonging to the arm the member chose.
 *
 * FAIL CLOSED, and here that means "show no offer" rather than "show a partial
 * one". A half-read prompt would put a price in front of a member that the server
 * never quoted, or a Move-both button whose state key is missing — which the
 * server would reject as stale, leaving them clicking a button that cannot work.
 * Every field the offer needs is therefore required, and anything short of the
 * complete body reads as no offer at all, which falls back to the plain refusal
 * sentence the panel already renders.
 *
 * AND IT OWNS THE SENTENCES BOTH SIDES SAY. The server's 409 message and this
 * component's radio labels were two independently-worded copies of the same
 * refund/payable/waiver/settlement decision tree, rendered in the same box at the
 * same moment, and they had already drifted — one waiver sentence ended "so that
 * total carries one change fee only" and the other stopped at "by the club". They
 * are composed here now, once (`INV-SSOT-001`).
 */

import { formatCents } from "@/lib/utils";
import { HOSTING_COVERAGE_STATE_KEY_PATTERN } from "@/lib/hosting-coverage-override-client";

/**
 * One booking the offer would move alongside the one the member asked about.
 *
 * THE ONE DEFINITION OF THIS WIRE ROW. The server used to restate the same ten
 * fields as its own `LinkedMoveBooking`; it now aliases this type instead
 * (`INV-SSOT-001`), because `import type` is erased at compile time so the server
 * takes on no browser dependency by naming it, and two hand-kept copies of a wire
 * shape are two things that can disagree about what the server sends.
 */
export interface HostingCoverageLinkedMoveBooking {
  bookingId: string;
  /** The short handle the member sees, never the raw cuid alone. */
  reference: string;
  lodgeName: string;
  /** The nights the rule finds uncovered on this booking if it stays put. */
  uncoveredNights: string[];
  /** Where this booking is today (stored lodge nights, `YYYY-MM-DD`). */
  currentCheckIn: string;
  currentCheckOut: string;
  /**
   * Where the linked move would put it.
   *
   * NOT NECESSARILY "the same nights as the other booking", and the offer says the
   * real dates rather than that phrase for exactly that reason. The two bookings
   * can be different lengths, so the honest general rule is that this booking
   * shifts by the same number of days as the one the member moved — which IS "the
   * same nights" whenever the two windows matched, and is a statement the member
   * can check against a calendar whenever they did not.
   */
  proposedCheckIn: string;
  proposedCheckOut: string;
  /** Integer cents. Positive = this booking costs more on the new nights. */
  priceDiffCents: number;
  /** Integer cents. The late-notice change fee this booking's own move attracts. */
  changeFeeCents: number;
}

export interface HostingCoverageLinkedMovePromptData {
  message: string;
  /** The key `MOVE_BOTH` must return; bound to the moves AND the money. */
  acceptStateKey: string;
  /** The key `LEAVE_UNCOVERED` must return; bound to the stranded set alone. */
  declineStateKey: string;
  /** False when there are not beds for both — the owner's "cannot" arm. */
  linkedMoveAvailable: boolean;
  linkedBookings: HostingCoverageLinkedMoveBooking[];
  combinedAmountDueCents: number;
  combinedRefundCents: number;
  combinedChangeFeeCents: number;
  combinedPolicyRetainedCents: number;
  settlementMethodRequired: boolean;
  settlementMethodChosen: boolean;
  bothChangeFeesCharged: boolean;
}

/**
 * The money the offer moves, as any surface rendering it needs to read it.
 *
 * `linkedCount` IS A FIELD RATHER THAN AN ASSUMPTION. Every sentence below used to
 * be written for exactly one other booking — "both bookings", "the second
 * booking", "the booking above" — while `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` is
 * 25 and a member with one adult and two parties of guests is an ordinary family
 * shape. A member in that shape was told "2 other bookings ... is relying" and,
 * on the arm the design relies on for informed consent, that "the booking above"
 * would be left uncovered while the list showed three.
 */
export interface LinkedMoveMoneyFacts {
  combinedAmountDueCents: number;
  combinedRefundCents: number;
  combinedChangeFeeCents: number;
  /**
   * What the club's cancellation policy KEEPS of the reductions, in cents.
   *
   * It is the gap between how far the price fell and how much comes back, and
   * saying it is the whole reason `policyRetainedAmountCents` exists at all: a
   * member consenting ONCE to a combined figure should not have to work out for
   * themselves why a $500 reduction returned $250.
   */
  combinedPolicyRetainedCents: number;
  settlementMethodRequired: boolean;
  /**
   * True when the request that produced this quote ALREADY carried a card-or-credit
   * choice, so nobody is going to be asked anything.
   */
  settlementMethodChosen: boolean;
  bothChangeFeesCharged: boolean;
  /** How many OTHER bookings the offer would move. At least one. */
  linkedCount: number;
}

/** "both bookings" / "all 3 bookings" — the primary plus its dependents. */
export function linkedMoveAllBookingsPhrase(linkedCount: number): string {
  return linkedCount === 1 ? "both bookings" : `all ${linkedCount + 1} bookings`;
}

/** "the other booking" / "the other 2 bookings". */
export function linkedMoveOtherBookingsPhrase(linkedCount: number): string {
  return linkedCount === 1
    ? "the other booking"
    : `the other ${linkedCount} bookings`;
}

/**
 * Which change fees the combined figure carries, and whose answer that is.
 *
 * D2 made the second fee a club setting because clubs disagree about whether it is
 * fair when the club's own supervision rule is what compelled the move, so the
 * sentence has to say which answer THIS club gave rather than leave the member to
 * assume they paid one fee for moving two bookings.
 */
function linkedMoveChangeFeeSentence(facts: LinkedMoveMoneyFacts): string {
  // NO FEE AT ALL IS ITS OWN ANSWER, and both sentences below assert a figure. A
  // move outside every fee band, an unchanged check-in or a draft attracts nothing,
  // and the two branches were saying "($0.00 in all)" and "carries one change fee
  // only" over a total that carried none.
  if (facts.combinedChangeFeeCents <= 0) {
    return "No change fee applies to this move.";
  }
  if (facts.bothChangeFeesCharged) {
    // NOT "that total includes", which was written when there was one figure and
    // stopped being true the moment there were two. A payable figure has the fee
    // ADDED to it and a refund figure has it TAKEN OFF, so "includes" told a member
    // reading a refund the opposite of what happened — the fee made the money
    // coming back smaller. "Already take it into account" is true of both
    // directions, which is what a sentence sitting under both of them has to be.
    return (
      `A change fee applies to ${linkedMoveAllBookingsPhrase(facts.linkedCount)} ` +
      `— ${formatCents(facts.combinedChangeFeeCents)} in all — and the figures ` +
      `above already take it into account.`
    );
  }
  return (
    `The change fee on ${linkedMoveOtherBookingsPhrase(facts.linkedCount)} ` +
    `has been waived by the club, so the figures above carry one change fee ` +
    `only (${formatCents(facts.combinedChangeFeeCents)}).`
  );
}

/**
 * What the linked move costs, in plain words — AND IN BOTH DIRECTIONS AT ONCE
 * WHEN THAT IS WHAT IS HAPPENING (#3232).
 *
 * THE THREE-WAY EXCLUSIVE TERNARY THIS REPLACES WAS A WAY TO CHARGE A MEMBER
 * MONEY NO SCREEN NAMED. Refund, else payable, else nothing is a sound reading of
 * ONE booking, where exactly one of the two can be non-zero. Across two bookings
 * it is not: `combineLinkedMoveQuote` sums each independently, so one booking
 * netting up while the other nets down leaves BOTH totals positive and the refund
 * branch won. Concretely — booking A shifts into peak (+$120 of price, +$50 of
 * fee, so $170 due) and booking B's window shifts off an event surcharge (-$300,
 * +$50, so $250 back) — the member read "$250.00 would come back to you", accepted,
 * and was charged $170 nothing had shown them. `linkedMoveStateKey` covers both
 * figures, so the server accepted the acceptance: the key proves they were shown
 * A quote, not a complete one.
 *
 * AND THE TWO ARE STATED AS NOT NETTING OFF, which is the same fact
 * `LinkedMoveQuote` gives as the reason there are two fields rather than one
 * signed number. A booking whose price fell refunds through its own payment or
 * credit note and a booking whose price rose takes a fresh charge on its own
 * payment intent; Stripe and Internet Banking/Xero settlement stay distinct per
 * booking. A member told only the net figure would be waiting for a smaller
 * refund that never arrives instead of paying a charge that does.
 */
export function formatLinkedMoveMoneySentence(
  facts: LinkedMoveMoneyFacts,
): string {
  const all = linkedMoveAllBookingsPhrase(facts.linkedCount);
  const parts: string[] = [];
  if (facts.combinedRefundCents > 0 && facts.combinedAmountDueCents > 0) {
    parts.push(
      `${formatCents(facts.combinedAmountDueCents)} would be payable and ` +
        `${formatCents(facts.combinedRefundCents)} would come back to you, ` +
        `across ${all}. Those two do not cancel each other out: each booking ` +
        `settles on its own, so the amount payable is paid on its own booking ` +
        `page and the refund comes back separately.`,
    );
  } else if (facts.combinedRefundCents > 0) {
    parts.push(
      `${formatCents(facts.combinedRefundCents)} would come back to you across ` +
        `${all}.`,
    );
  } else if (facts.combinedAmountDueCents > 0) {
    // "ACROSS", AND THEN WHERE. The combined figure is not one payment: each
    // booking's increase is collected on that booking's own page, and nothing on
    // this screen said so — a member reading one total reasonably expects one card
    // prompt, and there is none, because the linked move commits both bookings and
    // hands neither a payment secret. Saying it here is the fix; the money itself
    // was never at risk.
    parts.push(
      `${formatCents(facts.combinedAmountDueCents)} would be payable across ` +
        `${all}, and each booking is paid on its own booking page.`,
    );
  } else {
    parts.push("There is nothing more to pay and nothing to come back.");
  }
  // WHAT THE POLICY KEPT, beside the figure it made smaller. A booking whose price
  // falls by $500 under a 50% tier returns $250, and without this sentence the
  // other $250 is stated nowhere — on a screen whose whole job is to obtain ONE
  // informed consent to a combined figure.
  if (facts.combinedPolicyRetainedCents > 0) {
    parts.push(
      `The club's cancellation policy keeps ` +
        `${formatCents(facts.combinedPolicyRetainedCents)} of the reduction, so ` +
        `what comes back is less than the drop in price.`,
    );
  }
  parts.push(linkedMoveChangeFeeSentence(facts));
  // ONLY WHERE SOMEBODY IS REALLY GOING TO BE ASKED. A request that already carried
  // the choice is re-quoted with it, and promising a question nobody will put is
  // how a member waits for a control that never appears.
  if (facts.settlementMethodRequired && !facts.settlementMethodChosen) {
    // Neutral about WHERE the control is, because this same sentence is read on
    // the panel (where the Return-method radios sit above the offer) and in the
    // bare 409 message a surface without them falls back to.
    parts.push(
      facts.combinedRefundCents > 0
        ? `You will be asked once whether that comes back to your card or as ` +
            `account credit; the one choice covers ${all}.`
        : // AND THE ZERO ABOVE IS NOT "nothing comes back". This quote is priced as
          // a card refund, and the club's policy can return nothing that way while
          // returning real money as account credit — two tiers, two percentages,
          // two fixed fees. Saying only "there is nothing to come back" over a
          // control asking where it should go is what made the offer unanswerable.
          `Money does come back on this move, but priced as a card refund the ` +
          `club's policy returns none of it — so you will be asked once whether ` +
          `to take it as account credit instead, and the figures are confirmed ` +
          `for the choice you make.`,
    );
  }
  return parts.join(" ");
}

/** The heading over the list of bookings the change would strand. */
export function linkedMoveHeading(linkedCount: number): string {
  return linkedCount === 1
    ? "Another of your bookings needs an adult on the nights below"
    : `${linkedCount} of your bookings need an adult on the nights below`;
}

/**
 * What declining costs, beside the arm that costs it.
 *
 * THE COUNT MATTERS MOST HERE. This is the sentence the design relies on for
 * informed consent, and "The booking above will be left without adult
 * supervision" understates the consequence for every member with more than one
 * dependent — the list shows three and the sentence admits to one.
 */
export function linkedMoveDeclineConsequence(linkedCount: number): string {
  const which =
    linkedCount === 1
      ? "The booking listed above"
      : `The ${linkedCount} bookings listed above`;
  return (
    `${which} will be left without adult supervision on those nights. A ` +
    `Booking Officer will be told and will be in touch if anything needs to ` +
    `change.`
  );
}

export type HostingCoverageLinkedMoveChoice = "MOVE_BOTH" | "LEAVE_UNCOVERED";

const LODGE_NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isLodgeNight(value: unknown): value is string {
  return typeof value === "string" && LODGE_NIGHT_PATTERN.test(value);
}

/**
 * Integer cents, and nothing else.
 *
 * A non-integer amount here would be a server defect, but rendering one would put
 * a fractional cent in front of a member, so it fails the whole read instead.
 */
function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function readBooking(value: unknown): HostingCoverageLinkedMoveBooking | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.bookingId !== "string" ||
    row.bookingId.length === 0 ||
    typeof row.reference !== "string" ||
    row.reference.trim().length === 0 ||
    typeof row.lodgeName !== "string" ||
    row.lodgeName.trim().length === 0 ||
    !Array.isArray(row.uncoveredNights) ||
    row.uncoveredNights.length === 0 ||
    !row.uncoveredNights.every(isLodgeNight) ||
    !isLodgeNight(row.currentCheckIn) ||
    !isLodgeNight(row.currentCheckOut) ||
    !isLodgeNight(row.proposedCheckIn) ||
    !isLodgeNight(row.proposedCheckOut) ||
    !isCents(row.priceDiffCents) ||
    !isCents(row.changeFeeCents)
  ) {
    return null;
  }
  return {
    bookingId: row.bookingId,
    reference: row.reference,
    lodgeName: row.lodgeName,
    uncoveredNights: row.uncoveredNights as string[],
    currentCheckIn: row.currentCheckIn,
    currentCheckOut: row.currentCheckOut,
    proposedCheckIn: row.proposedCheckIn,
    proposedCheckOut: row.proposedCheckOut,
    priceDiffCents: row.priceDiffCents,
    changeFeeCents: row.changeFeeCents,
  };
}

/** Fail closed unless the complete typed 409 body is present. */
export function readHostingCoverageLinkedMovePrompt(
  value: unknown,
): HostingCoverageLinkedMovePromptData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.code !== "SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED" ||
    record.requiresLinkedMoveChoice !== true ||
    typeof record.error !== "string" ||
    record.error.trim().length === 0 ||
    typeof record.acceptStateKey !== "string" ||
    !HOSTING_COVERAGE_STATE_KEY_PATTERN.test(record.acceptStateKey) ||
    typeof record.declineStateKey !== "string" ||
    !HOSTING_COVERAGE_STATE_KEY_PATTERN.test(record.declineStateKey) ||
    typeof record.linkedMoveAvailable !== "boolean" ||
    typeof record.settlementMethodRequired !== "boolean" ||
    typeof record.settlementMethodChosen !== "boolean" ||
    typeof record.bothChangeFeesCharged !== "boolean" ||
    !isCents(record.combinedAmountDueCents) ||
    !isCents(record.combinedRefundCents) ||
    !isCents(record.combinedChangeFeeCents) ||
    !isCents(record.combinedPolicyRetainedCents) ||
    !Array.isArray(record.linkedBookings) ||
    record.linkedBookings.length === 0
  ) {
    return null;
  }

  const linkedBookings: HostingCoverageLinkedMoveBooking[] = [];
  for (const candidate of record.linkedBookings) {
    const row = readBooking(candidate);
    if (!row) return null;
    linkedBookings.push(row);
  }

  return {
    message: record.error,
    acceptStateKey: record.acceptStateKey,
    declineStateKey: record.declineStateKey,
    linkedMoveAvailable: record.linkedMoveAvailable,
    linkedBookings,
    combinedAmountDueCents: record.combinedAmountDueCents,
    combinedRefundCents: record.combinedRefundCents,
    combinedChangeFeeCents: record.combinedChangeFeeCents,
    combinedPolicyRetainedCents: record.combinedPolicyRetainedCents,
    settlementMethodRequired: record.settlementMethodRequired,
    settlementMethodChosen: record.settlementMethodChosen,
    bothChangeFeesCharged: record.bothChangeFeesCharged,
  };
}

/**
 * The answer to put on the retry, for the arm the member chose.
 *
 * THE ARM DECIDES WHICH KEY TRAVELS, and getting that wrong is not a cosmetic
 * error: the server checks the key against a different derivation per arm, so the
 * other arm's key simply does not match and the member is re-prompted. One
 * function so no surface has to remember which is which.
 *
 * Returns `null` for `MOVE_BOTH` when the offer is not available, because there is
 * no such answer to give — a client that sent one anyway would be answering an
 * offer the server did not make.
 */
export function hostingCoverageLinkedMoveAnswer(
  prompt: HostingCoverageLinkedMovePromptData,
  choice: HostingCoverageLinkedMoveChoice,
): { choice: HostingCoverageLinkedMoveChoice; acknowledged: true; stateKey: string } | null {
  if (choice === "MOVE_BOTH") {
    if (!prompt.linkedMoveAvailable) return null;
    return { choice, acknowledged: true, stateKey: prompt.acceptStateKey };
  }
  return { choice, acknowledged: true, stateKey: prompt.declineStateKey };
}
