import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalStrandedRows,
  type StrandedCoverageBooking,
} from "@/lib/adult-member-hosting-same-owner";
import { ApiError } from "@/lib/api-error";
import { formatBookingReference } from "@/lib/booking-reference";
import { addDaysDateOnly, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  HOSTING_COVERAGE_STATE_KEY_PATTERN,
  hostingCoverageStateKeyOf,
} from "@/lib/hosting-coverage-override-client";
import {
  formatLinkedMoveMoneySentence,
  linkedMoveAllBookingsPhrase,
  type HostingCoverageLinkedMoveBooking,
} from "@/lib/hosting-coverage-linked-move-client";

/**
 * The LINKED MOVE: what a member is offered when moving one of their bookings
 * would leave another of their own bookings without adult supervision (#3232,
 * `INV-HOST-050`).
 *
 * Deliberately I/O-free — the wire shape, the request schema, the state key and
 * the member-facing sentences, and nothing else. The detection lives in
 * `adult-member-hosting-review.ts`, the money and the atomic write live in
 * `booking-linked-date-move-service.ts`, and keeping this module free of both is
 * what lets the hosting engine raise the offer without importing the pricing
 * engine (which would be a cycle) and lets the browser read the prompt without
 * importing Prisma.
 *
 * ## Why an offer and not a refusal, which is the whole point of the issue
 *
 * The obvious fix for "moving A silently strands B" is to refuse the move. The
 * owner tested that against the next question — what is the member supposed to do,
 * move B first? — and it does not survive it. Moving B is ALREADY refused, by the
 * same rule from the other end: B away from A is B with no qualifying adult, and
 * `REFUSE` is the default enforcement. So a member who simply wants both of their
 * own bookings on different nights could move NEITHER. A refusal ships a deadlock,
 * and the "or sort the other booking out first" advice describes something the
 * code forbids.
 *
 * The offer is the thing the member is actually trying to do:
 *
 *  - **Yes** — both bookings move together, atomically, on ONE combined figure
 *    accepted once. This is the arm that resolves the deadlock.
 *  - **No** — only the changed booking moves, the member is told in plain words
 *    that the other will be left without adult supervision, the officer queue gets
 *    it and an incident opens. Never silence.
 *  - **Cannot** — where the beds are not there for both, that is said plainly and
 *    the warn-and-continue path is offered rather than a failure.
 *
 * ## The three arms are all reachable, which is the property that matters
 *
 * A refusal is only legitimate when the person refused can do something about it.
 * That is why the arms above are what they are, and it is also why the bare
 * stranded refusal (`SameOwnerCoverageWouldBreakError`) survives for a DIFFERENT
 * case: a stranding caused by removing a guest or cancelling a booking leaves the
 * member with real remedies on the affected booking — put cover back, cancel it,
 * ask an officer — none of which the rule forbids. A stranding caused by MOVING
 * away is the one where every remedy is blocked, and it is the one this module
 * answers.
 */

/** The machine-readable code on the 409 that carries the offer. */
export const HOSTING_COVERAGE_LINKED_MOVE_CODE =
  "SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED" as const;

/**
 * Whether both bookings can actually be moved, decided from beds rather than from
 * optimism.
 *
 * `NO_CAPACITY` is the owner's "cannot" arm and it is NOT a failure: the member is
 * told plainly that there are not beds for both on the new nights, and the
 * warn-and-continue path is offered instead. Nothing about a full lodge should
 * stop a member moving their own booking.
 */
export type LinkedMoveFeasibility = "AVAILABLE" | "NO_CAPACITY";

/**
 * One booking the offer would move alongside the one the member asked about.
 *
 * AN ALIAS, NOT A SECOND DECLARATION. The wire shape is declared once, in the
 * browser contract that also validates it (`INV-SSOT-001`); the two used to be
 * hand-kept copies of the same ten fields, which is two things that can disagree
 * about what the server actually sends. `import type` is erased, so naming it here
 * gives this module no browser dependency at all.
 */
export type LinkedMoveBooking = HostingCoverageLinkedMoveBooking;

/** The booking the member actually asked to move. */
export interface LinkedMovePrimary {
  bookingId: string;
  reference: string;
  proposedCheckIn: string;
  proposedCheckOut: string;
  priceDiffCents: number;
  changeFeeCents: number;
}

