import { z } from "zod";

import {
  calendarDateSchema,
  isNonNegativeIntegerCents,
  nonNegativeCentsSchema,
  type EditFinancialReviewCause,
} from "@/lib/edit-financial-review-context";
import { formatCents } from "@/lib/utils";
import { formatClubDate, type CalendarDate } from "@/lib/club-time";

/**
 * #3191 (epic #2797): the RULE for filling in a night whose sold price is not
 * known, and the only definition of it.
 *
 * ## What this is for
 *
 * #3170 made `BookingGuestNight.priceCents` nullable so a parked edit could
 * commit the beds without inventing money, and a NULL is the column saying "what
 * this night sold for is NOT KNOWN". Nothing could ever fill one in again, so a
 * booking parked once parked forever: every later edit read the same absent
 * evidence and went back to a person. The owner's 31 Aug 2026 decision on #3191
 * is that SETTLING THE REVIEW records the per-night amounts, because that is the
 * moment a person is already deciding what the money is.
 *
 * ## The two rules this file is the home of, and why they are one file
 *
 *  1. **Every blank is typed by a person, or none of them are.** `INV-MOD-028`
 *     prohibits deriving a historical amount from current rates, an average, a
 *     proportional estimate or an even split. So a partial vector is REFUSED
 *     rather than completed: there is no rule in this module that could fill a
 *     date the officer did not type, and `checkStoredNightPriceRepair` demands
 *     that the entry dates equal the blank dates as a SET.
 *  2. **The typed nights must reconcile.** A strand is exactly priced when every
 *     night it holds carries usable integer cents and those sum to
 *     `BookingGuest.priceCents` (`INV-MOD-028`). A repair that does not satisfy
 *     that leaves the strand inexact, so the booking parks again on the next
 *     edit and the officer's typing bought nothing. The settlement is what moves
 *     what the strand is worth: the officer's figures must come to the stored
 *     total plus or minus exactly the amount being settled. That is the
 *     "reconcile to the agreed total" #3191 asks for, stated as arithmetic a
 *     screen can check before it posts.
 *
 * ## The SECOND rule this module is the home of (#3214)
 *
 * Rule 2 above reconciles a strand while a review is being settled. #3214 adds
 * the only other act that may write a night price, and it is deliberately the
 * same arithmetic with both variable parts set to zero:
 *
 * > An officer may record what a guest strand's nights sold for **on a strand
 * > whose stored rows do not reconcile**. They must give an amount for **every
 * > night the strand holds**, and those amounts must come to exactly
 * > `BookingGuest.priceCents` **as stored**. Nothing is derived and nothing is
 * > defaulted; the strand's total is not changed. The act can turn an unreadable
 * > strand into a readable one and can do nothing else.
 *
 * THE SAFETY IS ARITHMETIC, NOT POLICY, and that is why it needs no new rule
 * here. {@link checkStoredNightPriceRepair} run with `knownNightTotalCents: 0`
 * and `deltaCents: 0` forces `sum(entries) === storedGuestTotalCents`, and the
 * writer re-bases the total to `0 + sum(entries)` - the same number. So the
 * total write is provably a no-op and the officer cannot re-price anybody,
 * whatever they type. `stored-night-price-repair-store.ts` holds the eligibility
 * fence that keeps the act off a strand which already reconciles, and
 * `stored-night-price-strand-reconcile.test.ts` pins both properties.
 *
 * ## WHY THIS HALF IS CLIENT-SAFE
 *
 * The same split `edit-financial-review-context.ts` records for itself, for the
 * same reason: the settle screen is a client component and has to apply rule 2
 * as the officer types, or they learn their figures do not add up only after
 * posting them at a task that is about to be claimed. If the screen applied its
 * own copy of the arithmetic the two could disagree, and only the server's
 * matters - so there is ONE function and both call it (`INV-SSOT`). Nothing here
 * imports `node:`, Prisma, or `@/lib/prisma`; the reads and the writes live in
 * `stored-night-price-repair-store.ts`.
 */

