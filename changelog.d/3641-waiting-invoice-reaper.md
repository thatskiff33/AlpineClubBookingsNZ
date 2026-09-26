- **A booking change's Xero invoice is no longer thrown away while the member
  can still pay for the change** (#3641). When a card-paid booking is changed
  and costs more, its Xero invoice waits until the member pays. A nightly
  clean-up used to retire that waiting invoice after 14 days, or a day after a
  declined card, even though the member could still pay the same request and
  the club reminds them before check-in. A late payment then left Stripe holding
  money that no Xero invoice named. The clean-up now retires a waiting invoice
  only once the request can no longer be paid (replaced by a later change,
  withdrawn, already paid, or the booking cancelled or deleted). If a payment
  does arrive for an invoice that was already retired, that same invoice is put
  back in the queue and sent once. Where sending it could bill twice or record
  more money than arrived, the club's admins are emailed instead.