/**
 * The ONE combined figure the member accepts once (#3232 D2).
 *
 * EVERY FIELD IS INTEGER CENTS, and the combined fields are sums of the per-booking
 * ones rather than a separately-derived total — a total that could disagree with
 * its own parts is a total nobody can check.
 *
 * WHY BOTH A DUE AND A REFUND FIELD rather than one signed number. The two do not
 * net off in this product: a booking whose price fell refunds through its own
 * payment (or its own credit note), and a booking whose price rose takes a fresh
 * charge on its own payment intent. Stripe and Internet Banking/Xero settlement
 * stay distinct per booking, so presenting one signed figure would imply a
 * netting-off that never happens and would hide a refund the member is owed behind
 * a charge they have to make.
 */
export interface LinkedMoveQuote {
  primary: LinkedMovePrimary;
  /** Ordered by booking id, so the same situation always renders the same way. */
  linked: LinkedMoveBooking[];
  combinedPriceDiffCents: number;
  combinedChangeFeeCents: number;
  /** What the member pays now, across both bookings. */
  combinedAmountDueCents: number;
  /** What comes back to the member, across both bookings. */
  combinedRefundCents: number;
  /**
   * True when money comes back and the member therefore has to choose a card
   * refund or account credit. One choice covers both bookings — see
   * `formatLinkedMoveOfferMessage`.
   */
  settlementMethodRequired: boolean;
  /**
   * Whether the second booking's change fee is being charged (D2's club setting).
   *
   * Carried on the quote rather than looked up by whoever renders it, because the
   * member is entitled to know WHY the figure is what it is, and because a club
   * that waives it must not have a sentence claiming otherwise shown over the top
   * of a figure that does not include it.
   */
  bothChangeFeesCharged: boolean;
  feasibility: LinkedMoveFeasibility;
}

/**
 * Bind the member's acceptance to the exact situation, the exact proposal AND the
 * exact money they were shown (#3232).
 *
 * THE MONEY IS IN THE KEY, and that is the difference between this and
 * `strandedCoverageStateKey`, which binds an officer's acknowledgement to the
 * stranded set alone. An acknowledgement is a statement about a hazard; an
 * acceptance is a statement about a PRICE. If the combined figure moved between
 * the offer and the retry — a season rate changed, a promotion expired, the club
 * switched the second change fee off — then the member is being charged something
 * they never agreed to, and the honest answer is a fresh prompt rather than a
 * silent substitution. The server re-derives this key under the locks and refuses
 * on any mismatch, so the acceptance can never outlive the quote it answered.
 *
 * THE STRANDED SET IS CANONICALISED BY THE ONE FUNCTION THAT DOES THAT
 * (`canonicalStrandedRows`), not by a second copy here. Two keys that disagreed
 * about whether a situation had changed would let one prompt be answered with the
 * other's evidence.
 *
 * PROPOSALS ARE SORTED BY BOOKING ID so the key represents a SET of moves rather
 * than the order a query happened to return them in, exactly as the stranded rows
 * are. Presentation — references, lodge names — is deliberately absent: a lodge
 * rename is not a different offer.
 *
 * THE PRICE DELTA IS IN THERE TOO, and leaving it out was a hole rather than an
 * economy. Due, refund and change fee are all outputs of
 * `applyPaymentAdjustments`, which is INERT for a booking that has taken no money
 * yet: a `PAYMENT_PENDING` dependent quotes 0/0/0 whatever its price does. So the
 * member could be shown "there is nothing more to pay and nothing to come back",
 * an officer could edit the season rate before they pressed save, and the retry
 * would find the dependent $80 dearer with all three keyed figures still zero —
 * key matched, transaction committed, and $80 they never agreed to waiting at the
 * pay step. `combinedPriceDiffCents` is the figure that moved, so it is the figure
 * that has to bind.
 *
 * THE VERSIONED PREFIX IS MINTED IN ONE PLACE (`hostingCoverageStateKeyOf`), so a
 * future change to what the key must cover fails closed rather than colliding
 * with an old value, and the bump reaches the readers with the minters.
 */
