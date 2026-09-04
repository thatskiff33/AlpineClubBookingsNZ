import "server-only";

import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { requireCalendarDate } from "@/lib/club-time";
import {
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  type BookingStayRange,
} from "@/lib/booking-guest-stay-ranges";
import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
} from "@/lib/edit-financial-review-context";
import { OPEN_EDIT_FINANCIAL_REVIEW_TASK_FILTER } from "@/lib/edit-financial-review";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  storedNightPricesByKey,
  storedSoldPriceEvidenceForGuest,
} from "@/lib/stored-sold-price-evidence";
import {
  checkStoredNightPriceRepair,
  STRAND_RECONCILE_NOT_OFFERED_MESSAGE,
  STRAND_RECONCILE_REVIEW_OPEN_MESSAGE,
  STRAND_RECONCILE_WRONG_BOOKING_MESSAGE,
  type RecordedNightPrice,
  type StrandNightPriceOffer,
  type UnpricedNightsSummary,
} from "@/lib/stored-night-price-repair";
import {
  applyStrandNightPriceReconcile,
  type FencedNightWrite,
} from "@/lib/stored-night-price-repair-store";

/**
 * #3214 (epic #2797): recording what a guest strand's nights sold for, on a
 * booking whose stored evidence cannot be read back at all.
 *
 * ## Why this exists
 *
 * #3191 gave an officer one way to fill in a blank night price: settling the
 * `EDIT_FINANCIAL_REVIEW` an edit raised. That covers a strand whose rows exist
 * and some of which are `NULL`, and nothing else. Two shapes it does not cover
 * are exactly the shapes a QUOTE-PRICED booking arrives in - a strand with no
 * night rows at all, whose nights come from the stay envelope, and a strand
 * whose rows are all readable but do not add up to the stored total. Both are
 * documented populations of the #2739 backfill.
 *
 * On such a booking nothing could reach the repair, because nothing could raise
 * the review: `QUOTE_PRICED_EDIT_BLOCK_MESSAGE` refuses every edit that could
 * park, and #3214's own refusal now closes the one door that was left. So the
 * refusal's closing sentence - those nights have to carry a price first - had
 * no route behind it. This module is that route.
 *
 * ## The rule, and why the act is safe by arithmetic rather than by policy
 *
 * The rule itself is stated once, in `stored-night-price-repair.ts`'s module
 * docblock, and is not restated here (`INV-SSOT`). What this module owns is the
 * two things that make it hold:
 *
 *  1. **The eligibility fence.** {@link strandNightPriceOfferForGuest} answers
 *     `null` for a strand that already reconciles. Without it this would be a
 *     general re-pricer for any booking an officer felt like re-apportioning,
 *     which is precisely what epic #2797 exists to prevent.
 *  2. **The no-op guarantee.** The officer is asked for every night the strand
 *     holds, so `knownNightTotalCents` is 0; nothing is being settled, so
 *     `deltaCents` is 0. `checkStoredNightPriceRepair` therefore forces
 *     `sum(entries) === BookingGuest.priceCents` as stored, and the writer
 *     re-bases the total to `0 + sum(entries)` - the same number. The total
 *     write is provably a no-op, so this act cannot change what anybody owes,
 *     whatever is typed into the boxes. Both halves are ASSERTED below rather
 *     than trusted, because a claim about money is worth what its check is
 *     worth. What that guarantee does and does not extend to is the next
 *     section, and it is narrower than "changes nothing else".
 *
 * ## WHAT THE NO-OP GUARANTEE COVERS, AND WHAT IT DOES NOT
 *
 * It covers THE MEMBER'S TOTAL, precisely and only: `BookingGuest.priceCents` is
 * re-based to the number already in it, so nothing anybody owes moves, no
 * settlement is created, no credit is written and no provider is called. That is
 * the whole of the claim, which is why the copy everywhere says "what anybody
 * owes" rather than "anything". The unqualified sentence would be false: two
 * things elsewhere read the NIGHT ROWS rather than the strand total, and both
 * move when this act writes.
 *
 *  1. **The member's NOMINATION eligibility.** `countMemberStayNights`
 *     (`member-stay-nights.ts`) counts `BookingGuestNight` rows, so a member
 *     strand holding NO rows contributes nothing to the nomination gate's
 *     `minimumNights` today and contributes every night of the stay once the
 *     create arm has run. A member whose only committed stay is a three-night
 *     converted request can therefore become able to nominate the moment an
 *     officer records what those nights sold for. THE NEW NUMBER IS THE TRUER
 *     ONE - `INV-CAP-032` is that a guest with no night rows is one the system
 *     believes is nowhere - so this is a correction of the same kind the
 *     capacity paragraph in `docs/CONCURRENCY_AND_LOCKING.md` welcomes, not a
 *     defect. It is written down because it is invisible from the screen: the
 *     officer is not thinking about who may nominate, and nothing on the page
 *     would tell them.
 *  2. **Which MONTH the club's income lands in.** `loadBookingHutFees`
 *     (`finance-revenue-reconciliation.ts`) sums night prices inside a DATE
 *     WINDOW. Filling or creating rows adds revenue into a window, which closes
 *     the positive Xero variance that function's own docblock describes and is
 *     the point. But on the `STORED_TOTAL_MISMATCH` shape this act
 *     RE-APPORTIONS within a fixed total, and a stay crossing a month end
 *     therefore moves income between two months while the booking's total is
 *     unchanged: 31 Jul + 1 Aug stored $40/$40 against a stored total of $100,
 *     recorded as the true $0/$100, drops July's hut-fee figure by $40 and
 *     raises August's by $60, so a July reconciliation already reported to the
 *     committee no longer reproduces. Recoverable rather than lost - the audit
 *     entry carries `previousNightPrices` - and the officer is told about the
 *     month end on screen before they record.
 *
 * ## What it deliberately does NOT do
 *
 *  - it does not repair a strand whose stored TOTAL is not usable money. There
 *    is nothing sound to reconcile against, and what those rows should become is
 *    #2745's audited decision, not this one's;
 *  - it does not run while an `EDIT_FINANCIAL_REVIEW` is open on the booking.
 *    The settle screen owns these figures then, and its target includes the
 *    settlement delta - two surfaces asking for the same numbers against
 *    different targets is how an officer records a set that one of them
 *    refuses. Settling first and reconciling second terminates;
 *  - it derives nothing. There is no even split, no rate lookup, no remainder
 *    and no default anywhere in this feature, which
 *    `stored-night-price-repair-census.test.ts` scans for by name.
 */