/**
 * What an admin surface is told about a review's unpriced nights.
 *
 * A PROJECTION, exactly like `EditFinancialReviewEvidence` beside it: the guest
 * strand's id has no field here, so no payload can carry it. The dates and the
 * two totals are money facts about a task whose amount the same screen already
 * shows, and the server re-derives the strand from the task's own stored context
 * when the figures come back - so the browser never needs to name the strand,
 * and therefore never may.
 *
 * NULL, on the payload carrying this, means "there is nothing this screen can
 * repair", which is the ordinary case: a removal park deletes the strand
 * outright, and a `COUNTERPART_STRAND_UNREADABLE` task names a strand whose own
 * rows are already complete.
 */
export type UnpricedNightsSummary = {
  /** The lodge nights this strand holds whose stored price is blank, sorted. */
  dates: readonly CalendarDate[];
  /**
   * What the strand's ALREADY-PRICED nights come to. Part of the arithmetic
   * rather than decoration: the blanks have to make up the difference between
   * this and the strand's total, so a screen that did not show it would be
   * asking for figures against a target nobody could see.
   */
  knownNightTotalCents: number;
  /** `BookingGuest.priceCents` as stored - the total the repair reconciles to. */
  storedGuestTotalCents: number;
};

/**
 * What ONE guest strand is offered when its stored rows cannot be read back
 * (#3214), and the one definition of that shape.
 *
 * HERE, IN THE CLIENT-SAFE HALF, because the booking page reads it on the server
 * and hands it to a client component as a prop. Declaring it twice - once
 * server-side and once as the component's prop type - is exactly the "cannot
 * change a fact in one place" defect `INV-SSOT` names, and the two copies would
 * drift the first time a field was added.
 *
 * `summary` is the SAME shape the settle screen fills in, built for this mode:
 * `dates` is every night the strand holds rather than only its blanks, and
 * `knownNightTotalCents` is 0, because nothing on the strand is being treated as
 * already known. That is what turns {@link checkStoredNightPriceRepair} into
 * "type every night, and come to the stored total" with no second rule written
 * anywhere.
 */
export type StrandNightPriceOffer = {
  bookingGuestId: string;
  guestName: string;
  /** Why the stored evidence cannot be read, in the closed admin vocabulary. */
  cause: EditFinancialReviewCause;
  summary: UnpricedNightsSummary;
  /**
   * What is on file for each night now, for DISPLAY beside the boxes.
   *
   * An array rather than a `Map` because it crosses the server-to-browser
   * boundary and a `Map` does not serialise. `null` means the night carries no
   * usable stored price - no row, or a row whose value is not money - which is
   * the collapse `storedNightPricesByKey` makes and is right for a reader. The
   * WRITER needs the raw value and reads it separately, server-side.
   */
  storedByDate: ReadonlyArray<{ date: CalendarDate; priceCents: number | null }>;
};

/**
 * One night the officer priced, as it arrives from the screen.
 *
 * There is no "and work the rest out" variant of this shape, and that absence is
 * the `INV-MOD-028` guard in its cheapest form: a caller cannot ask for a
 * derivation because there is nothing to ask with (`INV-SSOT`: prefer
 * unrepresentable over policed).
 */
export type RecordedNightPrice = {
  date: CalendarDate;
  priceCents: number;
};

/**
 * The same shape at the HTTP boundary, and the one definition of it.
 *
 * `.strict()` so an extra field - a "split the rest evenly" flag, a derived
 * total - cannot be smuggled past the type into a body this module never agreed
 * to. The cents rule and the calendar-date rule are both the shared ones rather
 * than re-spelled here (`INV-SSOT`, #3030).
 *
 * The length cap is a BOUND, not a rule about bookings: one guest strand cannot
 * hold more nights than a year has, and an unbounded array on an authenticated
 * write is work a request can ask for without paying for. The real check is
 * `checkStoredNightPriceRepair`, which requires the dates to equal the strand's
 * blanks exactly.
 */
export const recordedNightPricesSchema = z
  .array(
    z
      .object({ date: calendarDateSchema, priceCents: nonNegativeCentsSchema })
      .strict(),
  )
  .max(370);