export function linkedMoveStateKey(input: {
  stranded: readonly StrandedCoverageBooking[];
  sourceBookingId: string;
  proposals: ReadonlyArray<{
    bookingId: string;
    checkIn: string;
    checkOut: string;
  }>;
  combinedAmountDueCents: number;
  combinedRefundCents: number;
  combinedChangeFeeCents: number;
  combinedPriceDiffCents: number;
}): string {
  const proposals = [...input.proposals]
    .map((proposal) => ({
      bookingId: proposal.bookingId,
      checkIn: proposal.checkIn,
      checkOut: proposal.checkOut,
    }))
    .sort(byBookingId);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sourceBookingId: input.sourceBookingId,
        stranded: canonicalStrandedRows(input.stranded),
        proposals,
        money: {
          due: input.combinedAmountDueCents,
          refund: input.combinedRefundCents,
          changeFee: input.combinedChangeFeeCents,
          priceDiff: input.combinedPriceDiffCents,
        },
      }),
    )
    .digest("hex");
  return hostingCoverageStateKeyOf(digest);
}

/**
 * The member's answer, as it arrives on the wire.
 *
 * `acknowledged: z.literal(true)` follows the house shape its
 * `hostingCoverageOverrideSchema` sibling uses: the only value that means anything
 * is `true`, so a client sending `false` is told its request is malformed rather
 * than having a silent no-op accepted.
 *
 * NO REASON FIELD, unlike the officer's override, and the asymmetry is the point.
 * §7 demands a reason from an officer because the officer is exercising authority
 * over somebody else's booking and the club has to be able to audit it later.
 * These are the member's OWN two bookings and the decision is theirs to make;
 * demanding an essay before they may move their own booking would be the same
 * mistake as refusing them. What IS demanded is that they were shown the
 * consequence — which is what `strandedStateKey` proves.
 *
 * BOTH CHOICES CARRY A KEY, and they carry DIFFERENT ones, which is the part
 * worth reading twice. The offer body issues two — `acceptStateKey` and
 * `declineStateKey` — and the client returns the one belonging to the arm it
 * chose, in this single `stateKey` field.
 *
 *  - DECLINING is a statement about the HAZARD: "I know these bookings will be
 *    left uncovered on these nights, and I am going ahead." It has no price, so
 *    it is bound by the stranded set alone (`strandedCoverageStateKey`) — the same
 *    key the officer's override already uses, re-used rather than re-invented so
 *    the two cannot drift.
 *  - ACCEPTING is a statement about a PRICE as well as a hazard, so it is bound by
 *    `linkedMoveStateKey`, which additionally covers the proposed dates for every
 *    booking and the combined money.
 *
 * ONE FIELD RATHER THAN TWO OPTIONAL ONES, because a shape with two nullable keys
 * has a state — both present, or the wrong one present — that means nothing, and
 * the server would have to decide which to believe. Here the arm decides which
 * derivation the key is checked against, and a key from the other arm simply does
 * not match, which produces a fresh prompt.
 */
export const hostingCoverageLinkedMoveSchema = z
  .object({
    choice: z.enum(["MOVE_BOTH", "LEAVE_UNCOVERED"]),
    acknowledged: z.literal(true),
    stateKey: z.string().regex(HOSTING_COVERAGE_STATE_KEY_PATTERN),
  })
  .strict();

export type HostingCoverageLinkedMoveInput = z.infer<
  typeof hostingCoverageLinkedMoveSchema
>;

/**
 * Order by booking id, and RETURN 0 ON A TIE.
 *
 * Written twice as `left < right ? -1 : 1`, which never returns 0. Harmless on
 * unique cuids and a trap the moment somebody reuses the shape on a key that can
 * tie, where an inconsistent comparator gives an implementation-defined order —
 * and this order is what makes a state key represent a SET rather than whatever
 * order a query happened to return.
 */
function byBookingId(
  left: { bookingId: string },
  right: { bookingId: string },
): number {
  if (left.bookingId < right.bookingId) return -1;
  if (left.bookingId > right.bookingId) return 1;
  return 0;
}

function describeBooking(booking: LinkedMoveBooking): string {
  return (
    `booking ${booking.reference} at ${booking.lodgeName} ` +
    `(${booking.currentCheckIn} to ${booking.currentCheckOut})`
  );
}

