import "server-only";

/**
 * POST AN EDIT'S LINES, AND A REVIEW CLOSURE'S, TO THE BOOKING LEDGER (#3582,
 * programme #3527). The planning is `booking-ledger-modification-posting.ts`;
 * this module asks the ledger what it holds, plans, and writes — inside the
 * caller's transaction, under the caller's `pg_advisory_xact_lock(1)`.
 *
 * ONLY A BOOKING ALREADY CONFIRMED ON THE LEDGER POSTS (`bookingHasConfirmationLines`),
 * whatever its payment status (LANE-SYNC rule 1 on #3582). The settle confirms a
 * booking on the ledger once, and posts nothing if it already has; so once
 * confirmed, an edit's own lines are the only record of the change. An edit to a
 * booking not yet confirmed posts nothing: the confirmation, when it comes,
 * reads the booking as it then is. The question is asked under `lock(1)` —
 * which every edit door, the batch path and (since this issue) the review
 * completion already hold — because the settle asks it under the same key, so
 * an edit and a first settle cannot both see "not yet" and both post.
 *
 * Build in pure code, caught and logged; write unwrapped. A refused statement
 * has already aborted the transaction (#3590's review), so the write is never
 * the thing anyone is invited to swallow.
 */
import type { ManualRefundTaskDirection, Prisma } from "@prisma/client";

import {
  planModificationChargeLines,
  planReviewClosureShareLines,
  pricingSideFromLiveLedger,
} from "@/lib/booking-ledger-modification-posting";
import {
  bookingHasConfirmationLines,
  findPostedAdjustmentLines,
  findPostedChargeLines,
} from "@/lib/booking-ledger-read";
import {
  buildBookingLedgerRows,
  writeBookingLedgerRows,
  type BookingLedgerPosting,
} from "@/lib/booking-ledger-write";
import { pricingSideFromWrittenGuests } from "@/lib/booking-modification-lines";
import type { ModificationPricingSides } from "@/lib/booking-modification-pricing";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";
import logger from "@/lib/logger";

type LedgerStore = Pick<Prisma.TransactionClient, "bookingLedgerLine">;

/**
 * One priced edit's lines, anchored on the `BookingModification` row it just
 * wrote. `sides` is what `computeModificationPricing` composed, or null where
 * the edit parked, stubbed its promotion figures, or could not compose them —
 * each of which posts nothing (`INV-MOD-040`).
 */
export async function postModificationLedgerLines({
  store,
  bookingId,
  lodgeId,
  bookingModificationId,
  sides,
  priceDiffCents,
  changeFeeCents,
  site,
}: {
  store: LedgerStore;
  bookingId: string;
  lodgeId: string;
  bookingModificationId: string;
  sides: ModificationPricingSides | null;
  priceDiffCents: number;
  changeFeeCents: number;
  site: string;
}): Promise<void> {
  if (sides === null) return;
  if (!(await bookingHasConfirmationLines(store, bookingId))) return;
  const postedLines = await findPostedChargeLines(store, bookingId);
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const plan = planModificationChargeLines({
      bookingId,
      lodgeId,
      bookingModificationId,
      before: sides.before,
      after: sides.after,
      changeFeeCents,
      expectedCents: priceDiffCents + changeFeeCents,
      postedLines,
    });
    if (plan.kind === "none") {
      logger.warn(
        { bookingId, bookingModificationId, site, reason: plan.reason, plannedCents: plan.plannedCents },
        "Booking ledger: an edit's lines were not posted; the edit stands and the gap is the census's to report (#3582)",
      );
      return;
    }
    rows = buildBookingLedgerRows(plan.postings);
  } catch (error) {
    logger.error(
      { err: error, bookingId, bookingModificationId, site },
      "Booking ledger: could not build an edit's lines; the edit stands and the gap is the census's to report (#3582)",
    );
    return;
  }
  await writeBookingLedgerRows(store, rows);
}

