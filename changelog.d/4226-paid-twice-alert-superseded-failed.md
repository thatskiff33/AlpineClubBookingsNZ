- **The "paid twice — card and Xero" alert no longer names a card payment
  whose refund is being sent again (#4221).** When a newer card payment
  replaced an older one, the club refunds the older one automatically. If
  Stripe accepted that refund and failed it later, or failed another refund
  of it, the app asks for it again, or leaves it for the treasurer to pay
  another way. Until then the alert counted the older
  payment as if it had settled the booking: if the booking was also paid by
  bank transfer, the alert named a payment already on its way back to the
  member, and an officer refunding the bank transfer on that advice would
  have left the booking with no money held.

  The alert now skips that payment while its refund is still owed, as it
  already did while the first refund was under way (#4177). It names the
  payment that did settle the booking, or raises nothing when there is no
  other card payment. Once the refund is made again, or closed as paid
  another way, the payment counts as before. Cancelled bookings are
  unchanged, and no money moves differently.
