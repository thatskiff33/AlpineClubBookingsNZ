# File-size allowances for #3266

One already-over-budget file grows. The new route logic itself went into a new
module (`src/lib/setup-intent-card.ts`) rather than the route handler, which
stays inside its 250-line budget; the page change is one condition plus the
comment saying why it changed.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2723
reason: the "Save Payment Method" card's condition moves from "no SetupIntent
  yet" to the shared `needsSavedCardEntry` predicate, and the four-line comment
  beside it records why (an abandoned replacement or a retired card must show
  the form again). The predicate itself lives in `booking-payment-flow.ts`;
  what remains here is the one call site and its reasoning, which belongs next
  to the other owner/status gates in the same expression.
