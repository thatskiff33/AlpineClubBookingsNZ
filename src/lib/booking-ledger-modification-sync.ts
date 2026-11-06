import "server-only";

/**
 * POST AN EDIT'S LINES, AND A REVIEW CLOSURE'S, TO THE BOOKING LEDGER (#3582,
 * programme #3527). The planning is `booking-ledger-modification-posting.ts`;
 * this module asks the ledger what it holds, plans, and writes — inside the
 * caller's transaction, under the caller's `pg_advisory_xact_lock(1)`.
 *
 * Only a booking already confirmed on the ledger posts
 * (`bookingHasConfirmationLines`), asked under that key: design
 * `docs/design/booking-ledger.md` §5.1 and §4.1a.
 *
 * Build in pure code, caught and logged; write unwrapped. A refused statement
 * has already aborted the transaction (#3590's review), so the write is never
 * the thing anyone is invited to swallow.
 *
 * #4627 (Ledger M3b, R02/R03 and R21): the lines then post into the
 * member-money journal in the same transaction, from the context the door
 * resolved before it opened, for a booking whose confirmation is there. A
 * journal refusal is never caught: it rolls the edit or the closure back.
 *
 * #4628 (M3c): an edit of a booking not yet confirmed on the ledger re-states
 * its pending journal charge instead (`booking-ledger-pending-charge.ts`).
 */
import type { BookingModification, ManualRefundTaskDirection, Prisma } from "@prisma/client";

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
import { rebasedPriceMovementCents } from "@/lib/booking-review-price-rebase-history";
import logger from "@/lib/logger";
import { postBookingLedgerJournal, type BookingJournalContext } from "@/lib/member-money/doors";
import { postPendingModificationCharge } from "@/lib/booking-ledger-pending-charge";

/**
 * One priced edit's lines, anchored on the `BookingModification` row it just
 * wrote. `sides` is what `computeModificationPricing` composed — each night of
 * the before side at its valued figure (#4317, `INV-MOD-028`) — or null where
 * the edit stubbed its promotion figures or could not compose them, each of
 * which posts nothing.
 *
 * The figures the lines must sum to are READ FROM THAT ROW, never handed over
 * beside it, so the ledger and the edit's own history cannot be given two
 * different change fees (#3740 SSOT F5).
 */
export async function postModificationLedgerLines({
  store,
  journal,
  bookingId,
  lodgeId,
  bookingModification,
  sides,
  site,
}: {
  store: Prisma.TransactionClient;
  /** The context the edit resolved before its transaction (`INV-LOCK-004`). */
  journal: BookingJournalContext;
  bookingId: string;
  lodgeId: string;
  bookingModification: Pick<BookingModification, "id" | "priceDiffCents" | "changeFeeCents">;
  sides: ModificationPricingSides | null;
  site: string;
}): Promise<void> {
  const { id: bookingModificationId, priceDiffCents, changeFeeCents } = bookingModification;
  if (!(await bookingHasConfirmationLines(store, bookingId))) {
    // #4628: no legacy line yet, but a bank-transfer booking bound before
    // settlement carries its charge in the journal; this edit re-states it from
    // the stored rows the edit just wrote (a booking never bound posts nothing).
    await postPendingModificationCharge(store, journal, { bookingId, lodgeId, modificationId: bookingModificationId });
    return;
  }
  if (sides === null) return;
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
  if (rows.length > 0) {
    await postBookingLedgerJournal(store, journal, {
      bookingId,
      lodgeId,
      event: { kind: "modification", modificationId: bookingModificationId },
      postingKeys: rows.flatMap((row) => (row.postingKey ? [row.postingKey] : [])),
    });
  }
}

/**
 * A parked review closing: the re-price's lines under the `PRICE_REBASE`
 * history row the re-base wrote (`rebaseHistoryId`; with no row nothing moved
 * and none post), then what the closure posts beside them, decided at booking
 * grain by `planReviewClosureShareLines` — design §5.3 is the rule.
 */
export async function postReviewClosureLedgerLines({
  store,
  journal,
  bookingId,
  lodgeId,
  manualRefundTaskId,
  rebase,
  rebaseHistoryId,
  settlement,
  note,
  officerMemberId,
  agreedGiveBackCents = null,
}: {
  store: Prisma.TransactionClient;
  /** The context the closure resolved before its transaction (`INV-LOCK-004`). */
  journal: BookingJournalContext;
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
  /** #3791: see `planReviewClosureShareLines`. */
  agreedGiveBackCents?: number | null;
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
              expectedCents: rebasedPriceMovementCents(rebase),
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
          rebasedPriceMovementCents(rebase) !== 0 &&
          repricePostings.length > 0,
        postedAdjustmentLines,
        agreedGiveBackCents,
      }),
    );
  } catch (error) {
    logger.error(
      { err: error, bookingId, manualRefundTaskId },
      "Booking ledger: could not build a review closure's share lines; the gap is the census's to report (#3582)",
    );
  }

  const rows = [...repriceRows, ...shareRows];
  await writeBookingLedgerRows(store, rows);
  if (rows.length > 0) {
    await postBookingLedgerJournal(store, journal, {
      bookingId,
      lodgeId,
      event: { kind: "review-close", taskId: manualRefundTaskId, officerMemberId },
      postingKeys: rows.flatMap((row) => (row.postingKey ? [row.postingKey] : [])),
    });
  }
}