/** The strand shape this module reads, as every caller loads it. */
type ReconcilableGuest = {
  id: string;
  firstName: string;
  lastName: string;
  /** `BookingGuest.priceCents` as stored. */
  priceCents: number;
  stayStart: Date | null;
  stayEnd: Date | null;
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
};

/**
 * The raw stored value of each night row this strand HAS, keyed by lodge night.
 *
 * A KEY BEING ABSENT MEANS THERE IS NO ROW, which is the distinction the write
 * fence rests on and the one thing `storedNightPricesByKey` deliberately
 * collapses: to a reader an absent row and a row holding a negative number are
 * both "no usable price", and to a compare-and-set they are completely different
 * - one has to be created, the other has to be matched on the exact value it
 * holds. The same split `unpricedNightsSummaryForGuest` records for its own
 * `NULL` test, for the same reason.
 *
 * Keyed one row at a time through the canonical helper, never by converting
 * `stayDate` here: a price keyed even slightly differently from its night would
 * never match it and the failure would be silent (`INV-DATE-020`).
 */
function rawStoredNightRowsByKey(
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>,
): Map<string, number | null> {
  const byKey = new Map<string, number | null>();
  for (const night of nights) {
    const [key] = getExplicitGuestBedNightKeys({ nights: [night] }) ?? [];
    if (key !== undefined) byKey.set(key, night.priceCents);
  }
  return byKey;
}

/**
 * May this strand's nights be recorded, and against what?
 *
 * `null` on every strand where the answer is no, and there are exactly two ways
 * to get one:
 *
 *  - **the stored total is not usable money.** Nothing sound to reconcile to;
 *    #2745's territory, refused here rather than repaired.
 *  - **the strand already reconciles.** THE ELIGIBILITY FENCE, and the
 *    anti-abuse rule of the whole feature: a strand whose rows are readable and
 *    add up is priced, and re-apportioning it is a re-price by another name. The
 *    verdict is the SAME classifier every edit path consults
 *    (`storedSoldPriceEvidenceForGuest`), so "readable" cannot come to mean one
 *    thing here and another there.
 *
 * A strand holding no nights at all also answers `null` - there is nothing to
 * ask for - which is only reachable on a degenerate zero-night envelope.
 */
