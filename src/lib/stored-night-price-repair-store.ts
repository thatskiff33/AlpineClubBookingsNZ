import "server-only";
import { Prisma, type BookingGuestNightPriceSource } from "@prisma/client";

import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog } from "@/lib/audit";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { editReviewSettlementIssuesXeroDocument } from "@/lib/edit-financial-review-xero-leg";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import type { ClubFormat } from "@/lib/club-format";
import {
  type RecordedNightPrice,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";
// #3498: WHICH strands this settle may repair, and whether the officer's figures
// are allowed to be written, moved to their own module when one work item
// started covering the whole parked edit. Everything there runs before the
// status claim; everything here runs after it.
import {
  NIGHT_PRICE_REPAIR_RACED_MESSAGE,
  type StoredNightPriceRepairPlan,
} from "@/lib/stored-night-price-repair-plan";
import {
  bookingRebaseAuditMetadata,
  rebaseBookingPriceFromStrands,
  rebaseDivergesFromIssuedInvoice,
  rebaseChangedTheBooking,
  recordBookingPriceRebaseHistory,
} from "@/lib/booking-review-price-rebase";

/**
 * #3191 (epic #2797): the WRITES behind recording what an unpriced night sold
 * for, and the audit of them.
 *
 * It was the reads AND the writes until #3498 split the reads into
 * `stored-night-price-repair-plan.ts` - which strands a settle may fill in, and
 * whether what the officer typed may be written - so everything here now runs
 * AFTER the completion's status claim. The RULES are in
 * `stored-night-price-repair.ts`, which is client-safe because the settle
 * screen applies them as the officer types.
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
 * `loadUnpricedNightsSummaries` runs BEFORE the completion's status claim, on the
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
 * `plans` MAY BE EMPTY, AND THAT IS WHAT CLOSES #3257 (owner, 7 September 2026).
 * The re-price used to ride on the repair, so a review offering no price boxes
 * re-priced nothing - and two reachable shapes of a parked guest REMOVAL offer
 * none. This now runs on EVERY parked-review closure, with the repair as its
 * optional half: an empty list never reaches `applyStoredNightPriceRepair`, so
 * nothing here can derive a night price nobody stated (`INV-MOD-028`).
 *
 * WHERE THE RE-PRICE DECLINES - a surviving strand whose nights cannot be read
 * back as exact, reconciling evidence, or a booking with no strands left - the
 * audit entry says so rather than staying silent, and the booking's totals are
 * left exactly as the park set them. That decline is what makes re-pricing on
 * ANY close safe rather than reckless.
 */
export async function recordReviewClosurePricing({
  plans,
  task,
  actingMemberId,
  resolution,
  note,
  todayAtClub,
  hasIssuedXeroInvoice,
  settlementRoute,
  settlementAmountCents,
  store,
  format,
}: {
  /**
   * What the officer recorded, one entry per repairable strand, EMPTY where the
   * review offered no boxes (#3498). It was one plan or null; owner decision D1
   * put the whole party on one item, so a closure can repair several strands.
   */
  plans: readonly StoredNightPriceRepairPlan[];
  /** The booking OWNER is null when it is owned by an Organisation (#3369). */
  task: { id: string; bookingId: string; booking: { memberId: string | null } };
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
  /** The club's format (#3565), resolved by the caller before any transaction. */
  format: ClubFormat;
}): Promise<void> {
  // Sequentially, on the caller's transaction: each write is its own
  // compare-and-set, and a refusal from any of them rolls the whole closure back
  // - so a half-repaired booking is not a reachable state.
  const repaired: Array<{
    plan: StoredNightPriceRepairPlan;
    newGuestTotalCents: number;
  }> = [];
  for (const plan of plans) {
    const applied = await applyStoredNightPriceRepair({
      bookingGuestId: plan.bookingGuestId,
      summary: plan.summary,
      entries: plan.entries,
      store,
    });
    repaired.push({ plan, newGuestTotalCents: applied.newGuestTotalCents });
  }
  // #3219: and the booking itself comes back into agreement with its strands, in
  // this same transaction, on a dismissal exactly as on a completion - the park
  // froze it and nothing else thaws it.
  // #3257: on a closure that repaired NOTHING too, which is where the two shapes
  // of a parked removal that offer no price boxes used to escape it entirely.
  const outcome = await rebaseBookingPriceFromStrands({
    bookingId: task.bookingId,
    format,
    repairedStrands: repaired.map((entry) => ({
      bookingGuestId: entry.plan.bookingGuestId,
      totalCents: entry.newGuestTotalCents,
    })),
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
      moneyBuildUpSelection: outcome.moneyBuildUpSelection,
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
      action:
        repaired.length > 0
          ? "booking-payment.stored-night-price.record"
          : "booking-payment.review-closure.reprice",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: bookingOwner(task.booking).memberId,
      targetId: task.bookingId,
      /*
        #3498: one closure can now repair several strands, and an entry naming
        one of them would read as if the others had not been touched. A
        single-strand repair is left EXACTLY as it was - the shape every entry
        already on file has - and anything else is filed against the booking,
        with every strand's figures in `repairedStrands` below.
      */
      entityType: repaired.length === 1 ? "BookingGuest" : "Booking",
      entityId:
        repaired.length === 1
          ? repaired[0]!.plan.bookingGuestId
          : task.bookingId,
      category: "payment",
      // #3219: CRITICAL exactly when the club's invoice no longer agrees with
      // the booking and nothing in this closure will correct it. That is the one
      // state where a later Internet-Banking settle would mark the booking PAID
      // on less than was invoiced, so it is the one that has to stand out.
      severity: xeroInvoiceDiverged ? "critical" : "important",
      outcome: "success",
      summary: xeroInvoiceDiverged
        ? "Re-priced a booking while settling a financial review; its issued Xero invoice no longer matches"
        : repaired.length > 0
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
        // #3498: per strand, because one closure can repair several. Still
        // null - not an empty array - where nothing was recorded, so "the
        // officer priced nothing" stays distinguishable from "the officer
        // priced these at zero".
        repairedStrands:
          repaired.length > 0
            ? repaired.map(({ plan, newGuestTotalCents }) => ({
                nightPrices: plan.entries.map((entry) => ({
                  date: entry.date,
                  priceCents: entry.priceCents,
                })),
                previousGuestTotalCents: plan.summary.storedGuestTotalCents,
                newGuestTotalCents,
                knownNightTotalCents: plan.summary.knownNightTotalCents,
              }))
            : null,
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

// ---------------------------------------------------------------------------
// #3531 3b: the rate-derived backfill's write, here because THIS is the module
// that rewrites a night row in place (`stored-night-price-repair-census`).
// ---------------------------------------------------------------------------

/** Thrown when a planned row no longer holds what it was planned from. */
export class RateDerivedBackfillRacedError extends Error {
  constructor(bookingGuestId: string, nightId: string) {
    super(`Night ${nightId} of guest ${bookingGuestId} changed since it was planned; booking rolled back`);
    this.name = "RateDerivedBackfillRacedError";
  }
}

export type RateDerivedNightRewrite = {
  bookingGuestId: string;
  nights: ReadonlyArray<{
    id: string;
    fromPriceCents: number;
    fromSource: BookingGuestNightPriceSource;
    toPriceCents: number;
  }>;
};

/**
 * Rewrite planned rows as `RATE_DERIVED`, every one a compare-and-set on the
 * price and provenance it was planned from - the same single-flight rule as
 * the officer repair above, and the same refusal: a row that no longer holds
 * what it was read holding matches nothing, and the caller's transaction rolls
 * back. Never fills a NULL: the planner lists such a strand instead
 * (`INV-MOD-028`), and the fence's `fromPriceCents` is an integer.
 */
export async function applyRateDerivedNightRewrites(
  rewrites: ReadonlyArray<RateDerivedNightRewrite>,
  store: Pick<Prisma.TransactionClient, "bookingGuestNight">,
): Promise<number> {
  let rows = 0;
  for (const strand of rewrites) {
    for (const night of strand.nights) {
      const written = await store.bookingGuestNight.updateMany({
        where: {
          id: night.id,
          bookingGuestId: strand.bookingGuestId,
          priceCents: night.fromPriceCents,
          priceSource: night.fromSource,
        },
        data: { priceCents: night.toPriceCents, priceSource: "RATE_DERIVED" },
      });
      if (written.count !== 1) {
        throw new RateDerivedBackfillRacedError(strand.bookingGuestId, night.id);
      }
      rows += 1;
    }
  }
  return rows;
}
