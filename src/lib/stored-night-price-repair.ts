import { isNonNegativeIntegerCents } from "@/lib/cents-schema";
import { formatCents } from "@/lib/utils";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";

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
 *     that leaves the strand inexact, which before #4317 parked the booking
 *     again on its next edit, so the officer's typing bought nothing. The settlement is what moves
 *     what the strand is worth: the officer's figures must come to the stored
 *     total plus or minus exactly the amount being settled. That is the
 *     "reconcile to the agreed total" #3191 asks for, stated as arithmetic a
 *     screen can check before it posts.
 *
 * ## What is left of it (#4344)
 *
 * The two screens that asked an officer for these figures - the review settle
 * dialog and #3214's strand reconcile on the booking's Admin tools card - were
 * retired with the officer review (wave C1). The rules stay because the
 * completion door (`manual-refund-task-resolution.ts`) still holds them until
 * wave C3 removes the review's money path; nothing on a screen calls them now.
 *
 * ## WHY THIS HALF IS CLIENT-SAFE
 *
 * It was split this way while the settle screen applied rule 2 as the officer
 * typed, so the screen and the server ran ONE function (`INV-SSOT`). Nothing
 * here imports `node:`, Prisma, or `@/lib/prisma`; the reads and the writes
 * live in `stored-night-price-repair-plan.ts` and
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

/** One strand's figures on the wire, named by the item's own ordinal. */
export type RecordedStrandNightPrices = {
  strandIndex: number;
  nightPrices: readonly RecordedNightPrice[];
};

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

/** Rule 1, said out loud: a night nobody priced stays unpriced. */
export const NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE =
  "Give an amount for every night listed, or leave them all blank. Nothing here works the missing ones out for you - a night nobody has priced has to stay unpriced.";

export const NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE =
  "One of the nights sent is not one of this booking's unpriced nights. Reload the page and try again.";

export const NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE =
  "Each night's amount must be whole cents and cannot be negative. A free night is 0.00, which is a real price.";

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
  format: ClubFormat,
): string {
  return `These nights come to ${formatCents(enteredCents, format)}, and they need to come to ${formatCents(targetCents, format)} - what this guest's stay is stored as being worth, adjusted by the amount being settled. If the amount being settled is not simply what these nights were worth - a change fee kept back, or a hand-back reduced by policy - no honest set of night prices comes to that figure: clear every box and settle without them, and take the booking coming back here next time as the cost of that. Otherwise correct whichever figure is wrong, the night amounts or the settlement, until the two agree - but do not change a night's price to make the arithmetic work, because a figure typed to close a gap is a price nobody decided.`;
}

/**
 * Rule 2 when no set of prices could satisfy it, which is worth saying plainly.
 *
 * Same third option as above, for the same reason: a negative target cannot be
 * typed away, so leaving the boxes empty is the ONLY honest answer here and the
 * sentence would be a dead end without it.
 */
function nightPriceRepairUnreachableMessage(targetCents: number, format: ClubFormat): string {
  return `The amount being settled would leave these nights worth ${formatCents(targetCents, format)} in total, which cannot be shared out as prices. Check the settlement figure against what this guest's stay is stored as being worth - and if that figure is right, then these nights cannot account for it: clear every box and settle without them.`;
}

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
  format,
}: {
  summary: UnpricedNightsSummary;
  entries: readonly RecordedNightPrice[];
  deltaCents: number;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
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
      message: nightPriceRepairUnreachableMessage(targetCents, format),
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
      message: nightPriceRepairReconcileMessage(targetCents, enteredCents, format),
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
 * IT PROMISES ONLY WHAT THIS TASK CAN DELIVER, and since #3498 what that is
 * DEPENDS ON THE GRAIN THE ITEM WAS RAISED AT. A parked edit that moved at most
 * one guest's nights raises ONE item covering every strand it recorded, so the
 * other guests' blanks are in the next column of this same screen. An edit that
 * moved two or more raises one item per strand, so they are genuinely on their
 * own reviews. `otherStrandsOnThisItem` is how the sentence is told which, and
 * it is an argument rather than a guess because saying the wrong one sends an
 * officer looking for a screen that does not exist - or lets them leave blanks
 * they were told somebody else would be asked about.
 *
 * "The booking stops coming back here" is said in neither case: a strand this
 * item does not name can still park the booking again the next morning, and a
 * promise this epic exists to keep is the worst one to overstate.
 */
/**
 * #3219 D2 (owner, 5 September 2026): THIS SENTENCE IS ALSO THE REFUSAL.
 *
 * The night prices are MANDATORY wherever these boxes are offered - on a
 * dismissal as well as a completion - so `planStoredNightPriceRepair` throws
 * this exact string when a review whose boxes are offered is closed with them
 * blank. One wording, said once (`INV-SSOT`): the officer was already warned in
 * these words at the moment of decision, and a second sentence at the point of
 * refusal would be the same rule stated twice with nothing comparing them.
 *
 * The earlier version of this paragraph ended "leave them blank and it is sent
 * for review again the next time anybody changes it". That was true before D2
 * and is false after it - the review cannot be closed blank at all - so it moved
 * rather than gaining a second clause beside it.
 */
export function unpricedNightsExplanation(
  summary: UnpricedNightsSummary,
  {
    otherStrandsOnThisItem,
  }: {
    /**
     * How many OTHER guest strands this same work item names. Zero on a
     * single-strand item - a genuinely one-guest edit, or one of the items a
     * multi-mover edit fans out into.
     */
    otherStrandsOnThisItem: number;
  },
): string {
  const count = summary.dates.length;
  const elsewhere =
    otherStrandsOnThisItem > 0
      ? `The ${otherStrandsOnThisItem === 1 ? "other guest" : "other guests"} this change touched ${otherStrandsOnThisItem === 1 ? "is" : "are"} on this same review: any unpriced nights of theirs are asked about beside these, and all of it is recorded together.`
      : "If another guest on the same booking also has unpriced nights, they are asked about separately, on their own review.";
  return `${count === 1 ? "One night" : `${count} nights`} on this guest's stay ${count === 1 ? "has" : "have"} no stored price, which is why this change could not be worked out automatically. Say what each one sold for: this review cannot be closed - settled or dismissed - until they are recorded, because without them this booking's own price cannot be brought back into line with its nights. ${elsewhere} Nothing is filled in for you - an amount nobody decided is exactly what this review exists to avoid.`;
}
