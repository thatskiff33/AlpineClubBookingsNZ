import type { BookingGuestNightPriceSource } from "@prisma/client";

import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import {
  deriveNightAdjustmentState,
  memberBenefitAllocations,
} from "@/lib/night-adjustment-write";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";

export const BOOKING_MONEY_RECONCILIATION_REASON_ORDER = [
  "NO_SURVIVING_STRANDS",
  "STRAND_EVIDENCE_UNREADABLE",
  // #3547. Split out of `STRAND_EVIDENCE_UNREADABLE`, which was covering three
  // causes with opposite answers to "can anybody do something about this?".
  // Prices recorded as an even share, and prices never recorded at all, mean
  // the figures do not exist — nobody can check those, today or ever. But
  // prices that do not add up to that guest's OWN recorded total is a
  // disagreement between two numbers that are both on file, which is exactly
  // the finding this reconciliation exists to surface. Bundled together, the
  // actionable one wore the quiet "cannot be checked" wording and nobody
  // looked.
  "STRAND_TOTAL_DISAGREES",
  "HEADLINE_TOTAL_MISMATCH",
  "PROMO_BUILD_UP_NOT_KNOWN",
  "PROMO_BUILD_UP_MISMATCH",
  "DISCOUNT_COMPONENT_MISMATCH",
  "FINAL_PRICE_RELATION_MISMATCH",
] as const;

export type BookingMoneyReconciliationReason =
  (typeof BOOKING_MONEY_RECONCILIATION_REASON_ORDER)[number];

/**
 * The two #3257 decline spellings remain part of its stored audit contract.
 * This map is their one route into Stage 4's canonical reason vocabulary.
 */
export const BOOKING_REBASE_DECLINE_RECONCILIATION_REASON = {
  "no-surviving-strands": "NO_SURVIVING_STRANDS",
  "strand-evidence-unreadable": "STRAND_EVIDENCE_UNREADABLE",
} as const satisfies Record<string, BookingMoneyReconciliationReason>;

export type BookingPriceRebaseDeclineReason =
  keyof typeof BOOKING_REBASE_DECLINE_RECONCILIATION_REASON;

export type BookingMoneyReconciliation =
  | { state: "RECONCILED"; reasons: readonly [] }
  | {
      state: "UNRECONCILED";
      reasons: readonly [
        BookingMoneyReconciliationReason,
        ...BookingMoneyReconciliationReason[],
      ];
    };

export type BookingMoneyReconciliationSummary = {
  totalBookings: number;
  byState: { RECONCILED: number; UNRECONCILED: number };
  byReason: Record<BookingMoneyReconciliationReason, number>;
};

export type BookingMoneyReconciliationProjection = {
  checkIn: Date;
  checkOut: Date;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  finalPriceCents: number;
  guests: ReadonlyArray<{
    priceCents: number;
    stayStart: Date | null;
    stayEnd: Date | null;
    nights: ReadonlyArray<{
      stayDate: Date;
      priceCents: number | null;
      priceSource: BookingGuestNightPriceSource;
    }>;
  }>;
  promoRedemption: {
    priceAdjustmentCents: number;
    allocations: ReadonlyArray<{
      memberId: string | null;
      priceAdjustmentCents: number;
    }>;
  } | null;
  nightAdjustments: ReadonlyArray<{
    beneficiaryMemberId: string;
    amountCents: number | null;
  }>;
};

/**
 * Classify the four stored booking-money identities from one coherent snapshot.
 * This is deliberately pure: transaction-owning callers supply their own
 * post-lock projection, and read-only callers classify the projection they
 * already loaded. It never repairs, reprices, or turns unknown evidence into
 * zero.
 */
export function reconcileBookingMoney(
  booking: BookingMoneyReconciliationProjection,
): BookingMoneyReconciliation {
  const found = new Set<BookingMoneyReconciliationReason>();

  if (booking.guests.length === 0) {
    found.add("NO_SURVIVING_STRANDS");
  } else {
    let guestTotalCents = 0;
    let allStrandsReadable = true;
    for (const guest of booking.guests) {
      const evidence = storedSoldPriceEvidenceForGuest(
        guest,
        booking,
        "WHOLE_GUEST",
      );
      if (evidence.kind === "unusable") {
        // Still unusable for SUMMING either way, so the headline comparison
        // below stays suppressed — what differs is only what the booking is
        // told to say about why (#3547).
        allStrandsReadable = false;
        found.add(
          evidence.cause === "STORED_TOTAL_MISMATCH"
            ? "STRAND_TOTAL_DISAGREES"
            : "STRAND_EVIDENCE_UNREADABLE",
        );
        continue;
      }
      guestTotalCents += evidence.totalCents;
    }
    if (allStrandsReadable && guestTotalCents !== booking.totalPriceCents) {
      found.add("HEADLINE_TOTAL_MISMATCH");
    }
  }

  const adjustmentState = deriveNightAdjustmentState({
    rows: booking.nightAdjustments,
    redemption: booking.promoRedemption && {
      priceAdjustmentCents: booking.promoRedemption.priceAdjustmentCents,
      allocations: memberBenefitAllocations(booking.promoRedemption.allocations),
    },
  });
  if (adjustmentState === "NOT_KNOWN") {
    found.add("PROMO_BUILD_UP_NOT_KNOWN");
  } else {
    const recordedBuildUpCents = booking.nightAdjustments.reduce(
      (sum, row) => sum + (row.amountCents ?? 0),
      0,
    );
    if (recordedBuildUpCents !== booking.promoAdjustmentCents) {
      found.add("PROMO_BUILD_UP_MISMATCH");
    }
  }

  if (booking.discountCents !== Math.max(0, -booking.promoAdjustmentCents)) {
    found.add("DISCOUNT_COMPONENT_MISMATCH");
  }

  if (
    booking.finalPriceCents !==
    bookingFinalPriceCents({
      totalPriceCents: booking.totalPriceCents,
      promoAdjustmentCents: booking.promoAdjustmentCents,
    })
  ) {
    found.add("FINAL_PRICE_RELATION_MISMATCH");
  }

  const reasons = BOOKING_MONEY_RECONCILIATION_REASON_ORDER.filter((reason) =>
    found.has(reason),
  );
  return reasons.length === 0
    ? { state: "RECONCILED", reasons: [] }
    : {
        state: "UNRECONCILED",
        reasons: reasons as [
          BookingMoneyReconciliationReason,
          ...BookingMoneyReconciliationReason[],
        ],
      };
}

export function summarizeBookingMoneyReconciliations(
  bookings: ReadonlyArray<BookingMoneyReconciliationProjection>,
): BookingMoneyReconciliationSummary {
  const byReason = Object.fromEntries(
    BOOKING_MONEY_RECONCILIATION_REASON_ORDER.map((reason) => [reason, 0]),
  ) as Record<BookingMoneyReconciliationReason, number>;
  let reconciled = 0;
  for (const booking of bookings) {
    const result = reconcileBookingMoney(booking);
    if (result.state === "RECONCILED") {
      reconciled += 1;
      continue;
    }
    for (const reason of result.reasons) byReason[reason] += 1;
  }
  return {
    totalBookings: bookings.length,
    byState: {
      RECONCILED: reconciled,
      UNRECONCILED: bookings.length - reconciled,
    },
    byReason,
  };
}
