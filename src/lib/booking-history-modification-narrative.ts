import { formatCents } from "@/lib/utils";

/**
 * HOW A STORED `BookingModification` ROW IS DESCRIBED IN WORDS.
 *
 * Split out of `booking-history.ts` (#3232 fix round), which is the timeline
 * BUILDER: it decides which events appear, in what order, for which reader, and
 * with which money beside them. Turning one stored row into a sentence is a
 * different job with a different reason to change — new modification types, new
 * wording, new keys written by an edit — and it is the half that grows every time
 * the modification service learns to record something new.
 *
 * IT OWNS THE ROW SHAPE, rather than importing it back from the builder, because
 * the shape is exactly the fields these functions read. The builder imports the
 * type from here (`INV-SSOT-001`); a second declaration on either side is two
 * things that can disagree about what a modification row contains.
 *
 * Pure and I/O-free, like the builder it serves.
 */

export interface BookingHistoryModification {
  id: string;
  modificationType: string;
  previousData: unknown;
  newData: unknown;
  priceDiffCents: number;
  changeFeeCents: number;
  createdAt: Date;
}

export const MODIFICATION_LABELS: Record<string, string> = {
  DATE_CHANGE: "Dates Changed",
  GUEST_ADD: "Guests Added",
  GUEST_REMOVE: "Guest Removed",
  EXTEND_STAY: "Stay Extended",
  BATCH_MODIFY: "Booking Modified",
  // #2266: an edit that changed ONLY the stored credit election (#2265).
  CREDIT_ELECTION: "Credit Choice Updated",
};

function isRemovedGuest(
  value: unknown
): value is { firstName?: string; lastName?: string } {
  return Boolean(value) && typeof value === "object";
}

/**
 * A plain-English sentence an edit stored on its own modification record for the
 * member to read later, or null when that edit had nothing to say.
 *
 * Two keys use it: `promoCoverageNote`, the promotion-cap split a reprice
 * explained at the time (#2390), and `promoChangeNotAppliedNote`, the
 * promo-code change an edit saved without (#3179). One reader rather than two,
 * because both are the same thing — the exact words the member was shown,
 * replayed verbatim (`INV-SSOT`).
 *
 * Read defensively: `newData` is free-form JSON, and every modification written
 * before either key existed simply does not have it.
 */
export function memberFacingNoteOf(
  modification: BookingHistoryModification,
  key: "promoCoverageNote" | "promoChangeNotAppliedNote"
): string | null {
  const next =
    modification.newData && typeof modification.newData === "object"
      ? (modification.newData as Record<string, unknown>)
      : {};
  const note = next[key];
  return typeof note === "string" && note.trim().length > 0 ? note : null;
}

export function describeModification(modification: BookingHistoryModification): string | null {
  const previous =
    modification.previousData && typeof modification.previousData === "object"
      ? (modification.previousData as Record<string, unknown>)
      : {};
  const next =
    modification.newData && typeof modification.newData === "object"
      ? (modification.newData as Record<string, unknown>)
      : {};

  switch (modification.modificationType) {
    case "DATE_CHANGE":
      return `${String(previous.checkIn)} to ${String(next.checkIn)} and ${String(previous.checkOut)} to ${String(next.checkOut)}`;
    case "GUEST_ADD":
      return `${String(previous.guestCount)} to ${String(next.guestCount)} guests.`;
    case "GUEST_REMOVE": {
      const removedGuest = previous.removedGuest;
      const name = isRemovedGuest(removedGuest)
        ? [removedGuest.firstName, removedGuest.lastName]
            .filter(Boolean)
            .join(" ")
        : "guest";
      return `Removed ${name}; ${String(previous.guestCount)} to ${String(next.guestCount)} guests.`;
    }
    case "BATCH_MODIFY": {
      const parts: string[] = [];
      if (previous.checkIn !== next.checkIn || previous.checkOut !== next.checkOut) {
        parts.push(
          `${String(previous.checkIn)}-${String(previous.checkOut)} to ${String(next.checkIn)}-${String(next.checkOut)}`
        );
      }
      if (previous.guestCount !== next.guestCount) {
        parts.push(`${String(previous.guestCount)} to ${String(next.guestCount)} guests`);
      }
      return parts.length > 0 ? `${parts.join(" and ")}.` : "Booking details were updated.";
    }
    // #2266: a credit-election-only edit. The new/previous election cents ride
    // the modification data (see booking-batch-modification-service).
    case "CREDIT_ELECTION": {
      const electionCents = next.creditElectionCents;
      return typeof electionCents === "number" && electionCents > 0
        ? `${formatCents(electionCents)} of account credit will be applied at payment.`
        : "The saved account-credit choice was removed.";
    }
    default:
      return "Booking details were updated.";
  }
}
