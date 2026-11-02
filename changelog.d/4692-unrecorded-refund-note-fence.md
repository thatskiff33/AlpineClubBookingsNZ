- **A refund credit note Xero made but the app could not record now holds back
  every other refund note on that payment until an officer records it
  (#4688).** When the app's record of a new refund note cannot get its locks
  in time, the note exists in Xero but nowhere in the app. Until now, fifteen
  minutes later the app stopped waiting for it: a later refund, the nightly
  self-heal or Retry all could raise another note sized as if the first did
  not exist, so Xero could hold more in refund notes than was refunded. Now
  the job is marked as holding an unrecorded note, and until an officer uses
  Resolve by hand with that note's number, the payment's later refund notes
  wait, Retry and Retry all refuse to re-run its refund notes, and the nightly
  self-heal leaves it alone. Mark failed keeps the mark. Once resolved, the
  waiting notes go ahead, sized with the recorded note counted; the hold also
  ends if that note is recorded through another job (the original job a
  retry ran for, say). A waiting note is looked at again only every few
  minutes, so it never holds up the payment's or anyone else's other Xero jobs,
  and a copy of the same note queued while it waited no longer stops the
  resolve: it is cancelled afterwards. The officers' alert and the operations
  list say so, and say not to retry.
