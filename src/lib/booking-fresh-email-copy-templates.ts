import type { EmailAuditTemplateName } from "@/lib/email-message-audit-defaults";

/**
 * THE BOOKING EMAILS AN OFFICER MAY SEND A FRESH COPY OF.
 *
 * Each one is in `SENSITIVE_EMAIL_LOG_TEMPLATES`: it carries a door code or a
 * single-use payment link, so its rendered body is never kept and the email
 * retry job can never replay a failed one. The fresh-copy action renders the
 * message again from the booking as it is now — current owner, current lodge
 * and door code, current payment state, and (for the payment link) a newly
 * minted link that revokes the old one. Nothing is recovered from an old body.
 *
 * Client-safe on purpose: the booking page's panel and the email-failure queue
 * both read this list, and the server service (`booking-fresh-email-copy.ts`)
 * is the one place that acts on it.
 */
export const BOOKING_FRESH_COPY_TEMPLATES = [
  "booking-confirmed",
  "pre-arrival-reminder",
  "split-guest-payment-link",
] as const satisfies readonly EmailAuditTemplateName[];

export type BookingFreshCopyTemplate = (typeof BOOKING_FRESH_COPY_TEMPLATES)[number];

export const BOOKING_FRESH_COPY_LABELS: Record<
  BookingFreshCopyTemplate,
  { title: string; description: string; actionLabel: string }
> = {
  "booking-confirmed": {
    title: "Booking confirmation",
    description:
      "Rendered again from the booking's current dates, party, price, lodge and payment state, and sent to the booking's current owner.",
    actionLabel: "Send fresh confirmation",
  },
  "pre-arrival-reminder": {
    title: "Pre-arrival reminder",
    description:
      "Rendered again with the lodge's current door code and arrival details, and sent to the booking's current owner.",
    actionLabel: "Send fresh reminder",
  },
  "split-guest-payment-link": {
    title: "Guest payment link",
    description:
      "Mints a new payment link for the separately charged guests and emails it to that booking's owner. The previous link stops working.",
    actionLabel: "Send fresh payment link",
  },
};

/** The booking page section the fresh-copy panel renders under. */
export const BOOKING_FRESH_COPY_ANCHOR = "fresh-email-copies";

export function isBookingFreshCopyTemplate(
  templateName: string,
): templateName is BookingFreshCopyTemplate {
  return (BOOKING_FRESH_COPY_TEMPLATES as readonly string[]).includes(templateName);
}

/** Where an officer sends a fresh copy of this booking's email from. */
export function bookingFreshCopyHref(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}#${BOOKING_FRESH_COPY_ANCHOR}`;
}
