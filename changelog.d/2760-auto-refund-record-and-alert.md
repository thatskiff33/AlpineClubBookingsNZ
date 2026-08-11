- **Every automatically refunded booking-change payment is now on the Payments
  page, and the email about it says what actually happened (#2760, #2761).** When
  a member pays for a booking change at the moment their booking is being
  cancelled or deleted, Stripe hands the money straight back on its own. That
  refund had a home on `/admin/payments` — the read-only **Refunded
  automatically — nothing to pay back** card — but only some of them ever reached
  it: the record depended on the order the member's browser and Stripe's
  notification arrived in, and it never covered a booking that was cancelled
  without being deleted.

  All of them reach it now, so the card no longer says it is an incomplete list.
  It says what it is: every automatic refund of the last 30 days, with the
  booking's audit log as the permanent record for anything older. There is one
  named exception in the copy — if somebody had already closed the hand-back task
  for that payment by hand, their own record of it stays in the booking's history
  and it is not repeated on the card, because one payment never gets two refund
  tasks. Because the wider net includes refunds that are simply the expected
  outcome of cancelling a booking, the card is split into two groups — **the
  booking was deleted**, which is worth a look because remaking it means charging
  the member again, and **the booking was cancelled and is still on file**, which
  normally needs nothing.

  The alert email sent at the moment it happens is the same single email as
  before, rewritten. Its subject used to be the generic "Payment Failed", which
  described nothing that had happened and got triaged as noise; it now reads
  *Payment refunded automatically — booking already deleted* (or *… already
  cancelled*) and the body says which case it is and what, if anything, to do.
  It can no longer be switched off — not per admin in Notification Recipients,
  and not club-wide in Delivery Rules — because money moved without anybody
  deciding it, and it always resolves at least one recipient rather than
  silently going nowhere. It goes to everyone whose role can edit Finance; if no
  role can, it falls back to Support & System editors and then to the club's own
  support address as set in Email Messages, and each step is logged.

  Two smaller things that keep the page honest. If the club's record of one of
  these refunds cannot be written at all — a database problem at the moment
  Stripe reports the capture — the booking's audit log now carries a critical
  *automatic refund record failed* entry, because the payment is reported back to
  Stripe as handled and will not be sent again, so that entry is the only place
  the gap can be found. And the follow-up sentence in the email, and the reason
  stored on the card row, are now taken from a fresh check of whether the booking
  has been deleted rather than from the read taken before Stripe was contacted, so
  a deletion that lands while the refund is going through is described correctly.

  No refund amount, timing, or decision changed, no operator is queued for
  anything, and no badge or daily-digest count changed. One consequence worth
  knowing: because these events are no longer filed as payment failures, they no
  longer add to the daily digest's "Payment Failures" number — nothing failed.
  This covers payments for booking **changes**; the same treatment for a late
  payment of a booking's original amount, and the hand-back protection, follow in
  the same release (see the #2773 / #2774 entry).