/**
 * The offer, in plain words, with every number the member needs to answer it.
 *
 * WRITTEN AS A QUESTION WITH A PRICE, because that is what it is. The member is
 * not being told off and is not being asked to understand the supervision rule;
 * they are being asked whether to move the other booking too, and told what that
 * costs. The dates are stated outright rather than described as "the same nights",
 * because the two bookings can be different lengths and "the same nights" would
 * then be untrue — see `LinkedMoveBooking.proposedCheckIn`.
 *
 * THE MONEY SENTENCE NAMES THE CHANGE FEES EXPLICITLY when both are charged,
 * because a member who moves two bookings and sees one total will otherwise
 * reasonably assume they paid one fee. D2 made that a club setting precisely
 * because clubs disagree about whether the second fee is fair when the club's own
 * supervision rule is what compelled the move, so the sentence has to say which
 * answer this club gave.
 */
export function formatLinkedMoveOfferMessage(quote: LinkedMoveQuote): string {
  const [first] = quote.linked;
  if (!first) {
    return (
      "Moving this booking would leave another booking on your account without " +
      "the required adult member coverage."
    );
  }
  const count = quote.linked.length;
  // COUNT-DRIVEN THROUGHOUT, because the limit is 25 and not 1: a member with one
  // adult and two parties of guests is an ordinary family shape, and the singular
  // wording told them "2 other bookings ... is relying ... would leave it without".
  const opening =
    count === 1
      ? `${describeBooking(first)} is relying on this booking for adult ` +
        `supervision, so moving this one on its own would leave it without.`
      : `${count} other bookings on your account are relying on this booking ` +
        `for adult supervision, so moving this one on its own would leave them ` +
        `without.`;

  if (quote.feasibility === "NO_CAPACITY") {
    return (
      `${opening} There are not enough beds free on the new nights to move ` +
      `${linkedMoveAllBookingsPhrase(count)}, so they cannot travel together ` +
      `this time. You can still move this booking: ` +
      `${count === 1 ? "the other one" : `the other ${count}`} will be left ` +
      `without adult supervision, a Booking Officer will be told, and it will ` +
      `be raised for their attention.`
    );
  }

  const moves = quote.linked
    .map(
      (booking) =>
        `${booking.reference} would move to ${booking.proposedCheckIn} - ` +
        `${booking.proposedCheckOut}`,
    )
    .join("; ");

  // ONE HOME FOR THE MONEY SENTENCE, shared with the radio labels the member reads
  // beside this very paragraph (`INV-SSOT-001`). It was written twice, in two
  // wordings, and had already drifted on the waiver clause.
  const moneySentence = formatLinkedMoveMoneySentence({
    combinedAmountDueCents: quote.combinedAmountDueCents,
    combinedRefundCents: quote.combinedRefundCents,
    combinedChangeFeeCents: quote.combinedChangeFeeCents,
    settlementMethodRequired: quote.settlementMethodRequired,
    bothChangeFeesCharged: quote.bothChangeFeesCharged,
    linkedCount: count,
  });

  return (
    `${opening} Move ${linkedMoveAllBookingsPhrase(count)} together? ` +
    `${moves}. ${moneySentence} If you would rather move only this booking, ` +
    `you can — ${count === 1 ? "the other" : `the other ${count}`} will be ` +
    `left without adult supervision and a Booking Officer will be told.`
  );
}

/**
 * What one booking's own move settled to, as the quote needs to read it.
 *
 * A STRUCTURAL SUBSET rather than an import of `BatchModificationResponse`, so
 * this module stays free of the pricing engine — the property that lets the
 * hosting engine raise the offer without a cycle and lets the browser read the
 * prompt without Prisma. The real result satisfies it, and the compiler checks
 * that at the one call site.
 */
export interface LinkedMoveSettledBooking {
  priceDiffCents: number;
  changeFeeCents: number;
  additionalAmountCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
}