export function strandNightPriceOfferForGuest(
  guest: ReconcilableGuest,
  booking: BookingStayRange,
): StrandNightPriceOffer | null {
  if (!isNonNegativeIntegerCents(guest.priceCents)) return null;

  const evidence = storedSoldPriceEvidenceForGuest(guest, booking);
  if (evidence.kind === "exact") return null;

  const dates = getGuestBedNightKeys(guest, booking)
    .map((key) => requireCalendarDate(key))
    .sort();
  if (dates.length === 0) return null;

  const usableByKey = storedNightPricesByKey(guest.nights);
  return {
    bookingGuestId: guest.id,
    guestName: `${guest.firstName} ${guest.lastName}`.trim(),
    cause: evidence.cause,
    summary: {
      dates,
      // Nothing on this strand counts as already known: the officer is asked
      // for every night it holds, which is what makes the target the stored
      // total flat and the total write a no-op.
      knownNightTotalCents: 0,
      storedGuestTotalCents: guest.priceCents,
    },
    storedByDate: dates.map((date) => ({
      date,
      priceCents: usableByKey.get(date) ?? null,
    })),
  };
}

/**
 * Every strand on one booking that could be recorded, for the booking's own
 * admin tools.
 *
 * ONE QUERY for the whole booking rather than one per guest, and it deliberately
 * does NOT widen `GUEST_SELECT` or any finance-queue reader in
 * `stored-night-price-repair-store.ts`: those serve a screen that must not learn
 * a guest strand's id, and this one serves a page whose viewer already sees
 * every guest by name.
 *
 * An empty array for a booking that does not exist, so a caller renders nothing
 * rather than deciding what a missing booking means.
 */
export async function strandNightPriceOffersForBooking(
  bookingId: string,
  store: Prisma.TransactionClient,
): Promise<StrandNightPriceOffer[]> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    select: {
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          priceCents: true,
          stayStart: true,
          stayEnd: true,
          nights: { select: { stayDate: true, priceCents: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!booking) return [];

  const offers: StrandNightPriceOffer[] = [];
  for (const guest of booking.guests) {
    const offer = strandNightPriceOfferForGuest(guest, booking);
    if (offer) offers.push(offer);
  }
  return offers;
}

/** One checked reconcile, ready to write on the caller's transaction. */
export type StrandNightPriceReconcilePlan = {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  cause: EditFinancialReviewCause;
  /** The booking's own member, for the audit entry's subject. */
  subjectMemberId: string;
  summary: UnpricedNightsSummary;
  writes: readonly FencedNightWrite[];
};

/**
 * Turn what the officer typed into a plan, or throw the refusal that stops it.
 *
 * EVERYTHING IS RE-READ ON THE CALLER'S TRANSACTION and nothing is trusted from
 * the browser: which nights the strand holds, what each of them currently
 * carries, whether the strand is still eligible, and whether a review has opened
 * on the booking since the page rendered. A screen minutes old is exactly how a
 * figure ends up written against a night the booking no longer holds, and the
 * request shape has no field with which to assert any of it.
 *
 * The order is deliberate. The booking-scope check comes first, so a strand
 * belonging to another booking is a 404 that reveals nothing about it. The open
 * review comes next, because while one is open these figures belong to the
 * settle screen whatever the strand looks like.
 */
export async function planStrandNightPriceReconcile({
  bookingId,
  bookingGuestId,
  entries,
  store,
}: {
  bookingId: string;
  bookingGuestId: string;
  entries: readonly RecordedNightPrice[];
  store: Prisma.TransactionClient;
}): Promise<StrandNightPriceReconcilePlan> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true, checkIn: true, checkOut: true },
  });
  if (!booking) {
    throw new ManualBookingPaymentError(
      STRAND_RECONCILE_WRONG_BOOKING_MESSAGE,
      404,
    );
  }

  const guest = await store.bookingGuest.findFirst({
    where: { id: bookingGuestId, bookingId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      priceCents: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true, priceCents: true } },
    },
  });
  if (!guest) {
    throw new ManualBookingPaymentError(
      STRAND_RECONCILE_WRONG_BOOKING_MESSAGE,
      404,
    );
  }

  // The shared predicate, on this transaction, rather than a second spelling of
  // "a review is open" (`INV-SSOT`).
  const openReview = await store.manualRefundTask.findFirst({
    where: { bookingId, ...OPEN_EDIT_FINANCIAL_REVIEW_TASK_FILTER },
    select: { id: true },
  });
  if (openReview) {
    throw new ManualBookingPaymentError(
      STRAND_RECONCILE_REVIEW_OPEN_MESSAGE,
      409,
    );
  }

  const offer = strandNightPriceOfferForGuest(guest, booking);
  if (offer === null) {
    throw new ManualBookingPaymentError(
      STRAND_RECONCILE_NOT_OFFERED_MESSAGE,
      409,
    );
  }

  const check = checkStoredNightPriceRepair({
    summary: offer.summary,
    entries,
    // Nothing is being settled here, so nothing moves what the stay is worth.
    deltaCents: 0,
  });
  if (!check.ok) {
    throw new ManualBookingPaymentError(check.message, 400);
  }

  /*
    THE NO-OP GUARANTEE, CHECKED. `checkStoredNightPriceRepair` has already
    forced the typed amounts to sum to `check.targetCents`; this asserts that
    that target really is the strand's stored total and nothing else, which is
    what makes the re-base below a write of the number already on file. It is
    cheap, and it turns "this cannot change what anybody owes" from a claim into
    a property. An internal error rather than an officer-facing refusal on
    purpose: nothing the officer typed could reach it, so there is no advice to
    give them.
  */
  if (check.targetCents !== offer.summary.storedGuestTotalCents) {
    logger.error(
      {
        bookingId,
        bookingGuestId,
        targetCents: check.targetCents,
        storedGuestTotalCents: offer.summary.storedGuestTotalCents,
      },
      "Strand night-price reconcile computed a target that is not the strand's stored total",
    );
    throw new Error(
      "Refusing to record night prices against a target that is not the strand's stored total.",
    );
  }

  const stored = rawStoredNightRowsByKey(guest.nights);
  return {
    bookingId,
    bookingGuestId: guest.id,
    guestName: offer.guestName,
    cause: offer.cause,
    subjectMemberId: booking.memberId,
    summary: offer.summary,
    writes: check.entries.map((entry) => ({
      date: entry.date,
      priceCents: entry.priceCents,
      expectedPriceCents: stored.get(entry.date) ?? null,
      rowExists: stored.has(entry.date),
    })),
  };
}

