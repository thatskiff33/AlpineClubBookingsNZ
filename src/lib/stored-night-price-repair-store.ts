import "server-only";

import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import {
  dateOnlyInstantOf,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import { createAuditLog } from "@/lib/audit";
import {
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import logger from "@/lib/logger";
import { getExplicitGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  checkStoredNightPriceRepair,
  settlementDeltaCents,
  NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
  NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE,
  type RecordedNightPrice,
  type SettlementDirectionValue,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";

/**
 * #3191 (epic #2797): the READS and the WRITES behind recording what an unpriced
 * night sold for. The RULES are in `stored-night-price-repair.ts`, which is
 * client-safe because the settle screen applies them as the officer types.
 *
 * ## The one place a blank may become a number
 *
 * `INV-MOD-028` says a `NULL` `BookingGuestNight.priceCents` is the column
 * stating that the night's sold price is not known, and that nothing may derive
 * one. This module is the single exception the owner's #3191 decision creates,
 * and it is deliberately the narrowest possible one:
 *
 *  - it writes only what a person typed, checked by
 *    `checkStoredNightPriceRepair`, which refuses a partial vector rather than
 *    completing it;
 *  - every write is fenced on `priceCents: null`, so a night that already
 *    carries a price - including a genuine stored `0` - CANNOT be rewritten by
 *    this path at all. That is not a rule anybody has to remember; it is the
 *    `where` clause, and a race that filled the row first turns into a refusal
 *    rather than a silent overwrite;
 *  - the strand's stored total is fenced on its previous value in the same way,
 *    so two officers settling at once cannot both move it;
 *  - and since #3219 the BOOKING's own two headline totals move with it, in the
 *    same transaction and fenced the same way. Nothing here derives them from an
 *    amount: they are RECOMPUTED from what the strands now say, read back after
 *    the two writes above.
 *
 * `stored-night-price-repair-census.test.ts` pins that this is the only module in
 * the tree that updates an existing `BookingGuestNight` row's price in place, and
 * that neither half of this feature contains an arithmetic derivation.
 *
 * ## Where it runs, and why the halves are apart
 *
 * `loadUnpricedNightsSummary` runs BEFORE the completion's status claim, on the
 * caller's transaction, so a refusal leaves the task OPEN and still holding its
 * money question - the same boundary `chooseEditReviewSettlementRoute` draws and
 * for the same reason. `applyStoredNightPriceRepair` runs AFTER the claim, on
 * that same transaction, so a lost claim writes no prices.
 *
 * NO ADVISORY LOCK IS TAKEN, matching the completion path this rides on, which
 * `docs/CONCURRENCY_AND_LOCKING.md` records as deliberately holding none. The
 * single-flight guarantee is the task's own status claim; the fences above are
 * what make a concurrent booking edit a loud refusal instead of a lost update.
 */

/** The night rows and the total this module reads off a guest strand. */
type RepairableGuest = {
  id: string;
  priceCents: number;
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
};

const GUEST_SELECT = {
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

/** The strand one review task is about, or null when it names none readably. */
export function reviewTaskGuestId(task: {
  kind: ManualRefundTaskKind | string | null;
  reviewContext: unknown;
}): string | null {
  if (task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW) return null;
  const context = parseEditFinancialReviewContext(task.reviewContext);
  return context?.occurrence.bookingGuestId ?? null;
}

/**
 * The summary for one task's strand, read on the caller's own transaction.
 *
 * Read INSIDE the completion transaction rather than trusted from the browser,
 * because what the screen was shown may be minutes old: the blanks it lists are
 * re-derived here and the officer's entries are checked against THESE dates.
 */
export async function loadUnpricedNightsSummary({
  bookingGuestId,
  store,
}: {
  bookingGuestId: string;
  store: Prisma.TransactionClient;
}): Promise<UnpricedNightsSummary | null> {
  const guest = await store.bookingGuest.findUnique({
    where: { id: bookingGuestId },
    select: GUEST_SELECT,
  });
  return guest ? unpricedNightsSummaryForGuest(guest) : null;
}

/**
 * The summaries for a whole queue load, keyed by TASK id.
 *
 * Keyed by task rather than by guest so the queue payload never has to hold a
 * guest-strand id in order to look one up - the redaction
 * `toEditFinancialReviewEvidence` performs would be worth nothing if the field
 * came back on a neighbouring map. One query for every strand on the page rather
 * than one per row.
 */
export async function unpricedNightsSummariesByTaskId({
  tasks,
  store,
}: {
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | string | null;
    reviewContext: unknown;
  }>;
  store: Prisma.TransactionClient;
}): Promise<Map<string, UnpricedNightsSummary>> {
  const guestIdByTaskId = new Map<string, string>();
  for (const task of tasks) {
    const guestId = reviewTaskGuestId(task);
    if (guestId !== null) guestIdByTaskId.set(task.id, guestId);
  }
  const summaries = new Map<string, UnpricedNightsSummary>();
  if (guestIdByTaskId.size === 0) return summaries;

  const guests = await store.bookingGuest.findMany({
    where: { id: { in: [...new Set(guestIdByTaskId.values())] } },
    select: GUEST_SELECT,
  });
  const byGuestId = new Map(guests.map((guest) => [guest.id, guest]));
  for (const [taskId, guestId] of guestIdByTaskId) {
    const guest = byGuestId.get(guestId);
    if (!guest) continue;
    const summary = unpricedNightsSummaryForGuest(guest);
    if (summary) summaries.set(taskId, summary);
  }
  return summaries;
}

/**
 * The same summaries for a screen that must render whether or not they can be
 * read.
 *
 * FAIL-CLOSED AND ON ITS OWN. An empty map means no row offers the repair, which
 * is exactly what the finance queue did before #3191 - the money work on that
 * card is unaffected by a repair it cannot offer this minute, and blanking the
 * queue over a secondary read would take a list of money the club owes members
 * off the screen. The strict function above stays available for a caller that
 * must not silently degrade.
 */
export async function unpricedNightsSummariesForQueue(args: {
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | string | null;
    reviewContext: unknown;
  }>;
  store: Prisma.TransactionClient;
}): Promise<Map<string, UnpricedNightsSummary>> {
  try {
    return await unpricedNightsSummariesByTaskId(args);
  } catch (err) {
    logger.error(
      { err },
      "Failed to read unpriced night summaries for the finance queue; its rows are answered without them",
    );
    return new Map<string, UnpricedNightsSummary>();
  }
}

/**
 * The race refusal. It is a 409 rather than a 400 because nothing the officer
 * typed is wrong - the booking moved underneath them - and because the caller's
 * transaction rolls back with it, so the task is still OPEN when they retry.
 */
export const NIGHT_PRICE_REPAIR_RACED_MESSAGE =
  "This booking's stored night prices changed while you were recording them, so nothing was saved. Reload the page and check the booking before trying again.";

/**
 * #3219: the review names a guest strand that is not on the booking the task is
 * about, so there is no sound set of strands to re-base the headline from.
 *
 * A 409 for the same reason as the message above - the caller's transaction
 * rolls back with it, so nothing is half-written and the task is still OPEN -
 * but a DIFFERENT sentence, because this is not a race and reloading will not
 * clear it. Nothing cross-checks the strand id an `EDIT_FINANCIAL_REVIEW`
 * context carries against the task's own `bookingId`, so this is what stops one
 * booking's headline being re-based from another booking's strands.
 */
export const NIGHT_PRICE_REPAIR_STRAND_NOT_ON_BOOKING_MESSAGE =
  "This review names a guest who is not on this booking, so nothing was saved. Check the booking's guests before trying again.";

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
  requested: readonly RecordedNightPrice[] | null;
  /** What this settle moves, or null on a dismissal, which moves nothing. */
  settled: { direction: SettlementDirectionValue; amountCents: number } | null;
  store: Prisma.TransactionClient;
}): Promise<StoredNightPriceRepairPlan | null> {
  if (requested === null) return null;

  const bookingGuestId = reviewTaskGuestId(task);
  if (bookingGuestId === null) {
    throw new ManualBookingPaymentError(
      NIGHT_PRICE_REPAIR_NO_STRAND_MESSAGE,
      409,
    );
  }
  const summary = await loadUnpricedNightsSummary({ bookingGuestId, store });
  if (summary === null) {
    throw new ManualBookingPaymentError(
      NIGHT_PRICE_REPAIR_NOTHING_TO_FILL_MESSAGE,
      409,
    );
  }
  const check = checkStoredNightPriceRepair({
    summary,
    entries: requested,
    deltaCents: settlementDeltaCents(settled),
  });
  if (!check.ok) throw new ManualBookingPaymentError(check.message, 400);
  return { bookingGuestId, summary, entries: check.entries };
}