/**
 * Where the dependent booking goes.
 *
 * IT SHIFTS BY THE SAME NUMBER OF DAYS AS THE PRIMARY'S ARRIVAL, KEEPING ITS OWN
 * LENGTH — not "to the same nights", which the issue's own wording uses and which
 * is only well defined when the two stays happen to match. Two bookings of
 * different lengths have no "same nights"; shifting by the arrival delta preserves
 * the relationship the dependent was relying on WHENEVER THE STAY MOVED AS A
 * WHOLE, and it also preserves the dependent's stay length, its per-guest stay
 * ranges and the shape of its price.
 *
 * IT DOES NOT PRESERVE COVER WHEN THE STAY WAS SHORTENED AT THE TAIL, and that is
 * a real limit of this rule rather than a bug in it. Cut 10–15 back to 10–12 and
 * the arrival did not move, so a 13–14 dependent's target is where it already is.
 * Following the DEPARTURE delta instead would drag a booking the member never
 * asked to move to nights they never chose, which is the same objection as
 * lengthening it. So the rule stays as it is and the CLASSIFICATION is what
 * changed: `linkedMoveWouldRestoreCover` refuses to claim the offer for a
 * shortening it cannot answer, and the member gets the ordinary refusal — whose
 * remedies, on this shape, really are open to them.
 *
 * WHEN THE PRIMARY ALSO CHANGED LENGTH — arrival and departure moved by different
 * amounts — the dependent still follows the ARRIVAL delta and keeps its own length.
 * A member extending their own stay has not asked to extend anybody else's, and
 * lengthening a second booking would charge them for nights they never requested.
 *
 * THE MEMBER IS SHOWN THE RESULTING DATES OUTRIGHT rather than this rule, because
 * dates can be checked against a calendar and a rule cannot.
 */
export function linkedMoveTargetRange(
  primary: { previousCheckIn: Date; currentCheckIn: Date },
  dependent: { checkIn: string; checkOut: string },
): { checkIn: string; checkOut: string } {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const shiftDays = Math.round(
    (primary.currentCheckIn.getTime() - primary.previousCheckIn.getTime()) /
      MS_PER_DAY,
  );
  return {
    checkIn: formatDateOnly(
      addDaysDateOnly(parseDateOnly(dependent.checkIn), shiftDays),
    ),
    checkOut: formatDateOnly(
      addDaysDateOnly(parseDateOnly(dependent.checkOut), shiftDays),
    ),
  };
}

/**
 * Whether the linked move could actually put this dependent back under the changed
 * booking's cover (#3232, `INV-HOST-050`).
 *
 * WHY THE CLASSIFICATION NEEDS THIS AND NOT JUST "IT MOVED AWAY". The refusal is
 * marked answerable when the dependent no longer shares a night with the changed
 * booking, because that is the shape where every remedy on the affected booking is
 * closed. But "it moved away" and "a shift can fix it" are not the same question,
 * and a SHORTENING is where they come apart. A stay of 10–15 cut back to 10–12
 * moves nothing at the arrival end, so `shiftDays` is zero and the dependent's
 * target is where it already is: its write is a no-op, it is still uncovered, and
 * the final supervision pass throws the bare refusal the offer was supposed to
 * replace. The member paid for two full pricing runs inside a transaction that was
 * always going to be discarded, and got today's answer anyway. The same happens
 * when the arrival moved but not far enough to carry the dependent inside the new
 * stay — 10–15 becoming 11–13 shifts a 13–14 dependent to 14–15, past the new
 * check-out.
 *
 * OVERLAP, NOT CONTAINMENT, and the weaker test is the deliberate one. Full cover
 * does not have to come from THIS booking alone — another booking of the owner's
 * can cover the rest of the dependent's nights — so demanding that the shifted
 * window sit wholly inside the new stay would withhold an offer the engine would
 * have accepted. What overlap rules out is the case where the shifted dependent
 * shares no night at all with the changed booking, where the shift provably
 * changes nothing about the relationship that broke.
 *
 * THE TRANSACTION REMAINS THE AUTHORITY. This is a cheap structural test on ONE
 * dependent, used to decide whether the offer is worth raising; whether the
 * combined move really satisfies the rule is decided by the real supervision pass
 * over the state that would commit.
 */
export function linkedMoveWouldRestoreCover(
  primary: {
    /** The window the changed booking vacated, or `null` if its stay did not move. */
    vacatedRange: { checkIn: Date; checkOut: Date } | null;
    currentCheckIn: Date;
    currentCheckOut: Date;
  },
  dependent: { checkIn: string; checkOut: string },
): boolean {
  // A change that did not move the stay cannot be answered by shifting anything:
  // there is no delta to shift by, so the dependent's target is its own window.
  if (!primary.vacatedRange) return false;
  const target = linkedMoveTargetRange(
    {
      previousCheckIn: primary.vacatedRange.checkIn,
      currentCheckIn: primary.currentCheckIn,
    },
    dependent,
  );
  return (
    parseDateOnly(target.checkIn).getTime() < primary.currentCheckOut.getTime() &&
    parseDateOnly(target.checkOut).getTime() > primary.currentCheckIn.getTime()
  );
}

