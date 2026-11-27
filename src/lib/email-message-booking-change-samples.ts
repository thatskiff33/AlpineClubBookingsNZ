/**
 * The email registry's preview samples for the booking-change emails: the one
 * coherent booking-modified story (#2267) and the calendar sentences (#5249).
 * Moved out of `sampleValue` in `email-message-registry.ts`, which is past its
 * size ceiling; that function asks here for these tokens.
 */
import { calendarRemovalNote, calendarUpdateNote } from "@/lib/email-message-notes";

/** The sample for one of these tokens, or undefined for any other token. */
export function bookingChangeSampleValue(token: string): string | undefined {
  // #2267: one coherent booking-modified sample — a 2-guest stay whose dates
  // moved from 1–3 Jul to 8–10 Jul and whose price rose from $123.45 to
  // $150.00 with no change fee, leaving $26.55 to pay. Every token below tells
  // that same story, including the per-piece ones a legacy override uses, so
  // an admin's preview reconciles instead of mixing three unrelated amounts.
  if (token === "modificationTypeLabel") return "Dates Changed";
  if (token === "paymentNote") {
    return "An additional payment of $26.55 is required.";
  }
  if (token === "changeSummary") {
    return "Previous Dates: 1 Jul 2026 – 3 Jul 2026\nNew Dates: 8 Jul 2026 – 10 Jul 2026\nGuests: 2\nPrevious Total: $123.45\nNew Total: $150.00\n";
  }
  if (token === "oldCheckIn") return "1 Jul 2026";
  if (token === "oldCheckOut") return "3 Jul 2026";
  if (token === "newCheckIn") return "8 Jul 2026";
  if (token === "newCheckOut") return "10 Jul 2026";
  if (token === "oldTotal") return "$123.45";
  if (token === "newTotal") return "$150.00";
  if (token === "changeFee") return "$0.00";
  // #5249: each calendar sentence from its composer, previewed as the
  // attached-file arm a member offered an entry normally receives.
  if (token === "calendarRemovalNote") return calendarRemovalNote(true);
  if (token === "calendarUpdateNote") return calendarUpdateNote();
  return undefined;
}
