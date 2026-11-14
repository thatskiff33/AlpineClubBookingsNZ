/**
 * Centralised status colour utility.
 * Every status must have a unique colour within its category.
 */

import type { BookingStatus } from "@prisma/client";
import {
  CHIP_TONE_CLASSES,
  CHIP_TONE_SWATCH_CLASSES,
  type ChipTone,
} from "@/lib/chip-tones";

// #2188 P2 — migrated off raw Tailwind colour utilities onto the signed-off
// scale vocabulary (M1-M10, #2181) via CHIP_TONE_CLASSES, which renders the
// `bg-<scale>-3 text-<scale>-11` step pattern (G2b-guaranteed AA, theme-following).
// Every status keeps a UNIQUE tone: the four semantic scales carry the clearly
// semantic states (CONFIRMED=success, CANCELLED=danger, PAID=info,
// PAYMENT_PENDING=warning-primary amber), and the categorical scales cat1..cat6
// carry the sibling states that share a hue family, assigned by hue proximity to
// the previous palette (PENDING yellow→cat5 olive-lime, AWAITING_REVIEW sky→cat2
// cyan, COMPLETED slate→cat3, BUMPED orange→cat4, WAITLISTED purple→cat1).
// WAITLIST_OFFERED → cat6 (#2218 — the generated teal 6th scale that supplied the
// booking column's sixth distinguisher and retired the last --hue-* pair; verified
// distinct: step-11 accent text ΔE2000 ≥ 14.8 from every sibling). Meaning is
// always carried by icon + label, never colour alone.
//
// This is the only booking status -> per-status colour table (INV-SSOT-001,
// ALP-572). `bookingStatusClass` (My Bookings, both dashboards, the booking
// editor, the waitlist page, a member's history), the admin calendar's pills and
// bars (step-3/step-11 chip pair) and the calendar's text-free step-9 swatches
// all derive from it, so a status keeps one colour on each of those. Typed by the
// enum, so a new status fails typecheck until it has a tone.
//
// One other table is deliberate, not a copy: the admin bookings list's
// `StatusChip` (`BOOKING_TONES` in `ui/status-chip.tsx`, pinned by
// `status-chip.test.tsx`) keeps five semantic tones plus an icon, so several
// statuses share a tone there (see `chip-tones.ts`). The calendar's bars carry
// no icon, so they take the per-status distinction this table gives instead.
const BOOKING_STATUS_TONES: Record<BookingStatus, ChipTone> = {
  DRAFT:            "neutral",
  PENDING:          "cat5",
  PAYMENT_PENDING:  "warning",
  CONFIRMED:        "success",
  AWAITING_REVIEW:  "cat2",
  PAID:             "info",
  COMPLETED:        "cat3",
  CANCELLED:        "danger",
  BUMPED:           "cat4",
  WAITLISTED:       "cat1",
  WAITLIST_OFFERED: "cat6",
};

function mapBookingStatusTones(
  toneClasses: Record<ChipTone, string>,
): Record<BookingStatus, string> {
  return Object.fromEntries(
    Object.entries(BOOKING_STATUS_TONES).map(([status, tone]) => [status, toneClasses[tone]]),
  ) as Record<BookingStatus, string>;
}

// test seam
/** Booking status -> chip classes (step-3 tint, step-11 text) for anything that carries text. */
export const bookingStatusClasses = mapBookingStatusTones(CHIP_TONE_CLASSES);

/** Booking status -> solid step-9 fill, for text-free swatches, stripes and dots only. */
const bookingStatusSwatchClasses = mapBookingStatusTones(CHIP_TONE_SWATCH_CLASSES);

// test seam
export const bookingStatusLabels: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Pending",
  PAYMENT_PENDING: "Payment Pending",
  // CONFIRMED holds capacity for pay-on-account bookings (see
  // booking-status.ts): the place is secured, the invoice is outstanding.
  CONFIRMED: "Confirmed (Unpaid)",
  AWAITING_REVIEW: "Awaiting Review",
  PAID: "Paid",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  BUMPED: "Bumped",
  WAITLISTED: "Waitlisted",
  WAITLIST_OFFERED: "Waitlist Offered",
};

// test seam
export const paymentStatusClasses: Record<string, string> = {
  PENDING:            CHIP_TONE_CLASSES.warning,
  PROCESSING:         CHIP_TONE_CLASSES.cat3,
  SUCCEEDED:          CHIP_TONE_CLASSES.info,
  FAILED:             CHIP_TONE_CLASSES.danger,
  REFUNDED:           CHIP_TONE_CLASSES.cat1,
  PARTIALLY_REFUNDED: CHIP_TONE_CLASSES.cat4,
};

function isKnownBookingStatus(status: string): status is BookingStatus {
  return Object.hasOwn(BOOKING_STATUS_TONES, status);
}

export function bookingStatusClass(status: string): string {
  return isKnownBookingStatus(status) ? bookingStatusClasses[status] : CHIP_TONE_CLASSES.neutral;
}

/** The text-free step-9 swatch for a booking status; an unknown status gets the neutral swatch. */
export function bookingStatusSwatchClass(status: string): string {
  return isKnownBookingStatus(status)
    ? bookingStatusSwatchClasses[status]
    : CHIP_TONE_SWATCH_CLASSES.neutral;
}

export function bookingStatusLabel(status: string): string {
  return bookingStatusLabels[status] ?? humanizeStatus(status);
}

/** Render a raw enum value in sentence case, e.g. "PENDING_NOMINATORS" -> "Pending nominators". */
export function humanizeStatus(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

export function paymentStatusClass(status: string): string {
  return paymentStatusClasses[status] ?? CHIP_TONE_CLASSES.neutral;
}

// test seam
export const subscriptionStatusClasses: Record<string, string> = {
  PAID:         CHIP_TONE_CLASSES.success,
  UNPAID:       CHIP_TONE_CLASSES.warning,
  OVERDUE:      CHIP_TONE_CLASSES.danger,
  NOT_INVOICED: CHIP_TONE_CLASSES.neutral,
  NOT_REQUIRED: CHIP_TONE_CLASSES.info,
};

const subscriptionStatusLabels: Record<string, string> = {
  PAID: "Paid",
  UNPAID: "Unpaid",
  OVERDUE: "Overdue",
  NOT_INVOICED: "Not Invoiced",
  NOT_REQUIRED: "Not Required",
};

export function subscriptionStatusClass(status: string): string {
  return subscriptionStatusClasses[status] ?? CHIP_TONE_CLASSES.neutral;
}

export function subscriptionStatusLabel(status: string): string {
  return subscriptionStatusLabels[status] ?? status.replace(/_/g, " ");
}