/**
 * A booking the offer would move alongside the primary, and what its own move
 * costs.
 *
 * `money` IS NULL ON THE `NO_CAPACITY` ARM, and that is the whole reason this
 * type exists rather than the `BatchModificationResponse` it used to carry. When
 * there are not beds for both, nothing moves — so this booking has no price, and
 * the honest way to say that is the absence of one rather than a zero that looks
 * like a free move.
 */
export type LinkedMoveCandidate<
  TResult extends LinkedMoveSettledBooking = LinkedMoveSettledBooking,
> = {
  stranded: {
    bookingId: string;
    reference: string;
    lodgeName: string;
    nights: string[];
    checkIn: string;
    checkOut: string;
  };
  target: { checkIn: string; checkOut: string };
  money: { priceDiffCents: number; changeFeeCents: number } | null;
  /**
   * The full modification result, kept by the CALLER because it also owes the
   * deferred provider work and the deferred supervision check. This module reads
   * only the money off it, which is why the parameter defaults to the subset.
   */
  result: TResult | null;
};

export function combineLinkedMoveQuote(input: {
  primary: LinkedMoveSettledBooking;
  primaryId: string;
  primaryRange: { checkIn: string; checkOut: string };
  linked: LinkedMoveCandidate[];
  bothChangeFeesCharged: boolean;
  feasibility: LinkedMoveFeasibility;
}): LinkedMoveQuote {
  const linked: LinkedMoveBooking[] = input.linked
    .map((entry) => ({
      bookingId: entry.stranded.bookingId,
      reference: entry.stranded.reference,
      lodgeName: entry.stranded.lodgeName,
      uncoveredNights: entry.stranded.nights,
      currentCheckIn: entry.stranded.checkIn,
      currentCheckOut: entry.stranded.checkOut,
      proposedCheckIn: entry.target.checkIn,
      proposedCheckOut: entry.target.checkOut,
      priceDiffCents: entry.money?.priceDiffCents ?? 0,
      changeFeeCents: entry.money?.changeFeeCents ?? 0,
    }))
    .sort(byBookingId);

  // ON THE `NO_CAPACITY` ARM THE COMBINED FIGURES ARE THE PRIMARY'S OWN, because
  // the only move still on offer is the primary's: the member is being told the
  // two cannot travel together and asked whether to move this one anyway. Summing
  // in a dependent that is not moving would quote them for a move nobody is
  // making. Nothing else in the transaction survives either — the whole probe is
  // discarded — so these are the figures of the single-booking edit they can still
  // choose, which is exactly the decision in front of them.
  const all = [
    input.primary,
    ...input.linked
      .map((entry) => entry.result)
      .filter((result): result is LinkedMoveSettledBooking => result !== null),
  ];
  const sum = (pick: (r: LinkedMoveSettledBooking) => number) =>
    all.reduce((total, result) => total + pick(result), 0);

  return {
    primary: {
      bookingId: input.primaryId,
      reference: formatBookingReference(input.primaryId),
      proposedCheckIn: input.primaryRange.checkIn,
      proposedCheckOut: input.primaryRange.checkOut,
      priceDiffCents: input.primary.priceDiffCents,
      changeFeeCents: input.primary.changeFeeCents,
    },
    linked,
    combinedPriceDiffCents: sum((r) => r.priceDiffCents),
    combinedChangeFeeCents: sum((r) => r.changeFeeCents),
    combinedAmountDueCents: sum((r) => r.additionalAmountCents),
    // A reduction can come back as a card refund OR as account credit, and the
    // member chose once for both. Summing the two is right rather than
    // double-counting: exactly one of them is non-zero per booking, because
    // `calculateModificationSettlementOptions` routes a given reduction down one
    // path or the other, never both.
    combinedRefundCents: sum(
      (r) => r.refundAmountCents + r.accountCreditAmountCents,
    ),
    settlementMethodRequired: all.some(
      (r) => r.refundAmountCents + r.accountCreditAmountCents > 0,
    ),
    // TRUE TO THE MONEY ABOVE, not a separate claim about it: when the club has
    // waived it, the dependent's `modifyBookingBatch` call was given
    // `waiveChangeFee`, so its `changeFeeCents` really is 0 and
    // `combinedChangeFeeCents` really does carry one fee only.
    bothChangeFeesCharged: input.bothChangeFeesCharged,
    feasibility: input.feasibility,
  };
}