/**
 * Write the plan and audit it, on the caller's transaction.
 *
 * AUDITED UNDER ITS OWN ACTION rather than the settle-time one. They are
 * different acts: `booking-payment.stored-night-price.record` accompanies a
 * settlement that moved money, and this one is money-neutral by construction, so
 * folding them together would make a money-neutral correction indistinguishable
 * from a settlement in the log an officer searches.
 *
 * THE ENTRY CARRIES BOTH TOTALS AND THE PREVIOUS PER-NIGHT VALUES. Both totals,
 * because a pair of identical figures is what makes the no-op VISIBLE to
 * somebody reading the log rather than something they have to take on trust; the
 * previous values, because within a fixed total this act can re-apportion what
 * each night is recorded as having sold for, and that is the part a future
 * partial refund will compute against.
 */
export async function recordStrandNightPriceReconcile({
  plan,
  actingMemberId,
  note,
  store,
}: {
  plan: StrandNightPriceReconcilePlan;
  actingMemberId: string;
  note: string | null;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const { newGuestTotalCents, rowsCreated } =
    await applyStrandNightPriceReconcile({
      bookingGuestId: plan.bookingGuestId,
      summary: plan.summary,
      writes: plan.writes,
      store,
    });

  /*
    THE SAME GUARANTEE, RE-CHECKED AFTER THE WRITE, lives in
    `applyStrandNightPriceReconcile` itself rather than here (#3214 review): it
    is a property of the WRITER, whose name carries the promise, not of this one
    caller. It throws inside the caller's transaction, so the rows go back with
    it, and `newGuestTotalCents` below is therefore already known to be the
    strand's stored total.
  */

  await createAuditLog(
    {
      action: "booking-payment.stored-night-price.reconcile",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: plan.subjectMemberId,
      targetId: plan.bookingId,
      entityType: "BookingGuest",
      entityId: plan.bookingGuestId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary:
        "Recorded what a booking guest's nights sold for, leaving what the stay is worth unchanged",
      details: note,
      metadata: {
        bookingId: plan.bookingId,
        cause: plan.cause,
        nightPrices: plan.writes.map((write) => ({
          date: write.date,
          priceCents: write.priceCents,
        })),
        previousNightPrices: plan.writes.map((write) => ({
          date: write.date,
          priceCents: write.rowExists ? write.expectedPriceCents : null,
          hadStoredRow: write.rowExists,
        })),
        storedGuestTotalCents: plan.summary.storedGuestTotalCents,
        newGuestTotalCents,
        rowsCreated,
        note,
      },
    },
    store,
  );
}