/**
 * WHICH WAY the settled amount moves what this strand is worth.
 *
 * The same two strings as `ManualRefundTaskDirection`, spelled as a union so
 * this module stays client-safe - the Prisma enum's members are exactly these
 * literals, so a server caller passes its enum value straight in.
 */
export type SettlementDirectionValue = "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER";

/**
 * What the settlement does to what this strand is worth, in signed cents.
 *
 * The club handing money back means the stay is worth LESS than the stored total
 * says; the member being asked for money means it is worth MORE. A dismissal
 * moves no money, so it moves no total either, and the officer's figures then
 * have to come to the stored total exactly.
 *
 * THE SIGN LIVES HERE AND NOWHERE ELSE. Every amount on this path is a positive
 * magnitude with an explicit direction beside it (#3170), so this is the one
 * place the two become a signed number - a second site deciding it for itself is
 * how a refund ends up added to a total instead of taken off it.
 */
export function settlementDeltaCents(
  settled: { direction: SettlementDirectionValue; amountCents: number } | null,
): number {
  if (settled === null) return 0;
  return settled.direction === "CHARGE_TO_MEMBER"
    ? settled.amountCents
    : -settled.amountCents;
}

/**
 * What the blanks must add up to, in cents.
 *
 * CAN BE NEGATIVE, and the caller renders that rather than clamping it: a refund
 * larger than everything this strand's unpriced nights could be worth means the
 * officer's amount and the booking's stored history disagree, which is a real
 * finding and not a number to floor at zero.
 */
export function unpricedNightTargetCents(
  summary: UnpricedNightsSummary,
  deltaCents: number,
): number {
  return (
    summary.storedGuestTotalCents + deltaCents - summary.knownNightTotalCents
  );
}

/**
 * The task is not a financial review, or its stored evidence does not say which
 * guest strand it is about. Either way there is no strand whose blanks these
 * figures could belong to, and guessing one is not on the table.
 */
export const NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE =
  "This task is not linked to a guest whose nights could be priced, so per-night amounts cannot be recorded against it. Settle it without them.";

/**
 * There is nothing on this review that recording per-night amounts could fix.
 *
 * IT ENDS BY SAYING WHAT TO DO, because the server raises it at 409 - what this
 * page was shown is no longer what the booking says. Its two sibling race
 * refusals both say "reload"; without that this one reads as a permanent
 * property of the task, and the officer retries the same figures until they
 * happen to reload of their own accord.
 *
 * IT NAMES NO CAUSE, and that is deliberate (#3191 fix round). SIX states raise
 * it: the guest strand is gone, it has no night rows, one of its nights has a
 * key this code cannot read, a stored price is negative or fractional, the
 * stored total is not usable money, or there are genuinely no blanks left. An
 * earlier draft said "somebody may have priced them since this page was loaded",
 * which is true of exactly one of the six and reads as a diagnosis in the other
 * five. The advice is right in all six, so the sentence gives that and stops.
 */
export const NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE =
  "This review has no unpriced nights for these amounts to belong to, so they cannot be recorded against it. Reload the page and settle it without them.";

/**
 * #3214's three refusals, which are about WHEN this act is available rather than
 * about what was typed. Here, beside the settle path's own refusals, because
 * they are the same feature's copy and a screen and a server describing one
 * behaviour in two places drift (`INV-SSOT`).
 */

/**
 * WHAT THE CONTROL IS CALLED, in one place (#3214, `INV-SSOT`).
 *
 * Two production strings say this name and they have to agree: the button
 * itself, on the booking's Admin tools card, and
 * `OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE` in
 * `booking-other-lodge-rate.ts`, whose refusal sends the officer to find the
 * control BY NAME. A rename that
 * moved only one of them would send them hunting for a control that does not
 * exist - which is the exact failure that message was rewritten to fix, so it
 * is not a hypothetical drift. Interpolated into the message rather than typed
 * into it, so the two cannot disagree.
 *
 * This module is the client-safe home both sites already import, which is why
 * the name lives here rather than beside either of them.
 */
export const STORED_NIGHT_PRICE_RECORD_CONTROL_LABEL =
  "Record what these nights sold for";

