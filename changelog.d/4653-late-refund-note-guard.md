- **A refund credit-note job that stalls in Xero no longer overwrites the note
  an officer recorded by hand (#4426).** A refund credit-note job can stall in
  Xero, be marked failed with **Reset stale running** or **Mark failed**, and
  then be resolved by hand with the number of the credit note the officer
  made. If the stalled job then came back with a note of its own, it replaced
  the officer's note on the job, linked its own note to the payment and
  recorded a refund payment against it in Xero, so Xero could hold two credit
  notes for one refund and the app lost track of the hand-made one.

  The officer's note now stays recorded. The late note is not recorded,
  linked, or paid against in Xero; the audit log gets one Xero entry naming it,
  and the finance contacts get one **Xero Sync Error** email naming it, its
  amount, the booking and the note the job keeps: check the late note in Xero,
  and that it is not recorded on the payment, before voiding it. If the late
  note is the very one the officer recorded (its answer was lost and the
  officer found it), nothing is sent. A job only marked failed, or resolved
  without a note number, still records the late note as before.
