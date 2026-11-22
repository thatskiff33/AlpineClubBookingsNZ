# Function-size allowance for #5402 (waitlist true position)

The member booking page now passes the waitlist card the position read from the
live queue on this request. The read is its own loader
(`_lib/booking-detail-waitlist-position.ts`); the page gains one prop line.
Of the props the card already takes, `club` and `money` are formatters and
`viewer`, `access`, `party`, `payment` and `messages` are about other things, so
folding the number into one would hide it under a misleading name. It does not
go on `booking` either: that would put the retired column's name back on a
booking object, which the position census refuses. Splitting the page is a
separate change.

function: src/app/(authenticated)/bookings/[id]/page.tsx#BookingDetailPage
lines: 363
reason: one prop line passing the live waitlist position to the pay-door cards;
  the read lives in its own loader, no other prop is a natural home for it, and
  putting it on `booking` would revive the retired column's name there.