/**
 * The strand named is not this booking's, or neither exists.
 *
 * ONE SENTENCE FOR BOTH, deliberately, and answered at 404. Telling an officer
 * whether a guest strand exists on some OTHER booking is a fact about a booking
 * this request has not been authorised against, and it is a fact this refusal
 * has no use for.
 */
export const STRAND_RECONCILE_WRONG_BOOKING_MESSAGE =
  "That guest is not on this booking, so there are no nights here to record prices against. Reload the page and try again.";

/**
 * The booking is waiting on a review, and that screen owns these figures.
 *
 * NOT A PERMANENT PROPERTY, and it says so, because the officer's next act is
 * the one that clears it: the review's own screen asks for the same per-night
 * amounts against a target that ALSO includes what is being settled. Two
 * surfaces asking for one set of figures against two different targets is how an
 * officer records a set that the other one refuses.
 */
export const STRAND_RECONCILE_REVIEW_OPEN_MESSAGE =
  "This booking has an amount waiting for the office to confirm, and that job asks for these same night prices as part of settling it. Settle it first, on the refunds and adjustments queue, and record anything still missing here afterwards.";

/**
 * There is nothing on this strand for this act to record.
 *
 * IT NAMES NO CAUSE, for the reason {@link
 * NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE} gives at length: three quite
 * different states raise it - the strand's nights already add up to what the
 * stay is stored as being worth, the strand holds no nights at all, or what the
 * stay is stored as being worth is not an amount this can reconcile to - and the
 * advice is the same in all three. Answered at 409 because what the page was
 * shown is no longer what the booking says.
 */
export const STRAND_RECONCILE_NOT_OFFERED_MESSAGE =
  "There is nothing to record against this guest's nights. Either they already add up to what the stay is stored as being worth, or what is stored is not an amount anything can be reconciled to. Reload the page to see where this booking stands.";

/** Rule 1, said out loud: a night nobody priced stays unpriced. */
export const NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE =
  "Give an amount for every night listed, or leave them all blank. Nothing here works the missing ones out for you - a night nobody has priced has to stay unpriced.";

export const NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE =
  "One of the nights sent is not one of this booking's unpriced nights. Reload the page and try again.";

export const NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE =
  "Each night's amount must be whole cents and cannot be negative. A free night is 0.00, which is a real price.";

/**
 * A box holding something that is not an amount at all, naming which box.
 *
 * IT CANNOT BE ASKED FOR AN EMPTY LIST (#3191 fix round). Handed one it rendered
 * "The amounts for  are not ones these boxes can read." Nothing reaches it that
 * way today - the caller only builds this branch when a box failed to parse -
 * but a required first date makes that sentence unwritable rather than policed
 * (`INV-SSOT`: prefer unrepresentable over policed).
 *
 * A DIFFERENT REFUSAL FROM THE ONE ABOVE, and from the incomplete one, because
 * it is a different mistake. `parseDecimalDollarsToCents` answers `null` for
 * "1,200.00", "$45", "45." and a stray letter alike, and a caller that treats
 * that `null` as "not typed" hands the officer "give an amount for every night"
 * over boxes that visibly all hold one - the #2685 class the money parser's own
 * docblock warns about. Naming the night is the whole value of it: the officer
 * is looking at a column of figures, and "one of these is wrong" is not a
 * finding they can act on.
 */
export function nightPriceRepairUnreadableMessage(
  dates: NonEmptyDates,
): string {
  const listed = dates.map((date) => formatClubDate(date)).join(", ");
  return dates.length === 1
    ? `The amount for ${listed} is not one this box can read. Give it as dollars and cents - 45.00 - with no currency sign, comma or minus sign.`
    : `The amounts for ${listed} are not ones these boxes can read. Give each as dollars and cents - 45.00 - with no currency sign, comma or minus sign.`;
}

