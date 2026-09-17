import "server-only";
import { ManualRefundTaskKind, Prisma } from "@prisma/client";

import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  editFinancialReviewStrandMovesNights,
  editFinancialReviewStrandRecords,
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import type { EditFinancialReviewStrandRecord } from "@/lib/edit-financial-review-context";
import { getExplicitGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  checkStoredNightPriceRepair,
  unpricedNightsExplanation,
  settlementDeltaCents,
  NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
  NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE,
  type RecordedNightPrice,
  type SettlementDirectionValue,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";

/**
 * #3191/#3498 (epic #2797): WHICH STRANDS a review's settle screen may fill in,
 * and WHETHER what the officer typed is allowed to be written.
 *
 * ## Why this is its own module
 *
 * `stored-night-price-repair-store.ts` was the reads AND the writes, and #3498
 * pushed it past its size budget by making both halves plural: one work item now
 * covers the whole parked edit, so a settle reads every strand it names and can
 * repair several of them. The seam is the one that module's own docblock already
 * draws twice - the RULES are in `stored-night-price-repair.ts`, the WRITES are
 * the store's - and this is the third: what may be written, and against what.
 *
 * Everything here runs BEFORE the completion's status claim, on the caller's
 * transaction, so a refusal from any of it leaves the task OPEN and still
 * holding its money question. That boundary is the whole reason the reads are
 * separable from the writes: they are on opposite sides of the claim.
 *
 * Nothing here writes a row and nothing here derives a night price
 * (`INV-MOD-028`); `stored-night-price-repair-census.test.ts` scans this file
 * alongside the rest of the feature and would fail if either changed.
 */

/** The night rows and the total this module reads off a guest strand. */
export type RepairableGuest = {
  id: string;
  priceCents: number;
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
};

export const GUEST_SELECT = {
  id: true,
  priceCents: true,
  nights: { select: { stayDate: true, priceCents: true } },
} as const;

/**
 * Can this strand's blanks be filled in at all, and against what?
 *
 * `null` on every strand where the answer is no, and the settle path then
 * behaves exactly as it did before #3191. The conditions are not defensive
 * padding - each one is a case where filling the blanks would NOT stop the
 * booking parking, so offering the work would be a false promise:
 *
 *  - **no explicit night rows.** `getGuestBedNightKeys` falls back to the stay
 *    envelope for such a strand, so the nights it holds are not rows there is
 *    anything to update. Creating rows is a different act from filling one in,
 *    and it is not what #3191 decided.
 *  - **no blank row.** Nothing to repair. A `COUNTERPART_STRAND_UNREADABLE`
 *    task names a strand whose own rows are complete, and this is what makes the
 *    screen stay silent on one.
 *  - **a row that is neither blank nor usable money** - a negative or fractional
 *    stored price. `INV-MOD-028` classes those as an absence of usable evidence
 *    too, but they are not `NULL`, so this path's fence cannot touch them and
 *    the strand would still not reconcile afterwards. Repairing them is #2745's
 *    audited decision, not this one's.
 *  - **a stored total that is not usable money**, for the same reason: there
 *    would be nothing sound to reconcile against.
 */
export function unpricedNightsSummaryForGuest(
  guest: RepairableGuest,
): UnpricedNightsSummary | null {
  if (!isNonNegativeIntegerCents(guest.priceCents)) return null;
  if (guest.nights.length === 0) return null;

  const blanks: CalendarDate[] = [];
  let knownNightTotalCents = 0;
  for (const night of guest.nights) {
    // Keyed through the canonical helper, one row at a time, exactly as
    // `storedNightPricesByKey` does - a price keyed even slightly differently
    // from its night would never match it, and the failure would be silent
    // (INV-DATE-020). The strict NULL test is what that projection deliberately
    // collapses and this one needs: an absent price and an unusable one are the
    // same thing to a READER, and completely different things to a writer whose
    // whole safety rests on a `priceCents: null` fence.
    //
    // AND THE KEY IT RETURNS IS THE ONE THAT IS KEPT. It was computed here,
    // used as a guard and then thrown away, with a second conversion of the
    // same `stayDate` pushed in its place - two derivations that agree only
    // because the canonical one happens to run first and throw on a non-midnight
    // instant. Delete the apparently-unused call, as a later reader reasonably
    // would, and what is left is an unguarded conversion: exactly the silent
    // `INV-DATE-020` failure the paragraph above warns about.
    const [key] = getExplicitGuestBedNightKeys({ nights: [night] }) ?? [];
    if (key === undefined) return null;
    if (night.priceCents === null) {
      blanks.push(requireCalendarDate(key));
      continue;
    }
    if (!isNonNegativeIntegerCents(night.priceCents)) return null;
    knownNightTotalCents += night.priceCents;
  }

  if (blanks.length === 0) return null;

  return {
    dates: blanks.sort(),
    knownNightTotalCents,
    storedGuestTotalCents: guest.priceCents,
  };
}

/**
 * EVERY strand one review task is about, lead first, or empty when it names none
 * readably.
 *
 * A LIST SINCE #3498, where it was one id. Owner decision D1 moved the work item
 * to the grain of the EDIT, so one item can name the whole party - and the price
 * boxes have to follow it there. Before this the seven items a seven-guest
 * removal raised each offered their own strand's blanks; collapsing to one item
 * that offered only the lead strand's would have quietly taken the other six
 * strands' repair away, and with it the booking's chance of ever reconciling
 * again.
 *
 * THE RECORDS, not the ids, since the fix round: whether the settled amount may
 * move a strand's stored worth depends on whether the edit MOVED that strand's
 * nights, and the ids cannot answer that. Reading the field off the record the
 * item already stores is what keeps the browser, the settle path and the raise
 * on one answer (`INV-SSOT`).
 *
 * ORDER IS THE OCCURRENCE'S OWN and is what the settle path binds the officer's
 * figures to positionally, so it must not be re-sorted here.
 * `editFinancialReviewStrandRecords` is the one place that order is decided.
 */
export function reviewTaskStrands(task: {
  kind: ManualRefundTaskKind | string | null;
  reviewContext: unknown;
}): readonly EditFinancialReviewStrandRecord[] {
  if (task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) return [];
  const context = parseEditFinancialReviewContext(task.reviewContext);
  if (!context) return [];
  return editFinancialReviewStrandRecords(context.occurrence);
}

/**
 * The summary for one task's strand, read on the caller's own transaction.
 *
 * Read INSIDE the completion transaction rather than trusted from the browser,
 * because what the screen was shown may be minutes old: the blanks it lists are
 * re-derived here and the officer's entries are checked against THESE dates.
 */
export async function loadUnpricedNightsSummaries({
  strands,
  store,
}: {
  strands: readonly EditFinancialReviewStrandRecord[];
  store: Prisma.TransactionClient;
}): Promise<RepairableStrand[]> {
  if (strands.length === 0) return [];
  const guests = await store.bookingGuest.findMany({
    where: {
      id: { in: [...new Set(strands.map((s) => s.bookingGuestId))] },
    },
    select: GUEST_SELECT,
  });
  return repairableStrands(
    strands,
    new Map(guests.map((guest) => [guest.id, guest])),
  );
}

/**
 * THE ONE definition of which strands a settle may fill in, in what order, and
 * which of them the settled amount moves (`INV-SSOT`, #3498).
 *
 * IN THE TASK'S OWN STRAND ORDER, and the filter is what makes the result a
 * contract rather than a lookup: the officer is offered exactly these, in this
 * order, and sends their figures back in the same order. A strand that is not
 * repairable simply is not in the list, on the screen or in the request, so the
 * two cannot disagree about which box belongs to which guest.
 *
 * TWO CALLERS, WHICH IS WHY IT IS A FUNCTION. The settle path reads one task
 * inside its own transaction; the finance queue reads a whole page of them in
 * one query and cannot use that read. What they must not do is answer the
 * `absorbsSettlement` question twice — the browser applies it to decide what
 * each column of boxes has to come to, and the server applies it again to decide
 * whether to accept them, so two spellings of it is a screen that enables a
 * button the server refuses, or refuses one it would have taken.
 */
export function repairableStrands(
  strands: readonly EditFinancialReviewStrandRecord[],
  guestById: ReadonlyMap<string, RepairableGuest>,
): RepairableStrand[] {
  return strands.flatMap((strand, index) => {
    const guest = guestById.get(strand.bookingGuestId);
    if (!guest) return [];
    const summary = unpricedNightsSummaryForGuest(guest);
    if (!summary) return [];
    return [
      {
        bookingGuestId: strand.bookingGuestId,
        strandIndex: index,
        summary,
        /*
          TWO CONDITIONS, AND BOTH ARE MONEY.

          `index === 0` is the LEAD strand of the occurrence - the strand the
          item is about - and is not the same as the first strand with blanks;
          `RepairableStrand.absorbsSettlement` sets out the removal shape where
          the difference moves a stranger's stay by somebody else's money.

          The second condition is the one the fix round added, and it is what
          keeps a PURE GUEST ADD honest. Such an edit moves no existing strand's
          nights at all: it ranks every strand at 2, so the lead is an untouched
          guest who may perfectly well have blanks - and making THOSE blanks come
          to their stored total plus the charge for two newly-added guests would
          write the new party's money onto an old strand's nights. A strand the
          edit never moved is worth exactly what it was worth.
        */
        absorbsSettlement:
          index === 0 && editFinancialReviewStrandMovesNights(strand),
      },
    ];
  });
}

/** One strand of a review whose blanks this screen can offer to fill in. */
export type RepairableStrand = {
  bookingGuestId: string;
  /**
   * WHICH strand of the item this is, counted over every strand the item names
   * rather than over the repairable subset (#3498 fix round).
   *
   * It is the ONE ordinal on this screen, and it has to be: the card heads its
   * evidence blocks by position over ALL strands, and legends its price boxes by
   * position over the REPAIRABLE ones. Two index spaces on one card is how
   * "Guest 3 of 6" appeared above boxes belonging to the guest the evidence
   * block called "Guest 4 of 7" - and on the canonical parked removal the lead
   * is the departing guest, who has no blanks at all, so every column was off by
   * one. The payload carries no guest id (`toEditFinancialReviewEvidence`), so
   * the ordinal IS the guest's identity here.
   *
   * A POSITION, not an identifier: it names nothing outside this one item.
   */
  strandIndex: number;
  summary: UnpricedNightsSummary;
  /**
   * Whether the amount being SETTLED moves what this strand is worth (#3498).
   *
   * True for at most one strand of an item: the one the item LEADS with, and
   * only when this edit actually MOVED that strand's nights. Everything else
   * must come to its own stored total exactly, which is #3214's arithmetic
   * with both variable parts at zero.
   *
   * "At most one" is a property of the GRAIN rather than a rule policed here:
   * `parkedEditWorkItems` fans an edit out into one item per strand the moment
   * two strands' night sets move, precisely so that one item never has two
   * strands with a claim on one settled amount.
   *
   * IT IS NOT "the first strand with blanks", and the difference is money. The
   * shape that separates them is the ordinary parked removal: the departing
   * guest leads because their nights are what moved, their own rows read
   * perfectly so they have no blanks at all, and a REMAINING guest nobody
   * touched is the first strand with any. Making that guest's nights come to
   * their total plus the refund would move a stranger's stay by the amount of
   * somebody else's — silently, and against the figure a later part-refund is
   * worked out from.
   *
   * FALSE FOR EVERY STRAND is therefore an ordinary answer, and it is exactly
   * what happened before #3498 on such a task: the lead strand offered no boxes,
   * so the settled amount moved no strand's stored worth and the booking's
   * re-price summed the strands as they stood.
   */
  absorbsSettlement: boolean;
};

/**
 * The race refusal. It is a 409 rather than a 400 because nothing the officer
 * typed is wrong - the booking moved underneath them - and because the caller's
 * transaction rolls back with it, so the task is still OPEN when they retry.
 */
export const NIGHT_PRICE_REPAIR_RACED_MESSAGE =
  "This booking's stored night prices changed while you were recording them, so nothing was saved. Reload the page and check the booking before trying again.";

/** One checked repair, ready to write once the task has been claimed. */
export type StoredNightPriceRepairPlan = {
  bookingGuestId: string;
  summary: UnpricedNightsSummary;
  entries: readonly RecordedNightPrice[];
};

/**
 * Turn what the officer typed into a plan, or throw the refusal that stops the
 * settle.
 *
 * MUST run BEFORE the caller's status claim and on its transaction - the same
 * boundary `chooseEditReviewSettlementRoute` draws, for the same reason: a
 * refusal from here leaves the task OPEN with its money question intact, where
 * one that fired after the claim would leave a closed task and no prices.
 *
 * The blanks are re-read HERE rather than trusted from the browser, and the
 * officer's dates are checked against those. A screen minutes old is exactly how
 * a figure ends up written against a night the booking no longer holds.
 *
 * `null` in, `null` out: not recording the amounts is an ordinary answer and
 * must reach the strand not at all, so a settle that sends none reads and writes
 * exactly what it did before #3191.
 */
export async function planStoredNightPriceRepair({
  task,
  requested,
  settled,
  store,
}: {
  task: { kind: ManualRefundTaskKind | string | null; reviewContext: unknown };
  /**
   * What the officer typed, ONE ARRAY PER REPAIRABLE STRAND, in the order the
   * screen was offered them (#3498). `null` is "not recording those now" and is
   * the body every client sent before #3191.
   */
  requested: readonly (readonly RecordedNightPrice[])[] | null;
  /** What this settle moves, or null on a dismissal, which moves nothing. */
  settled: { direction: SettlementDirectionValue; amountCents: number } | null;
  store: Prisma.TransactionClient;
}): Promise<StoredNightPriceRepairPlan[]> {
  /*
    #3498: EVERY repairable strand this one item covers, in the item's own
    order. The officer is offered one column of boxes per strand and sends back
    one array of figures per strand, matched by POSITION - which is how the
    browser never has to name a guest strand, the property
    `UnpricedNightsSummary`'s own docblock protects.
  */
  const repairable = await loadUnpricedNightsSummaries({
    strands: reviewTaskStrands(task),
    store,
  });

  if (requested === null) {
    // #3219 D2 (owner, 5 Sep 2026): night prices are MANDATORY where the boxes
    // are ALREADY OFFERED, on a dismissal as on a completion - the booking's
    // price re-bases from the strands when the review closes, and one closed
    // blank leaves a headline still counting a deleted guest (#3257).
    //
    // "WHERE THE BOXES ARE OFFERED" IS STRUCTURAL, NOT A CARVE-OUT LIST, which
    // is what keeps the rule narrow: the boxes appear only for a review naming a
    // strand whose blanks can be filled against usable money. Everything else
    // answers an EMPTY list from the read above and closes as it did before - a
    // legacy hand-back, a total mismatch with no blanks, damaged rows, a removed
    // guest whose rows the edit deleted, the "different guest" item, and #3213's
    // withheld-share notice, which reviews no stay.
    //
    // The refusal is `unpricedNightsExplanation` verbatim - the sentence the
    // officer already saw - not a second wording of one rule (`INV-SSOT`). On a
    // multi-strand item it names the FIRST strand still holding blanks, because
    // that is the first column of boxes they are looking at.
    const offered = repairable[0];
    if (offered === undefined) return [];
    throw new ManualBookingPaymentError(
      unpricedNightsExplanation(offered.summary, {
        // The item's OWN strand count, not the repairable subset's: the
        // sentence is about whether the other guests this change touched are on
        // this review or on their own, and a guest with nothing blank is still
        // on this review.
        otherStrandsOnThisItem: Math.max(
          reviewTaskStrands(task).length - 1,
          0,
        ),
      }),
      400,
    );
  }

  if (repairable.length === 0) {
    // The two refusals say different things and both still apply, at the grain
    // of the ITEM rather than of one strand (#3498): an item whose stored
    // context names no strand readably cannot be matched to a booking guest at
    // all, while one that names strands with nothing blank on them has figures
    // arriving for work that is already done.
    throw new ManualBookingPaymentError(
      reviewTaskStrands(task).length === 0
        ? NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE
        : NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
      409,
    );
  }
  if (requested.length !== repairable.length) {
    /*
      The screen was built from a different set of repairable strands than the
      booking now has - a guest repaired or removed in another tab, or an older
      client posting the pre-#3498 flat body. Refused as a race rather than
      matched up as far as it goes: a positional binding that is allowed to be
      short would write one strand's figures onto another strand's nights.
    */
    throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
  }

  const deltaCents = settlementDeltaCents(settled);
  return repairable.map(({ bookingGuestId, summary, absorbsSettlement }, index) => {
    const check = checkStoredNightPriceRepair({
      summary,
      entries: requested[index] ?? [],
      /*
        THE SETTLED AMOUNT MOVES AT MOST ONE STRAND'S WORTH, and never a strand
        it is not about. `absorbsSettlement` says which, and says FALSE for all
        of them where the strand the money is about has no blanks — see its own
        docblock for the removal shape that makes the distinction money rather
        than tidiness. Spreading the amount across strands would be an
        allocation nobody stated, which is the derivation `INV-MOD-028` forbids.
      */
      deltaCents: absorbsSettlement ? deltaCents : 0,
    });
    if (!check.ok) throw new ManualBookingPaymentError(check.message, 400);
    return { bookingGuestId, summary, entries: check.entries };
  });
}
