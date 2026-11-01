- **An organiser adjustment's credit note that Xero creates after its job was
  reset is no longer lost (#4655).** The waiver of a group organiser's unpaid
  extra, or an organiser's bank-transfer refund note, can stall in Xero and be
  reset with **Reset stale running**. If the stalled call then came back with
  a credit note, the app recorded it nowhere and told nobody: Xero held a note
  the app did not know about, and a retry could raise a second one for the
  same adjustment.

  The app now records the late note on the job whenever it can: after a reset
  alone it takes the job back as running and finishes it with that note
  (while it runs, **Resolve** and **Retry** wait for it), and after a
  **Retry** the retry finishes from it instead of raising another. If the job was resolved by
  hand, a retry was already running, or the job finished with a different
  note, the app leaves the job as it is; the audit log gets one Xero entry
  naming the late note, and the finance contacts get one **Xero Sync Error**
  email naming it, its amount and the booking, asking for a check in Xero
  before voiding it.
