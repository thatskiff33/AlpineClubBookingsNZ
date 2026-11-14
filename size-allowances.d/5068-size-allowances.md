# Size allowances for #5068

function: src/app/(website-dynamic)/booking-requests/respond/[token]/booking-request-respond-client.tsx#BookingRequestRespondClient
lines: 334
reason: this change adds the screen-reader announcement of the action's
  outcome beside the control that triggers it; those lines sit inside the
  function `BookingRequestRespondClient`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(website)/contact/contact-page-client.tsx#ContactPageClient
lines: 337
reason: this change adds the screen-reader announcement of the action's
  outcome beside the control that triggers it; those lines sit inside the
  function `ContactPageClient`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