/**
 * Rule 2's refusal, which has to say what the figures should come to - AND that
 * not answering at all is a real third option.
 *
 * The two obvious ways out are arithmetically forced, and on a settlement that
 * is not simply a restatement of what the nights were worth they are both
 * WRONG. A hand-back reduced by an admin fee, or a change fee kept back, leaves
 * a target that no honest set of night prices comes to - so an officer steered
 * only towards "change the night amounts" closes the gap by typing a figure
 * that reconciles and is false, which is precisely the unprovenanced number
 * epic #2797 exists to remove. `docs/guides/payments.md` says leaving them all
 * blank is fine and why; the sentence read at the moment of refusal has to say
 * it too, because that is where the decision is actually made.
 *
 * WHICH IS WHY IT LEADS WITH THAT (#3191 fix round) rather than reaching it 200
 * characters in. The earlier order opened with "change the night amounts, or the
 * settlement figure" and put the honest answer at the end of a 480-character
 * paragraph rendered in `text-xs` - so the officer facing exactly the case this
 * sentence was extended for was told FIRST to do the thing that produces a false
 * price. `docs/guides/payments.md` leads with the opposite emphasis, and the
 * screen and the guide have to agree on the one sentence this half exists for.
 * The guide's corrective - do not change a night's price to make the arithmetic
 * work - is now attached to the "otherwise" branch, where it is read by the
 * officer it is addressed to.
 */
function nightPriceRepairReconcileMessage(
  targetCents: number,
  enteredCents: number,
): string {
  return `These nights come to ${formatCents(enteredCents)}, and they need to come to ${formatCents(targetCents)} - what this guest's stay is stored as being worth, adjusted by the amount being settled. If the amount being settled is not simply what these nights were worth - a change fee kept back, or a hand-back reduced by policy - no honest set of night prices comes to that figure: clear every box and settle without them, and take the booking coming back here next time as the cost of that. Otherwise correct whichever figure is wrong, the night amounts or the settlement, until the two agree - but do not change a night's price to make the arithmetic work, because a figure typed to close a gap is a price nobody decided.`;
}

/**
 * Rule 2 when no set of prices could satisfy it, which is worth saying plainly.
 *
 * Same third option as above, for the same reason: a negative target cannot be
 * typed away, so leaving the boxes empty is the ONLY honest answer here and the
 * sentence would be a dead end without it.
 */
function nightPriceRepairUnreachableMessage(targetCents: number): string {
  return `The amount being settled would leave these nights worth ${formatCents(targetCents)} in total, which cannot be shared out as prices. Check the settlement figure against what this guest's stay is stored as being worth - and if that figure is right, then these nights cannot account for it: clear every box and settle without them.`;
}

/**
 * At least one date. The argument shape of the refusal above, so a caller cannot
 * ask it to name a night it has not got.
 */
export type NonEmptyDates = readonly [CalendarDate, ...CalendarDate[]];

/**
 * The verdict on one proposed repair.
 *
 * Carries the entries back on success rather than a bare boolean, so the writer
 * writes what was checked instead of re-deriving it beside the check.
 */
export type StoredNightPriceRepairCheck =
  | { ok: true; entries: readonly RecordedNightPrice[]; targetCents: number }
  | { ok: false; message: string; targetCents: number };

/**
 * The ONE application of both rules - run by the settle screen as the officer
 * types, and again by the server before anything is claimed.
 */
