- **A refund credit-note job that stalls in Xero no longer overwrites the note
  an officer recorded by hand (#4426).** A refund credit-note job can stall in
  Xero, be marked failed with **Reset stale running** or **Mark failed**, and
  then be resolved by hand with the credit note the officer made. If the
  stalled job then came back with a note of its own, it replaced the
  officer's note on the job, linked its own note to the payment and paid it
  out, so Xero could hold two credit notes for one refund and the app lost
  track of the hand-made one.

  The officer's note now stays recorded. The late note is not recorded,
  linked or paid out, and the finance contacts get one **Xero Sync Error**
  email naming it and the note the job keeps: check the late note in Xero and
  void it if it is a duplicate. A stalled job that was only marked failed,
  not resolved, still records its note as before.
