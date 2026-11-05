- **An extra card payment waiting on a retry is no longer lost when the
  booking changes again (#4015).** When a price increase's extra card request
  could not be set up at once, it waits for an automatic retry. If another
  increase was saved before that retry ran, the retry treated the first
  increase as already covered and asked for nothing, so the club was short
  that amount. The retry now asks for its own increase plus whatever the later
  request still has unpaid, and replaces that request. The member is left with
  one card request for the full amount owed. A price reduction saved in the
  meantime now sets itself against that waiting increase too. If Stripe shows
  the later request as paid or still processing, the retry waits for that
  payment to be recorded rather than cancelling it, for up to seven days
  after that payment began. If it is still not recorded by then, the retry
  stops and officers are alerted
  to check the payment in Stripe and collect the change by hand. A member
  part-way through a card security check on the later request when the retry
  runs is asked to pay the new request instead. A retry whose change already
  has its card request on record finishes with that request rather than
  asking a second time. Otherwise no operator action is needed.
