import { getAppBaseUrl } from "@/lib/app-url";

/**
 * The recipient identity a booking-scoped sender must declare.
 *
 * A member id is only an input to the server-side authority check; it is never
 * treated as proof that the recipient may open the booking. Public contacts and
 * aggregate operator messages are explicit so neither can accidentally inherit
 * a signed-in booking link merely because a booking id is available.
 */
export type BookingEmailRecipient =
  | { kind: "member"; memberId: string }
  | { kind: "non-login-public-contact" }
  | { kind: "aggregate-operator" };

export type BookingEmailRecipientAuthority =
  | "signed-in-booking-owner"
  | "signed-in-linked-member"
  | "bookings-view-admin"
  | "non-login-public-contact"
  | "aggregate-operator"
  | "unauthorized";

/**
 * Booking identity for a send. Every booking-scoped caller must name both the
 * booking and the recipient whose authority will be checked before a detail
 * link is rendered.
 */
export type EmailBookingContext =
  | { bookingId: string; recipient: BookingEmailRecipient }
  | "none";

export type BookingScopedEmailContext = Exclude<EmailBookingContext, "none">;

/**
 * A booking plus the OWNER it is being sent to, as a sender declares it.
 *
 * `recipientMemberId` is nullable since #3369: an organisation-owned booking
 * has no member to name. Written once, here, so a sender cannot declare a
 * narrower shape of its own and quietly become the one place a school booking
 * cannot be emailed from (`INV-SSOT`).
 */
export type BookingOwnerEmailSource = {
  bookingId: string;
  recipientMemberId: string | null;
};

export type BookingEmailSourceContext = BookingOwnerEmailSource | "none";

/**
 * The recipient identity for a message addressed to whoever owns a booking.
 *
 * NULL IS NOT AN ERROR HERE, IT IS THE SCHOOL (#3369, stage 4 of programme
 * #2912). A booking owned by an `Organisation` has no member to name, and the
 * kind that describes such a recipient already exists: a non-login public
 * contact is precisely a party the club must write to and must not hand a
 * signed-in booking link.
 *
 * Nothing about the delivered mail changes. The invented school member the club
 * used to write to had `canLogin: false`, and `resolveBookingEmailLink` refuses
 * a link to any recipient that cannot sign in — so a school has always received
 * the message with no detail link. This says so in the type instead of arriving
 * at it by failing an authority check, and it is why every caller that passes
 * `bookingOwner(booking).memberId` straight through needed no change.
 */
export function bookingOwnerEmailContext(
  bookingId: string,
  recipientMemberId: string | null,
): BookingScopedEmailContext {
  return {
    bookingId,
    recipient: recipientMemberId
      ? { kind: "member", memberId: recipientMemberId }
      : { kind: "non-login-public-contact" },
  };
}

export function classifyBookingOwnerContext(
  context: BookingEmailSourceContext,
): EmailBookingContext {
  return context === "none"
    ? "none"
    : bookingOwnerEmailContext(context.bookingId, context.recipientMemberId);
}

/** Canonical, encoded member-facing booking detail path. */
export function buildBookingDetailPath(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}`;
}

/** Canonical absolute URL used in email HTML and editable template data. */
export function buildBookingDetailUrl(bookingId: string): string {
  return `${getAppBaseUrl()}${buildBookingDetailPath(bookingId)}`;
}
