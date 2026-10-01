/**
 * THE SHAPE OF A GUEST-NIGHT LINE AND OF A PROMOTION LINE (#3582; programme
 * #3527, design `docs/design/booking-ledger.md` §5.1).
 *
 * One builder for every writer that posts either — the confirmation
 * (`booking-ledger-confirmation-posting.ts`) and an edit's or a closure's
 * re-price (`booking-ledger-modification-posting.ts`) — so a night reads the
 * same whichever event sold it, and one reader, `isSingleNightLine`, that is
 * the night builder's inverse: the grain a later edit reverses at is the grain
 * this module writes (`INV-SSOT-002`).
 *
 * Pure: no reads, no writes.
 */
import { calendarDateOfDateOnlyInstant, addCalendarDays, dateOnlyInstantOf } from "@/lib/club-time";
import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";

/** What a charge line is anchored on; the rest of its shape is this module's. */
export type ChargeLineAnchor = Pick<BookingLedgerPosting, "bookingId" | "lodgeId" | "anchorKind" | "anchorId">;

/**
 * The morning after a stored night, half-open like every stay range here.
 *
 * Through `club-time` rather than through `date-only`'s adapter (CT-6): the
 * stored value is a `@db.Date`, so it is DECODED to the calendar day it
 * encodes (`INV-DATE-010`), stepped as a day, and re-encoded. Review of #3580
 * first routed this to `addDaysDateOnly`, which is the same arithmetic but
 * adds an importer to the escape-hatch census that may only ever shrink.
 */
export function morningAfter(storedNight: Date): Date {
  return dateOnlyInstantOf(addCalendarDays(calendarDateOfDateOnlyInstant(storedNight), 1));
}

/** One guest's one night, sold at `priceCents`: quantity 1, the night half-open. */
export function guestNightPosting(
  anchor: ChargeLineAnchor,
  night: {
    bookingGuestId: string;
    /** The guest's name as the line records it; blank reads "Guest". */
    name: string;
    rateMembershipTypeId: string | null;
    ageTier: BookingLedgerPosting["ageTier"];
    stayDate: Date;
    priceCents: number;
    postingKey: string;
  },
): BookingLedgerPosting {
  return {
    ...anchor,
    side: "CHARGE",
    kind: "GUEST_NIGHT",
    sign: 1,
    quantity: 1,
    unitCents: night.priceCents,
    bookingGuestId: night.bookingGuestId,
    nightStart: night.stayDate,
    nightEndExclusive: morningAfter(night.stayDate),
    rateMembershipTypeId: night.rateMembershipTypeId,
    ageTier: night.ageTier,
    guestNames: night.name ? [night.name] : [],
    narration: `${night.name || "Guest"} — one night`,
    postingKey: night.postingKey,
  };
}

/**
 * The promotion as a line, signed by its figure (a discount is negative), or
 * null where there is none to post.
 */
export function promotionPosting(
  anchor: ChargeLineAnchor,
  promoAdjustmentCents: number,
  postingKey: string,
): BookingLedgerPosting | null {
  if (promoAdjustmentCents === 0) return null;
  const sign = promoAdjustmentCents < 0 ? -1 : 1;
  return {
    ...anchor,
    side: "CHARGE",
    kind: "PROMOTION",
    sign,
    quantity: 1,
    unitCents: Math.abs(promoAdjustmentCents),
    narration: sign < 0 ? "Promotion applied" : "Promotion, price raised",
    postingKey,
  };
}

/** Is this line one `guestNightPosting` wrote — one guest's one night, charged? */
export function isSingleNightLine<
  T extends {
    kind: string;
    sign: number;
    quantity: number;
    bookingGuestId: string | null;
    nightStart: Date | null;
    nightEndExclusive: Date | null;
  },
>(line: T): line is T & { bookingGuestId: string; nightStart: Date; nightEndExclusive: Date } {
  return (
    line.kind === "GUEST_NIGHT" &&
    line.sign === 1 &&
    line.quantity === 1 &&
    line.bookingGuestId !== null &&
    line.nightStart !== null &&
    line.nightEndExclusive !== null &&
    line.nightEndExclusive.getTime() === morningAfter(line.nightStart).getTime()
  );
}
