- **Marking a late card payment as paid back by hand can no longer count a
  Stripe refund of it twice (#4838).** If a refund of that payment was
  recorded - for example Stripe reporting one made in its dashboard - while an
  officer was marking it paid back by hand, the app could miss the refund and
  record the hand-back against the booking's other money as well, so the
  booking showed more returned than the member got. The check now runs only
  once nothing else can change the payment, and refuses when it was already
  refunded; the item stays open to be dismissed with a note.
