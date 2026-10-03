# File-size allowances for #3828

file: src/lib/email/booking.ts
lines: 1753
reason: the booking-confirmed sender's options gain each code's own adjustment
  (promoLines) and hand it to the one shared promo-rows builder; the option
  belongs beside promoCode on the sender it configures.
