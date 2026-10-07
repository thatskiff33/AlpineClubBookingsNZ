import type { MemberGuestConsentStatus } from "@prisma/client";

import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";

// Moved out of `booking-review-price-rebase.ts` unchanged (#3827), so the
// guest-acceptance re-price — reached from the consent sweep, where that
// module's `server-only` guard would throw at import — reads a booking's
// strands through the SAME rule rather than a second copy (`INV-SSOT-001`).

export type RebaseStrand = {
  id: string;
  priceCents: number;
  memberId: string | null;
  isMember: boolean;
  consentStatus: MemberGuestConsentStatus | null;
  nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
};

export type StrandNightPrices = {
  bookingGuestId: string;
  memberId: string | null;
  isMember: boolean;
  consentStatus: MemberGuestConsentStatus | null;
  perNightRates: number[];
  nightDates: Date[];
};

/**
 * Each surviving strand's nights as exact money, or `null` the moment one cannot
 * be read back that way.
 *
 * THE THREE CONDITIONS ARE `INV-MOD-028` APPLIED TO THE WHOLE BOOKING rather
 * than to one strand. A strand with no night rows has a stay envelope and no
 * evidence; a row that is not usable money is an absence of evidence and not a
 * price; and rows that do not sum to the strand's stored total are two stored
 * numbers disagreeing, which is a decision about which one is wrong rather than
 * a number anybody has. Feeding any of those to the promotion would re-price the
 * booking from evidence the system has already said it cannot read.
 *
 * The rows are sorted by date so `perNightRates` and `nightDates` are parallel
 * and in stay order, which is what an internal work-party promo's night window
 * is applied against.
 *
 * A STATED LIMIT, pre-existing and deliberately not closed here: the three
 * conditions require the rows to EXIST, to be usable money and to SUM to the
 * strand's stored total - never that they span the strand's stay envelope. A
 * strand whose stored total is covered by fewer rows than it has nights reads
 * back as exact, and the booking's total is unaffected either way because that
 * sums `BookingGuest.priceCents`. What can be short is the per-night VECTOR
 * handed to the promotion, so a free-nights or night-windowed code re-caps
 * against a shorter stay than the guest actually has. Moving the trigger (#3257)
 * builds that vector on more closures without changing when it can be short.
 * Closing it needs a stay envelope this writer is not given, and belongs with
 * the writers that create the night rows.
 */
export function readStrandNightPrices(
  guests: readonly RebaseStrand[],
): StrandNightPrices[] | null {
  const read: StrandNightPrices[] = [];
  for (const guest of guests) {
    if (!isNonNegativeIntegerCents(guest.priceCents)) return null;
    if (guest.nights.length === 0) return null;
    const nights = [...guest.nights].sort(
      (a, b) => a.stayDate.getTime() - b.stayDate.getTime(),
    );
    let sum = 0;
    const perNightRates: number[] = [];
    const nightDates: Date[] = [];
    for (const night of nights) {
      if (night.priceCents === null) return null;
      if (!isNonNegativeIntegerCents(night.priceCents)) return null;
      sum += night.priceCents;
      perNightRates.push(night.priceCents);
      nightDates.push(night.stayDate);
    }
    if (sum !== guest.priceCents) return null;
    read.push({
      bookingGuestId: guest.id,
      memberId: guest.memberId,
      isMember: guest.isMember,
      consentStatus: guest.consentStatus,
      perNightRates,
      nightDates,
    });
  }
  return read;
}