export function checkStoredNightPriceRepair({
  summary,
  entries,
  deltaCents,
}: {
  summary: UnpricedNightsSummary;
  entries: readonly RecordedNightPrice[];
  deltaCents: number;
}): StoredNightPriceRepairCheck {
  const targetCents = unpricedNightTargetCents(summary, deltaCents);

  if (summary.dates.length === 0) {
    return {
      ok: false,
      message: NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
      targetCents,
    };
  }

  // Rule 1, and the whole of it. A date the officer did not type is a date this
  // module has no value for, and the only two answers are "refuse" and "invent
  // one" - `INV-MOD-028` forbids the second outright. Checked as a SET in both
  // directions, so a repeated date cannot stand in for a missing one.
  const blanks = new Set<string>(summary.dates);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!blanks.has(entry.date)) {
      return {
        ok: false,
        message: NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE,
        targetCents,
      };
    }
    if (seen.has(entry.date)) {
      return {
        ok: false,
        message: NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
        targetCents,
      };
    }
    seen.add(entry.date);
    if (!isNonNegativeIntegerCents(entry.priceCents)) {
      return {
        ok: false,
        message: NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE,
        targetCents,
      };
    }
  }
  if (seen.size !== blanks.size) {
    return {
      ok: false,
      message: NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
      targetCents,
    };
  }

  if (targetCents < 0) {
    return {
      ok: false,
      message: nightPriceRepairUnreachableMessage(targetCents),
      targetCents,
    };
  }

  // Rule 2. Summed from the typed entries, never from the target - the target is
  // what they are checked AGAINST, and a check that computed one side from the
  // other would pass for every input.
  let enteredCents = 0;
  for (const entry of entries) {
    enteredCents += entry.priceCents;
  }
  if (enteredCents !== targetCents) {
    return {
      ok: false,
      message: nightPriceRepairReconcileMessage(targetCents, enteredCents),
      targetCents,
    };
  }

  return { ok: true, entries, targetCents };
}

/**
 * The paragraph the settle screen prints above the per-night boxes.
 *
 * Here rather than in the component because it states a RULE - what filling
 * these in does, and what leaving them costs - and the refusals above are about
 * that same rule. A screen and a server describing one behaviour in two places
 * drift (`INV-SSOT`).
 *
 * IT PROMISES ONLY WHAT THIS TASK CAN DELIVER. One edit raises one review task
 * per unreadable guest strand, so a booking with two of them gets two tasks and
 * these boxes cover ONE of them. "The booking stops coming back here" would
 * therefore be a false receipt on exactly the booking whose second strand parks
 * it again the next morning - and a promise this epic exists to keep is the
 * worst one to overstate.
 */
export function unpricedNightsExplanation(
  summary: UnpricedNightsSummary,
): string {
  const count = summary.dates.length;
  return `${count === 1 ? "One night" : `${count} nights`} on this guest's stay ${count === 1 ? "has" : "have"} no stored price, which is why this change could not be worked out automatically. Say what each one sold for and this guest's nights stop sending the booking back here; leave them blank and it is sent for review again the next time anybody changes it. If another guest on the same booking also has unpriced nights, they are asked about separately, on their own review. Nothing is filled in for you - an amount nobody decided is exactly what this review exists to avoid.`;
}

/**
 * The paragraph above the boxes when an officer is RECONCILING a strand rather
 * than settling a review (#3214).
 *
 * A SECOND SENTENCE FOR A SECOND ACT, not a reword of
 * {@link unpricedNightsExplanation}, because three of the four things it has to
 * say are different. This mode asks for EVERY night rather than only the blanks,
 * including nights that already show a figure; the target is the stored total
 * flat, with no settlement moving it; and the reason to say so is that this is
 * the one property that makes the act safe - an officer who did not know the
 * figures have to come to what is already on file could believe they were
 * setting a new price for the stay.
 *
 * IT PROMISES ONLY WHAT THIS STRAND CAN DELIVER, exactly as its sibling does: a
 * booking with two unreadable strands is two of these, and recording one of them
 * does not stop the other sending the booking back for review.
 *
 * Here rather than in the component for the reason the whole module exists: the
 * screen and the server describe one rule, so there is one place it is written
 * (`INV-SSOT`).
 */
export function unreconciledStrandExplanation(
  summary: UnpricedNightsSummary,
): string {
  const count = summary.dates.length;
  const subject =
    count === 1 ? "the one night on this guest's stay" : `all ${count} nights on this guest's stay`;
  return `What is on file for this guest's stay cannot be read back as a set of night prices, which is why every change to this booking has to be worked out by hand. Say what ${subject} sold for - every one of them, including any that already show a figure - and they have to come to ${formatCents(summary.storedGuestTotalCents)}, which is what this guest's stay is stored as being worth. That figure does not move: this records how the stay's price was made up, night by night, and it cannot change what anybody owes. Nothing here works an amount out for you. Once they add up, this guest's nights stop sending the booking back for review; another guest on the same booking is asked about separately.`;
}
