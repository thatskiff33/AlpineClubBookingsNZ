- **A booking change that adds to the price no longer leaves a card request
  open on a booking cancelled a moment later (#4316).** When a member added a
  guest or changed dates and then cancelled straight away, the extra amount
  could still be requested from their card just after the cancellation went
  through. The member could not pay it in the app, but the request stayed open
  with Stripe and the booking's payment record was left untidy.

  The extra amount is now checked against the booking just before the card is
  asked and again straight afterwards. A booking that has been cancelled is
  asked for nothing, and a request that slipped through in the moment between
  is withdrawn and cancelled with Stripe, the same way a cancellation withdraws
  one. The automatic retry of a card request that failed the first time, and a
  request re-issued after the club changes its currency, follow the same rule,
  as does a booking whose card payment had already been refunded in full. The
  change email no longer names the extra as due on a cancelled booking.
  Nothing changes for bookings that stay live.
