# Function-size allowance for #5402 (waitlist true position)

The member booking page now passes the waitlist card the position read from the
live queue on this request. The read is its own loader
(`_lib/booking-detail-waitlist-position.ts`); the page gains one prop line, on
the one render site of the card, and splitting the page is a separate change.

function: src/app/(authenticated)/bookings/[id]/page.tsx#BookingDetailPage
lines: 363
reason: one prop line passing the live waitlist position to the pay-door cards;
  the read lives in its own loader, and the prop has to sit on the card's only
  render site in the page.
