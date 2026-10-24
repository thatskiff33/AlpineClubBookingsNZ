import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { canModifyBookingStatusForRole } from "@/lib/booking-edit-policy";
import { isSingleNightLine } from "@/lib/booking-ledger-charge-line";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { compareOrdinal } from "@/lib/ordinal-order";
import { valueEditStrand, type StoredEditStrand } from "@/lib/edit-night-valuation";

/**
 * #4317 review M3: WHICH BOOKINGS AN AUTO-PRICED EDIT WILL LEAVE UNPOSTED.
 *
 * Every edit now prices each held night at its `valueStrandNights` figure
 * (`INV-MOD-028`), and posts its ledger lines from those figures by reversing
 * the night's LIVE confirmation line (`planModificationChargeLines`, design
 * `booking-ledger.md` §5.1). Where a live single-night `GUEST_NIGHT` line
 * disagrees with the valued figure - a strand whose rows do not add up (R3), a
 * blank the confirmation skipped (R2), a line for a night the guest no longer
 * holds - the edit posts NOTHING (sum or nothing) and the booking-ledger census
 * counts it as an `UNPOSTED_EDIT` gap, which closes the cut-over gate until wave
 * B's re-base (D5) re-posts the lines. A park posted nothing too, but raised no
 * gap.
 *
 * This counts those bookings BEFORE the wave ships, so the owner can see how
 * many edits would land there. Pure and read-only: the caller reads the rows in
 * one repeatable-read snapshot (`censusBookingMoneyReconciliation`).
 */

export type LedgerNightValueCensus = {
  /**
   * Bookings an edit can still reach (not deleted, in a status an officer may
   * edit) with any line anchored on their CONFIRMATION: confirmed on the ledger.
   * A cancelled or deleted booking takes no edit, so it is never counted.
   */
  bookingsOnLedger: number;
  /** Of those, the bookings an edit could leave unposted. */
  bookingsWhoseLinesDifferFromValues: number;
  /** Live single-night lines whose unit price is not the night's valued figure, or for a night not held. */
  linesDifferingFromValues: number;
  /** Valued nights with no live single-night line for an edit to reverse. */
  valuedNightsWithoutLiveLine: number;
  /** Up to {@link SAMPLE_LIMIT} of those bookings' ids, in id order, for wave B's re-base. */
  sampleBookingIds: string[];
};

const SAMPLE_LIMIT = 100;

export type LedgerNightValueCensusInput = {
  bookings: ReadonlyArray<{
    id: string;
    checkIn: Date;
    checkOut: Date;
    status: string;
    deletedAt: Date | null;
  }>;
  guests: ReadonlyArray<StoredEditStrand & { id: string; bookingId: string }>;
  lines: ReadonlyArray<{
    id: string;
    bookingId: string;
    kind: string;
    sign: number;
    quantity: number;
    unitCents: number;
    bookingGuestId: string | null;
    nightStart: Date | null;
    nightEndExclusive: Date | null;
    reversesLineId: string | null;
    anchorKind: string;
  }>;
};

export function summarizeLedgerNightValues(
  input: LedgerNightValueCensusInput,
): LedgerNightValueCensus {
  const guestsByBooking = new Map<string, Array<LedgerNightValueCensusInput["guests"][number]>>();
  for (const guest of input.guests) {
    const list = guestsByBooking.get(guest.bookingId) ?? [];
    list.push(guest);
    guestsByBooking.set(guest.bookingId, list);
  }
  const linesByBooking = new Map<string, Array<LedgerNightValueCensusInput["lines"][number]>>();
  for (const line of input.lines) {
    const list = linesByBooking.get(line.bookingId) ?? [];
    list.push(line);
    linesByBooking.set(line.bookingId, list);
  }

  let bookingsOnLedger = 0;
  let linesDifferingFromValues = 0;
  let valuedNightsWithoutLiveLine = 0;
  const differing: string[] = [];

  for (const booking of [...input.bookings].sort((a, b) => compareOrdinal(a.id, b.id))) {
    // #4317 review round 2: only a booking an edit can still reach. The widest
    // door's statuses are the officer's (`canModifyBookingStatusForRole`).
    if (booking.deletedAt !== null || !canModifyBookingStatusForRole(booking.status, "ADMIN")) {
      continue;
    }
    const lines = linesByBooking.get(booking.id) ?? [];
    if (!lines.some((line) => line.anchorKind === "CONFIRMATION")) continue;
    bookingsOnLedger += 1;

    const liveNights = new Map<string, number[]>();
    for (const line of liveLines(lines)) {
      if (!isSingleNightLine(line)) continue;
      const key = `${line.bookingGuestId}|${calendarDateOfDateOnlyInstant(line.nightStart)}`;
      liveNights.set(key, [...(liveNights.get(key) ?? []), line.unitCents]);
    }

    let bookingDiffers = false;
    const valuedKeys = new Set<string>();
    for (const guest of guestsByBooking.get(booking.id) ?? []) {
      for (const night of valueEditStrand(guest, booking).nights) {
        const key = `${guest.id}|${night.date}`;
        valuedKeys.add(key);
        const live = liveNights.get(key);
        if (!live || live.length === 0) {
          valuedNightsWithoutLiveLine += 1;
          bookingDiffers = true;
        } else if (live.length !== 1 || live[0] !== night.valueCents) {
          linesDifferingFromValues += live.length;
          bookingDiffers = true;
        }
      }
    }
    for (const [key, live] of liveNights) {
      if (valuedKeys.has(key)) continue;
      linesDifferingFromValues += live.length;
      bookingDiffers = true;
    }
    if (bookingDiffers) differing.push(booking.id);
  }

  return {
    bookingsOnLedger,
    bookingsWhoseLinesDifferFromValues: differing.length,
    linesDifferingFromValues,
    valuedNightsWithoutLiveLine,
    sampleBookingIds: differing.slice(0, SAMPLE_LIMIT),
  };
}
