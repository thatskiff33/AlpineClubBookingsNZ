- **An extra card payment waiting on a retry is no longer lost when the
  booking changes again (#4015).** When a price increase's extra card request
  could not be set up at once, it waits for an automatic retry. If another
  increase was saved before that retry ran, the retry treated the first
  increase as already covered and asked for nothing, so the club was short
  that amount. The retry now asks for its own increase plus whatever the later
  request still has unpaid, and replaces that request. The member is left with
  one card request for the full amount owed. A price reduction saved in the
  meantime now sets itself against that waiting increase too. No operator
  action is needed.
