- **Approving the refund of a held late card payment can no longer refund it a
  second time (#4824).** If a refund of that payment was recorded - for
  example Stripe reporting one made in its dashboard - while a treasurer was
  approving it, the approval could miss it and owe the member the same money
  again. The approval now checks what is left on the payment only once nothing
  else can change it, and refuses when it was already refunded; the item stays
  open to be dismissed with a note.