/**
 * Write the plan and audit it, AFTER the caller's claim and inside it.
 *
 * AUDITED AS A MONEY-AFFECTING ACT IN ITS OWN RIGHT, which #3191 requires, and
 * as a SECOND entry rather than as metadata on the settlement beside it. The two
 * are different acts: one closes a task and moves money, the other rewrites what
 * a stay is recorded as having sold for - and the second can happen on a
 * DISMISSAL, whose entry says in as many words that nothing moved. Folding it in
 * would put a price change inside a row whose summary denies one.
 *
 * #3219: it also re-bases the BOOKING's two headline totals from the strands,
 * which belongs in this entry rather than in one of its own - it is the same
 * act, and separating them would leave a reader holding two rows and no
 * statement that one caused the other.
 */
export async function recordStoredNightPriceRepair({
  plan,
  task,
  actingMemberId,
  resolution,
  note,
  store,
}: {
  plan: StoredNightPriceRepairPlan;
  task: { id: string; bookingId: string; booking: { memberId: string } };
  actingMemberId: string;
  resolution: "completed" | "dismissed";
  note: string | null;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const { newGuestTotalCents } = await applyStoredNightPriceRepair({
    bookingGuestId: plan.bookingGuestId,
    summary: plan.summary,
    entries: plan.entries,
    store,
  });
  // #3219: and the booking's own headline totals come back into agreement with
  // the strands, in this same transaction, on a dismissal exactly as on a
  // completion - the park froze them and nothing else thaws them.
  const bookingTotals = await rebaseBookingTotalsFromStrands({
    bookingId: task.bookingId,
    repairedGuestId: plan.bookingGuestId,
    repairedGuestTotalCents: newGuestTotalCents,
    store,
  });
  await createAuditLog(
    {
      action: "booking-payment.stored-night-price.record",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: task.booking.memberId,
      targetId: task.bookingId,
      entityType: "BookingGuest",
      entityId: plan.bookingGuestId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary:
        "Recorded what a booking's unpriced nights sold for while settling a financial review",
      details: note,
      metadata: {
        taskId: task.id,
        bookingId: task.bookingId,
        resolution,
        // The figures themselves, night by night, because "an admin priced
        // these" is not auditable unless the entry says what they priced them
        // at - the same reason the completion entry carries three amounts.
        nightPrices: plan.entries.map((entry) => ({
          date: entry.date,
          priceCents: entry.priceCents,
        })),
        previousGuestTotalCents: plan.summary.storedGuestTotalCents,
        newGuestTotalCents,
        knownNightTotalCents: plan.summary.knownNightTotalCents,
        // #3219: the booking's headline totals moved with the strand, so the
        // entry that records the act records what it did to them. Both figures,
        // before and after, because a reader asking "why does this booking cost
        // what it does?" months later has nowhere else to look.
        previousBookingTotalPriceCents: bookingTotals.previousTotalPriceCents,
        newBookingTotalPriceCents: bookingTotals.newTotalPriceCents,
        previousBookingFinalPriceCents: bookingTotals.previousFinalPriceCents,
        newBookingFinalPriceCents: bookingTotals.newFinalPriceCents,
      },
    },
    store,
  );
}

/**
 * Write the officer's per-night amounts and re-base what the strand is worth.
 *
 * MUST run after the status claim and on the same transaction. Both writes are
 * fenced compare-and-sets: a night that stopped being blank, or a total that
 * moved, refuses instead of overwriting. `updateMany` is used rather than
 * `update` precisely so the fence can be part of the `where` - `update` on a
 * unique key would find the row and write over whatever it now holds.
 *
 * Returns what the strand is now worth, for the audit entry.
 */
export async function applyStoredNightPriceRepair({
  bookingGuestId,
  summary,
  entries,
  store,
}: {
  bookingGuestId: string;
  summary: UnpricedNightsSummary;
  entries: readonly RecordedNightPrice[];
  store: Prisma.TransactionClient;
}): Promise<{ newGuestTotalCents: number }> {
  for (const entry of entries) {
    const written = await store.bookingGuestNight.updateMany({
      where: {
        bookingGuestId,
        stayDate: dateOnlyInstantOf(entry.date),
        // The fence, and the whole of this path's safety: a night that already
        // carries a price is not matched, so it cannot be rewritten here.
        priceCents: null,
      },
      data: { priceCents: entry.priceCents },
    });
    if (written.count !== 1) {
      throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
    }
  }

  const newGuestTotalCents =
    summary.knownNightTotalCents +
    entries.reduce((sum, entry) => sum + entry.priceCents, 0);
  const rebased = await store.bookingGuest.updateMany({
    where: { id: bookingGuestId, priceCents: summary.storedGuestTotalCents },
    data: { priceCents: newGuestTotalCents },
  });
  if (rebased.count !== 1) {
    throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
  }

  return { newGuestTotalCents };
}

/**
 * Re-base the BOOKING's two headline totals from its strands (#3219).
 *
 * MUST run after the strand write and on the same transaction, which already
 * holds the completion's status claim.
 *
 * ## Why the headline moves at all
 *
 * Every ordinary edit path re-bases `Booking.totalPriceCents` to the repriced
 * total. A PARKED edit deliberately freezes it, because a parked edit is
 * precisely one whose money nobody may compute - and until this issue nothing
 * thawed it when the review settled. So the freeze was right and the thaw was
 * missing, and the booking was left saying one thing in its headline and another
 * in its nights, permanently, with nothing reconciling the two.
 *
 * ## Why it is RECOMPUTED and never derived from the settled amount
 *
 * The obvious fix - apply the signed settlement delta to the stored headline -
 * is wrong on the path that most parked strands actually end on. This writer
 * also runs on a DISMISSAL, whose audit entry says in as many words that nothing
 * moved: there is no delta to apply there, and the headline still has to come
 * back into agreement with the strands. It would also be wrong wherever the park
 * left the headline out of step by more than this settlement moves - a parked
 * removal, say, whose strand is gone while the frozen headline still counts it.
 *
 * So the new figures are the sum of what the strands say once the writes above
 * have landed. There is no second derivation to keep in step: the sum is read
 * back from the rows this transaction has just written.
 *
 * ## Why BOTH figures, and why `promoAdjustmentCents` is not touched
 *
 * `Booking.finalPriceCents` is the total plus the signed promotion adjustment,
 * and it is the figure settlement decisions actually read (`priceDiffCents` is
 * built from it). Moving only `totalPriceCents` would trade one disagreement for
 * another, so the two move together, by the same relation every other edit path
 * writes them with. The promotion itself is NOT recalculated: a parked edit
 * recalculates no promotion, and neither does settling one - so the adjustment
 * is carried through exactly as stored and the headline moves by exactly what
 * the strands moved by.
 *
 * ## The fences
 *
 * A compare-and-set on both stored figures, for the same reason the two writes
 * above are fenced and by the same means: this path holds no advisory lock, so a
 * concurrent booking edit that moved the headline underneath us must become a
 * refusal that rolls the whole completion back, never a lost update. And the
 * repaired strand must be one of the booking's own, carrying the value that was
 * just written to it - without that check a task whose review context named a
 * strand on some other booking would re-base this booking's headline from a set
 * of strands that has nothing to do with it, and an empty guest list would zero
 * the headline outright.
 */
export async function rebaseBookingTotalsFromStrands({
  bookingId,
  repairedGuestId,
  repairedGuestTotalCents,
  store,
}: {
  bookingId: string;
  repairedGuestId: string;
  /** What `applyStoredNightPriceRepair` has just written to that strand. */
  repairedGuestTotalCents: number;
  store: Prisma.TransactionClient;
}): Promise<{
  previousTotalPriceCents: number;
  previousFinalPriceCents: number;
  newTotalPriceCents: number;
  newFinalPriceCents: number;
}> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    select: {
      totalPriceCents: true,
      promoAdjustmentCents: true,
      finalPriceCents: true,
      guests: { select: { id: true, priceCents: true } },
    },
  });
  if (booking === null) {
    throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
  }

  // The strand this settle just repaired has to be one of THESE strands, at the
  // value it was just written to. That is what makes the sum below the sum of
  // the booking's own nights rather than of somebody else's.
  const repaired = booking.guests.find(
    (guest) => guest.id === repairedGuestId,
  );
  if (
    repaired === undefined ||
    repaired.priceCents !== repairedGuestTotalCents
  ) {
    throw new ManualBookingPaymentError(
      NIGHT_PRICE_REPAIR_STRAND_NOT_ON_BOOKING_MESSAGE,
      409,
    );
  }

  const newTotalPriceCents = booking.guests.reduce(
    (sum, guest) => sum + guest.priceCents,
    0,
  );
  const newFinalPriceCents =
    newTotalPriceCents + booking.promoAdjustmentCents;

  const rebased = await store.booking.updateMany({
    where: {
      id: bookingId,
      totalPriceCents: booking.totalPriceCents,
      finalPriceCents: booking.finalPriceCents,
    },
    data: {
      totalPriceCents: newTotalPriceCents,
      finalPriceCents: newFinalPriceCents,
    },
  });
  if (rebased.count !== 1) {
    throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
  }

  return {
    previousTotalPriceCents: booking.totalPriceCents,
    previousFinalPriceCents: booking.finalPriceCents,
    newTotalPriceCents,
    newFinalPriceCents,
  };
}