/**
 * A parked review closing: the re-price's lines under the `PRICE_REBASE`
 * history row the re-base wrote (`rebaseHistoryId`; with no row nothing moved
 * and none post), then what the closure posts beside them, decided at booking
 * grain by `planReviewClosureShareLines` — design §5.3 is the rule.
 */
export async function postReviewClosureLedgerLines({
  store,
  bookingId,
  lodgeId,
  manualRefundTaskId,
  rebase,
  rebaseHistoryId,
  settlement,
  note,
  officerMemberId,
}: {
  store: Pick<Prisma.TransactionClient, "bookingLedgerLine" | "bookingGuest">;
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  /** What the re-base did, or null where it declined. */
  rebase: BookingPriceRebase | null;
  /** The `PRICE_REBASE` row it wrote, or null where it wrote none. */
  rebaseHistoryId: string | null;
  /** The completed share, or null on a dismissal. */
  settlement: { direction: ManualRefundTaskDirection; amountCents: number } | null;
  note: string | null;
  officerMemberId: string;
}): Promise<void> {
  if (!(await bookingHasConfirmationLines(store, bookingId))) return;

  const postedLines = rebase === null ? [] : await findPostedChargeLines(store, bookingId);
  let repricePostings: BookingLedgerPosting[] = [];
  let repriceRows: ReturnType<typeof buildBookingLedgerRows> = [];
  if (rebase !== null && rebaseHistoryId !== null) {
    const guests = await store.bookingGuest.findMany({
      where: { bookingId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        ageTier: true,
        isMember: true,
        rateMembershipTypeId: true,
        nights: { select: { stayDate: true, priceCents: true } },
      },
    });
    try {
      const before = pricingSideFromLiveLedger(postedLines, guests, rebase.previousPromoAdjustmentCents);
      const plan =
        before === null
          ? ({ kind: "none", reason: "NO_LIVE_LINE" } as const)
          : planModificationChargeLines({
              bookingId,
              lodgeId,
              bookingModificationId: rebaseHistoryId,
              before,
              after: pricingSideFromWrittenGuests(guests, {
                promoAdjustmentCents: rebase.newPromoAdjustmentCents,
              }),
              changeFeeCents: 0,
              expectedCents: rebase.newFinalPriceCents - rebase.previousFinalPriceCents,
              postedLines,
            });
      if (plan.kind === "none") {
        logger.warn(
          { bookingId, manualRefundTaskId, rebaseHistoryId, reason: plan.reason },
          "Booking ledger: a review closure's re-price was not posted; the gap is the census's to report (#3582)",
        );
      } else {
        repriceRows = buildBookingLedgerRows(plan.postings);
        repricePostings = plan.postings;
      }
    } catch (error) {
      repriceRows = [];
      repricePostings = [];
      logger.error(
        { err: error, bookingId, manualRefundTaskId, rebaseHistoryId },
        "Booking ledger: could not build a review closure's re-price lines; the gap is the census's to report (#3582)",
      );
    }
  }

  const postedAdjustmentLines = await findPostedAdjustmentLines(store, bookingId);
  let shareRows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    shareRows = buildBookingLedgerRows(
      planReviewClosureShareLines({
        bookingId,
        lodgeId,
        manualRefundTaskId,
        officerMemberId,
        note,
        settlement,
        rebasedFinalPriceCents: rebase?.newFinalPriceCents ?? null,
        chargeLinesAfter: [...postedLines, ...repricePostings],
        repriceRecordsMovement:
          rebase !== null &&
          rebase.newFinalPriceCents !== rebase.previousFinalPriceCents &&
          repricePostings.length > 0,
        postedAdjustmentLines,
      }),
    );
  } catch (error) {
    logger.error(
      { err: error, bookingId, manualRefundTaskId },
      "Booking ledger: could not build a review closure's share lines; the gap is the census's to report (#3582)",
    );
  }

  await writeBookingLedgerRows(store, [...repriceRows, ...shareRows]);
}
