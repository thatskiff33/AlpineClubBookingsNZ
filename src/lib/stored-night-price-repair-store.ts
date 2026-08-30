import "server-only";

import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";
import {
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import { getExplicitGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import type {
  RecordedNightPrice,
  UnpricedNightsSummary,
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
 *    so two officers settling at once cannot both move it.
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
 * single-flight guarantee is the task's own status claim; the two fences above
 * are what make a concurrent booking edit a loud refusal instead of a lost
 * update.
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
    const [key] = getExplicitGuestBedNightKeys({ nights: [night] }) ?? [];
    if (key === undefined) return null;
    if (night.priceCents === null) {
      blanks.push(calendarDateOfDateOnlyInstant(night.stayDate));
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
 * The race refusal. It is a 409 rather than a 400 because nothing the officer
 * typed is wrong - the booking moved underneath them - and because the caller's
 * transaction rolls back with it, so the task is still OPEN when they retry.
 */
export const NIGHT_PRICE_REPAIR_RACED_MESSAGE =
  "This booking's stored night prices changed while you were recording them, so nothing was saved. Reload the page and check the booking before trying again.";

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
