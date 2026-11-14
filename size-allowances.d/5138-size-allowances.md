# Size allowances for #5138

function: src/components/group-booking/organiser-group-booking-card.tsx#OrganiserGroupBookingCard
lines: 566
reason: Stripe redirect-return handling on every card surface; those lines sit
  inside the function `OrganiserGroupBookingCard`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/components/stripe/BookingPaymentWrapper.tsx#BookingPaymentWrapper
lines: 407
reason: Stripe redirect-return handling on every card surface; those lines sit
  inside the function `BookingPaymentWrapper`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.