/**
 * The stored reason on the incident a declined offer opens (#3232).
 *
 * IT HAS TO STAND ALONE, because for one release it is what an officer reads
 * INSTEAD of a cause label of its own: until `INV-HOST-052`'s runtime half lands
 * the stored cause is the shared `SYSTEM_CHANGE`, whose officer-facing phrase is
 * true of a cancellation and a data correction too. So no issue reference (no
 * other stored human-read string in this repository carries one — compare
 * `ADULT_SUPERVISION_REVIEW_REASON`), and no product jargon: "the linked move" is
 * a name from this codebase that no officer has ever met. What it says instead is
 * what happened.
 */
export const LINKED_MOVE_DECLINED_INCIDENT_REASON =
  "The member was asked whether to move this booking to the same new nights as " +
  "the booking they were editing, and chose to move only that one — leaving " +
  "this booking without adult member coverage.";

/**
 * The 409 that carries the offer.
 *
 * 409 AND NOT 403, for the same reason its two siblings are: the member is
 * permitted to make this change. What conflicts is the state of another booking,
 * and the body is what lets them resolve it.
 *
 * THROWN FROM OUTSIDE THE MUTATION TRANSACTION, which is the one structural
 * difference from `SameOwnerCoverageWouldBreakError`. The hosting engine detects
 * the stranding inside the transaction and rolls it back; the QUOTE then has to be
 * derived by applying both moves and reading the real numbers off the real pricing
 * engine, which is a second transaction that is deliberately rolled back too. An
 * estimate computed a second way would be a second definition of what a date move
 * costs (`INV-SSOT-001`), and it would be the definition the member was shown
 * while the other one charged them.
 */
export class SameOwnerCoverageLinkedMoveRequiredError extends ApiError {
  readonly code = HOSTING_COVERAGE_LINKED_MOVE_CODE;
  readonly quote: LinkedMoveQuote;
  /** Bound to the moves AND the money; the key `MOVE_BOTH` must return. */
  readonly acceptStateKey: string;
  /** Bound to the stranded set alone; the key `LEAVE_UNCOVERED` must return. */
  readonly declineStateKey: string;

  constructor(
    quote: LinkedMoveQuote,
    keys: { acceptStateKey: string; declineStateKey: string },
  ) {
    super(formatLinkedMoveOfferMessage(quote), 409);
    this.name = "SameOwnerCoverageLinkedMoveRequiredError";
    this.quote = quote;
    this.acceptStateKey = keys.acceptStateKey;
    this.declineStateKey = keys.declineStateKey;
  }
}

/**
 * The member-facing body for the offer.
 *
 * SAFE FOR THIS AUDIENCE, AND ONLY BECAUSE THE CALLER PROVED IT. Every booking
 * named here has the same `Booking.memberId` as the one being changed — guaranteed
 * by the predicate that found them — but that does NOT make the list safe to show
 * whoever made the change, and conflating the two is a real disclosure. The offer
 * is raised only where `resolveDependentDisposition` has already established that
 * the acting member IS the booking owner; for any other actor the change escalates
 * instead and the actor is told nothing. That check is this function's
 * precondition and is not re-derivable here.
 *
 * NO PERSON IS NAMED, either way — not the qualifying adult, not a guest. The
 * owner is told which of their bookings, which lodge, which nights and how much,
 * which is exactly what they need to answer the question.
 */
export function buildSameOwnerCoverageLinkedMoveBody(
  error: SameOwnerCoverageLinkedMoveRequiredError,
) {
  const { quote } = error;
  return {
    error: error.message,
    code: error.code,
    details: error.message,
    /** The flag a client keys on to show the offer, rather than matching prose. */
    requiresLinkedMoveChoice: true as const,
    acceptStateKey: error.acceptStateKey,
    declineStateKey: error.declineStateKey,
    linkedMoveAvailable: quote.feasibility === "AVAILABLE",
    feasibility: quote.feasibility,
    primary: quote.primary,
    linkedBookings: quote.linked,
    combinedPriceDiffCents: quote.combinedPriceDiffCents,
    combinedChangeFeeCents: quote.combinedChangeFeeCents,
    combinedAmountDueCents: quote.combinedAmountDueCents,
    combinedRefundCents: quote.combinedRefundCents,
    settlementMethodRequired: quote.settlementMethodRequired,
    bothChangeFeesCharged: quote.bothChangeFeesCharged,
  };
}
