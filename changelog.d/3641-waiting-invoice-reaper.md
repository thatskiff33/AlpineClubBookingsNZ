- **A booking change's Xero invoice is no longer thrown away while the member
  can still pay for the change** (#3641). When a card-paid booking is changed
  and costs more, its Xero invoice waits until the member pays. A clean-up that
  runs every 15 minutes used to retire that waiting invoice after 14 days, or a
  day after a declined card, even though the member could still pay the same
  request and the club reminds them before check-in. A late payment then left
  Stripe holding money that no Xero invoice named. The clean-up now retires a
  waiting invoice only once the request can no longer be paid: replaced by a
  later change, withdrawn, cancelled at Stripe, or the booking cancelled,
  bumped or deleted. A waiting invoice whose payment has already arrived is
  now sent rather than retired. If a payment arrives for an invoice that was
  already retired, that same invoice is put back in the queue and sent once.
  Where sending an invoice could bill twice, or record more money than the
  card actually paid, the club's admins are emailed instead. The member's
  "pay this extra" form is no longer offered for a payment request Stripe has
  cancelled or already collected.
