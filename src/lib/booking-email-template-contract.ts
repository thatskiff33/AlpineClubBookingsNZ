/**
 * Live registered templates from the booking-scoped suppression inventory that
 * may expose the OPTIONAL `bookingUrl` token after recipient authorization.
 *
 * The token-contract suite compares this set mechanically with
 * `ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES` intersected with the live registry.
 * The retired `refund-request-resolved` name is intentionally absent.
 */
export const BOOKING_URL_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "booking-confirmed",
  "booking-pending",
  "booking-policy-exception-approved",
  "booking-bumped",
  "booking-guests-cancelled",
  "booking-cancelled",
  "split-guest-portion-cancelled",
  "booking-review-approved",
  "booking-review-rejected",
  "checkin-reminder",
  "pre-arrival-reminder",
  "additional-payment-reminder",
  "booking-modified",
  "setup-intent-failed",
  // #3268: the auto-charge cron's "your saved card was unusable" notice.
  // Booking-scoped and registered like setup-intent-failed, so the same optional
  // canonical booking link carries the member to the booking that needs a card.
  "saved-card-charge-failed",
  "waitlist-confirmation",
  "waitlist-offer",
  "waitlist-offer-expired",
  // #2649: the restored-place sibling of the expiry notice. Booking-scoped and
  // registered like the other three, so the classification is mechanical and the
  // canonical authorized detail link replaces the legacy {{BASE_URL}}/bookings
  // line in its editable default.
  "waitlist-place-restored",
  "chore-roster",
  "booking-request-approved",
  "split-guest-payment-link",
  "booking-request-payment-expired",
  "school-attendee-confirmation",
  // #2550: booking-scoped and registered, so it is classified here like its
  // siblings — the reminder's whole call to action is "open your booking and
  // name your party", and the canonical authorized detail link is what carries
  // the member there.
  "whole-lodge-guest-names-reminder",
  "group-settlement-receipt",
  "group-join-settled",
  "group-settlement-expired",
  "group-join-released",
  "group-join-cancelled",
  "refund-request-approved",
  "refund-request-declined",
  "member-guest-consent-request",
  "member-guest-added",
  "member-guest-consent-outcome",
  "member-guest-consent-answered",
  "member-guest-request-withdrawn",
  "member-guest-consent-expired",
  // #2284 (S2): booking-scoped and registered, so it is classified here like the
  // member-guest set — the canonical `bookingUrl` replaces the legacy
  // {{BASE_URL}}/bookings line in the editable default, resolved to the
  // recipient-authorized detail link at send time.
  "family-member-added",
  // #2553: the hold-reaper's lapse notice. Booking-scoped and registered, so the
  // set membership is mechanical (the contract suite below compares the two), and
  // the optional booking link is what lets a member go straight to the booking
  // they now need to raise a fresh request from.
  "policy-exception-request-expired",
  // #2576: the loss-of-cover notice. Booking-scoped and registered, so the set
  // membership is mechanical, and the optional booking link is what lets a member
  // go straight to the booking they now have to fix.
  "hosting-coverage-lost",
]);

export interface BookingUrlTemplateContractFinding {
  kind: "missing" | "extra";
  templateName: string;
}

/**
 * Compare a candidate booking-URL set with the registered portion of the
 * suppression inventory. Kept pure so the mutation test can prove that either
 * a new inventory entry or an accidental classification removal is detected.
 */
export function findBookingUrlTemplateContractFindings(params: {
  bookingScopedInventory: ReadonlySet<string>;
  registeredTemplates: ReadonlySet<string>;
  bookingUrlTemplates: ReadonlySet<string>;
}): BookingUrlTemplateContractFinding[] {
  const expected = new Set(
    Array.from(params.bookingScopedInventory).filter((templateName) =>
      params.registeredTemplates.has(templateName),
    ),
  );
  return [
    ...Array.from(expected)
      .filter((templateName) => !params.bookingUrlTemplates.has(templateName))
      .map((templateName) => ({ kind: "missing" as const, templateName })),
    ...Array.from(params.bookingUrlTemplates)
      .filter((templateName) => !expected.has(templateName))
      .map((templateName) => ({ kind: "extra" as const, templateName })),
  ].sort((left, right) => left.templateName.localeCompare(right.templateName));
}
