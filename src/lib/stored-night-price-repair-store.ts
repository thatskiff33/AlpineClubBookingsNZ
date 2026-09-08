import "server-only";

import { ManualRefundTaskKind, Prisma } from "@prisma/client";

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
import { getExplicitGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { editReviewSettlementIssuesXeroDocument } from "@/lib/edit-financial-review-xero-leg";
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
import {
  bookingRebaseAuditMetadata,
  rebaseBookingPriceFromStrands,
  rebaseDivergesFromIssuedInvoice,
  rebaseChangedTheBooking,
  recordBookingPriceRebaseHistory,
} from "@/lib/booking-review-price-rebase";

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
  requested: readonly RecordedNightPrice[] | null;
  /** What this settle moves, or null on a dismissal, which moves nothing. */
  settled: { direction: SettlementDirectionValue; amountCents: number } | null;
  store: Prisma.TransactionClient;
}): Promise<StoredNightPriceRepairPlan | null> {
  if (requested === null) {
    // #3219 D2 (owner, 5 Sep 2026): night prices are MANDATORY where the boxes
    // are ALREADY OFFERED, on a dismissal as on a completion - the booking's
    // price re-bases from the strands when the review closes, and one closed
    // blank leaves a headline still counting a deleted guest (#3257).
    //
    // "WHERE THE BOXES ARE OFFERED" IS STRUCTURAL, NOT A CARVE-OUT LIST, which
    // is what keeps the rule narrow: the boxes appear only for a review naming a
    // strand whose blanks can be filled against usable money. Everything else
    // answers `null` from one of the two reads below and closes as it did
    // before - a legacy hand-back, a total mismatch with no blanks, damaged
    // rows, a removed guest whose rows the edit deleted, the "different guest"
    // item, and #3213's withheld-share notice, which reviews no stay.
    //
    // The refusal is `unpricedNightsExplanation` verbatim - the sentence the
    // officer already saw - not a second wording of one rule (`INV-SSOT`).
    const offeredGuestId = reviewTaskGuestId(task);
    if (offeredGuestId === null) return null;
    const offered = await loadUnpricedNightsSummary({
      bookingGuestId: offeredGuestId,
      store,
    });
    if (offered === null) return null;
    throw new ManualBookingPaymentError(
      unpricedNightsExplanation(offered),
      400,
    );
  }

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
 * Close a parked review's PRICING half, AFTER the caller's claim and inside it:
 * write whatever night prices the officer recorded, then re-price the booking
 * from its strands - and audit both as one act.
 *
 * AUDITED AS A MONEY-AFFECTING ACT IN ITS OWN RIGHT, which #3191 requires, and
 * as a SECOND entry rather than as metadata on the settlement beside it. The two
 * are different acts: one closes a task and moves money, the other rewrites what
 * a stay is recorded as having sold for - and the second can happen on a
 * DISMISSAL, whose entry says in as many words that nothing moved. Folding it in
 * would put a price change inside a row whose summary denies one.
 *
 * #3219: it also RE-PRICES THE BOOKING from its strands - all four money
 * columns, with the promotion recomputed and re-capped - which belongs in this
 * entry rather than in one of its own: it is the same act, and separating them
 * would leave a reader holding two rows and no statement that one caused the
 * other. The re-price itself lives in `booking-review-price-rebase.ts`, which is
 * where its rules, its refusals and its lock declaration are stated.
 *
 * `plan` IS NULLABLE, AND THAT IS WHAT CLOSES #3257 (owner, 7 September 2026).
 * The re-price used to ride on the repair, so a review offering no price boxes
 * re-priced nothing - and two reachable shapes of a parked guest REMOVAL offer
 * none. This now runs on EVERY parked-review closure, with the repair as its
 * optional half: a `null` plan never reaches `applyStoredNightPriceRepair`, so
 * nothing here can derive a night price nobody stated (`INV-MOD-028`).
 *
 * WHERE THE RE-PRICE DECLINES - a surviving strand whose nights cannot be read
 * back as exact, reconciling evidence, or a booking with no strands left - the
 * audit entry says so rather than staying silent, and the booking's totals are
 * left exactly as the park set them. That decline is what makes re-pricing on
 * ANY close safe rather than reckless.
 */
export async function recordReviewClosurePricing({
  plan,
  task,
  actingMemberId,
  resolution,
  note,
  todayAtClub,
  hasIssuedXeroInvoice,
  settlementRoute,
  settlementAmountCents,
  store,
}: {
  /** What the officer recorded, or null where the review offered no boxes. */
  plan: StoredNightPriceRepairPlan | null;
  task: { id: string; bookingId: string; booking: { memberId: string } };
  actingMemberId: string;
  resolution: "completed" | "dismissed";
  note: string | null;
  /**
   * #3219: the club's own calendar day, resolved by the caller BEFORE it opened
   * this transaction (`INV-LOCK-004`). The re-price needs it to decide the
   * promotion's validity window.
   */
  todayAtClub: CalendarDate;
  /** #3219: whether the club has already invoiced this booking through Xero. */
  hasIssuedXeroInvoice: boolean;
  /**
   * #3219: what THIS closure would send Xero, so this module can ask the Xero
   * leg's own predicate whether a document is actually issued.
   *
   * A dismissal picks no route and issues none at all - and that is the case
   * where a re-price leaves the club's external record saying one figure and
   * its internal record another. A ROUTE ALONE IS NOT ENOUGH either:
   * `local-allocation` carries a nullable anchor, and the Xero leg sends
   * nothing without one, so `route !== null` would report an invoice brought
   * back into line that nothing corrected.
   */
  settlementRoute: Pick<EditReviewSettlementRoute, "bookingModificationId"> | null;
  /** This task's own settled share, or null where nothing was settled. */
  settlementAmountCents: number | null;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const repaired = plan
    ? await applyStoredNightPriceRepair({
        bookingGuestId: plan.bookingGuestId,
        summary: plan.summary,
        entries: plan.entries,
        store,
      })
    : null;
  // #3219: and the booking itself comes back into agreement with its strands, in
  // this same transaction, on a dismissal exactly as on a completion - the park
  // froze it and nothing else thaws it.
  // #3257: on a closure that repaired NOTHING too, which is where the two shapes
  // of a parked removal that offer no price boxes used to escape it entirely.
  const outcome = await rebaseBookingPriceFromStrands({
    bookingId: task.bookingId,
    repairedStrand:
      plan && repaired
        ? {
            bookingGuestId: plan.bookingGuestId,
            totalCents: repaired.newGuestTotalCents,
          }
        : null,
    todayAtClub,
    store,
  });
  const rebase = outcome.rebased ? outcome.rebase : null;
  const xeroInvoiceDiverged =
    rebase !== null &&
    rebaseDivergesFromIssuedInvoice({
      rebase,
      hasIssuedXeroInvoice,
      settlementIssuesXeroDocument: editReviewSettlementIssuesXeroDocument({
        route: settlementRoute,
        xeroAmountCents: settlementAmountCents,
      }),
    });
  if (rebase !== null && rebaseChangedTheBooking(rebase)) {
    // D1's second consequence: a member can now be refunded less than they paid
    // from an action they never saw, so the reason goes in the BOOKING'S OWN
    // HISTORY and not only in the audit entry below.
    //
    // #3257: ONLY WHERE SOMETHING ACTUALLY CHANGED. Most closures now recompute
    // what the booking already held - a correct no-op whose "Price Recalculated"
    // row would be noise. A promotion REMOVED with the four columns unmoved IS a
    // change, and this row carries the only sentence saying so. The audit entry
    // below records the closure either way.
    await recordBookingPriceRebaseHistory({
      bookingId: task.bookingId,
      actingMemberId,
      taskId: task.id,
      resolution,
      rebase,
      xeroInvoiceDiverged,
      store,
    });
  }
  await createAuditLog(
    {
      // #3257: two actions from one write site, because the two closures are
      // genuinely different acts and a reader filtering for "what did an officer
      // price?" must not be handed closures that priced nothing. The category,
      // the severity rule and every re-price field below are shared, which is
      // why they are not two writers (`INV-SSOT`).
      action: plan
        ? "booking-payment.stored-night-price.record"
        : "booking-payment.review-closure.reprice",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: task.booking.memberId,
      targetId: task.bookingId,
      entityType: plan ? "BookingGuest" : "Booking",
      entityId: plan ? plan.bookingGuestId : task.bookingId,
      category: "payment",
      // #3219: CRITICAL exactly when the club's invoice no longer agrees with
      // the booking and nothing in this closure will correct it. That is the one
      // state where a later Internet-Banking settle would mark the booking PAID
      // on less than was invoiced, so it is the one that has to stand out.
      severity: xeroInvoiceDiverged ? "critical" : "important",
      outcome: "success",
      summary: xeroInvoiceDiverged
        ? "Re-priced a booking while settling a financial review; its issued Xero invoice no longer matches"
        : plan
          ? "Recorded what a booking's unpriced nights sold for while settling a financial review"
          : "Re-priced a booking from its guests while closing a financial review",
      details: note,
      metadata: {
        taskId: task.id,
        bookingId: task.bookingId,
        resolution,
        // The figures themselves, night by night, because "an admin priced
        // these" is not auditable unless the entry says what they priced them
        // at - the same reason the completion entry carries three amounts.
        //
        // #3257: null throughout on a closure that recorded none, which is what
        // distinguishes "the officer priced nothing" from "the officer priced
        // these at zero" - the distinction this whole epic exists to keep.
        nightPrices:
          plan?.entries.map((entry) => ({
            date: entry.date,
            priceCents: entry.priceCents,
          })) ?? null,
        previousGuestTotalCents: plan?.summary.storedGuestTotalCents ?? null,
        newGuestTotalCents: repaired?.newGuestTotalCents ?? null,
        knownNightTotalCents: plan?.summary.knownNightTotalCents ?? null,
        // #3219/#3257: what the re-price did to every money column, before and
        // after, or why it declined - shaped beside the writer that produced it.
        ...bookingRebaseAuditMetadata({ outcome, xeroInvoiceDiverged }),
      },
    },
    store,
  );
}

/**
 * One night this writer is about to set, with the value it must still hold.
 *
 * THE EXPECTATION IS DERIVED SERVER-SIDE, on the caller's own transaction, and
 * never sent by a browser: `RecordedNightPrice` - the wire shape - carries a
 * date and an amount and nothing else, so a request cannot nominate what the
 * compare-and-set compares against. That is what keeps the fence a fence
 * (`INV-SSOT`: prefer unrepresentable over policed).
 *
 * `expectedPriceCents: null` with `rowExists: true` is the settle path's ONLY
 * shape and is byte-identical to the `priceCents: null` `where` this writer
 * carried before #3214, because `unpricedNightsSummaryForGuest` builds its dates
 * from existing rows whose price is exactly `NULL`.
 */
export type FencedNightWrite = {
  date: CalendarDate;
  /** What the officer typed. */
  priceCents: number;
  /**
   * What the row must still hold for the write to land - the RAW stored value,
   * so a row carrying an unusable price is fenced on that unusable price rather
   * than on a projection of it. `null` means the row is blank.
   */
  expectedPriceCents: number | null;
  /** False only where the strand holds this night through its stay envelope. */
  rowExists: boolean;
};

/** Is this the `(bookingGuestId, stayDate)` unique constraint refusing a create? */
function isNightRowAlreadyPresent(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * THE ONE WRITER (`INV-SSOT`). Set every night the caller checked, then re-base
 * what the strand is worth, all on the caller's transaction.
 *
 * `stored-night-price-repair-census.test.ts` pins that this module is the only
 * one in the tree that updates a `BookingGuestNight` price in place, so a second
 * caller shares this function rather than growing a second writer. Two do:
 * {@link applyStoredNightPriceRepair}, which fills a review's blanks while it is
 * being settled (#3191), and {@link applyStrandNightPriceReconcile}, the strand
 * reconcile a booking's own admin tools offer (#3214). They differ only in what
 * they hand over.
 *
 * EVERY ARM IS A COMPARE-AND-SET, and that is the whole of this path's
 * single-flight guarantee - there is no advisory lock here (see the module
 * docblock, and `docs/CONCURRENCY_AND_LOCKING.md`):
 *
 *  - an existing row is matched on the value it was read holding, so a night
 *    somebody else has since changed matches nothing and raises the race
 *    refusal instead of being overwritten. `updateMany` rather than `update`
 *    precisely so the fence can live in the `where`;
 *  - a row that does not exist is CREATED, and the `(bookingGuestId, stayDate)`
 *    unique constraint is the fence on that arm: a row that appeared underneath
 *    us raises `P2002`, which becomes the same race refusal rather than a 500;
 *  - the strand's total is fenced on its previous value, so two officers cannot
 *    both move it.
 *
 * A refusal rolls the caller's transaction back, so a partial write is not a
 * reachable state.
 *
 * Returns what the strand is now worth, and how many rows had to be created,
 * for the audit entry.
 */
async function applyFencedStrandNightPrices({
  bookingGuestId,
  summary,
  writes,
  store,
}: {
  bookingGuestId: string;
  summary: UnpricedNightsSummary;
  writes: readonly FencedNightWrite[];
  store: Prisma.TransactionClient;
}): Promise<{ newGuestTotalCents: number; rowsCreated: number }> {
  let rowsCreated = 0;
  for (const write of writes) {
    if (!write.rowExists) {
      try {
        await store.bookingGuestNight.create({
          data: {
            bookingGuestId,
            stayDate: dateOnlyInstantOf(write.date),
            priceCents: write.priceCents,
            priceSource: "OFFICER_PRICED",
          },
        });
      } catch (err) {
        if (isNightRowAlreadyPresent(err)) {
          throw new ManualBookingPaymentError(
            NIGHT_PRICE_REPAIR_RACED_MESSAGE,
            409,
          );
        }
        throw err;
      }
      rowsCreated += 1;
      continue;
    }
    const written = await store.bookingGuestNight.updateMany({
      where: {
        bookingGuestId,
        stayDate: dateOnlyInstantOf(write.date),
        // The fence. On the settle path this is `null`, so a night that already
        // carries a price is not matched and cannot be rewritten there at all.
        priceCents: write.expectedPriceCents,
      },
      data: {
        priceCents: write.priceCents,
        priceSource: "OFFICER_PRICED",
      },
    });
    if (written.count !== 1) {
      throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
    }
  }

  const newGuestTotalCents =
    summary.knownNightTotalCents +
    writes.reduce((sum, write) => sum + write.priceCents, 0);
  const rebased = await store.bookingGuest.updateMany({
    where: { id: bookingGuestId, priceCents: summary.storedGuestTotalCents },
    data: { priceCents: newGuestTotalCents },
  });
  if (rebased.count !== 1) {
    throw new ManualBookingPaymentError(NIGHT_PRICE_REPAIR_RACED_MESSAGE, 409);
  }

  return { newGuestTotalCents, rowsCreated };
}

/**
 * Write the officer's per-night amounts and re-base what the strand is worth,
 * while an `EDIT_FINANCIAL_REVIEW` is being settled (#3191).
 *
 * MUST run after the status claim and on the same transaction.
 *
 * EVERY ENTRY IS A BLANK ROW, and that is a property of the plan rather than an
 * assumption: `unpricedNightsSummaryForGuest` builds `summary.dates` only from
 * rows this strand already has whose `priceCents` is exactly `NULL`, so
 * `rowExists: true, expectedPriceCents: null` is the only shape this path can
 * produce. The `where` it reaches the database with is therefore byte-identical
 * to the one this function carried before #3214 generalised the writer, which
 * `stored-night-price-repair.test.ts` pins argument for argument.
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
  const { newGuestTotalCents } = await applyFencedStrandNightPrices({
    bookingGuestId,
    summary,
    writes: entries.map((entry) => ({
      date: entry.date,
      priceCents: entry.priceCents,
      expectedPriceCents: null,
      rowExists: true,
    })),
    store,
  });
  return { newGuestTotalCents };
}

/**
 * The #3214 arm: set every night a non-reconciling strand holds, creating the
 * rows it does not have.
 *
 * A SEPARATE ENTRY POINT RATHER THAN A FLAG ON THE ONE ABOVE, because the two
 * acts have different preconditions and different callers, and because the
 * settle path has to keep a signature a reviewer can see is unchanged. Both
 * reach the same fenced writer, so there is still exactly one place a night
 * price is written (`INV-SSOT`).
 *
 * THE MONEY-NEUTRALITY GUARANTEE IS ENFORCED HERE, by the function that makes
 * the write, rather than a module away by the one caller that happens to have
 * it. The caller supplies the arithmetic - with `summary.knownNightTotalCents`
 * at 0 and every held night in `writes`, the re-based total is `sum(writes)`,
 * which `checkStoredNightPriceRepair` has already forced to equal
 * `summary.storedGuestTotalCents` - but an exported function taking an arbitrary
 * `summary` and `writes` will re-base the strand's total to whatever those two
 * add up to, and its NAME promises otherwise. A second caller would inherit the
 * promise and none of the check. So the check sits on this side of the call: it
 * throws inside the caller's transaction, so every row goes back with it.
 *
 * WHAT IT DOES AND DOES NOT GUARANTEE. It guarantees that the MEMBER'S TOTAL is
 * unchanged - `BookingGuest.priceCents` holds the number it already held, so
 * nothing anybody owes moves. It does NOT guarantee that nothing else moves: see
 * `stored-night-price-strand-reconcile.ts`'s module docblock for the two
 * consequences that follow from the night rows themselves changing.
 */
export async function applyStrandNightPriceReconcile({
  bookingGuestId,
  summary,
  writes,
  store,
}: {
  bookingGuestId: string;
  summary: UnpricedNightsSummary;
  writes: readonly FencedNightWrite[];
  store: Prisma.TransactionClient;
}): Promise<{ newGuestTotalCents: number; rowsCreated: number }> {
  const result = await applyFencedStrandNightPrices({
    bookingGuestId,
    summary,
    writes,
    store,
  });
  if (result.newGuestTotalCents !== summary.storedGuestTotalCents) {
    throw new Error(
      "Recording night prices moved what the stay is stored as being worth, which this act may never do.",
    );
  }
  return result;
}
