# Function-size allowance for #5402 (waitlist true position)

The member booking page now passes the waitlist card the position read from the
live queue on this request. The read is its own loader
(`_lib/booking-detail-waitlist-position.ts`); the page gains one prop line.
None of the objects already passed to the card (`viewer`, `access`, `party`,
`payment`, `messages`) is about the queue, so folding the number into one would
hide it under a misleading name; splitting the page is a separate change.

function: src/app/(authenticated)/bookings/[id]/page.tsx#BookingDetailPage
lines: 363
reason: one prop line passing the live waitlist position to the pay-door cards;
  the read lives in its own loader, and no prop object already passed to the
  card is a natural home for a queue position.
