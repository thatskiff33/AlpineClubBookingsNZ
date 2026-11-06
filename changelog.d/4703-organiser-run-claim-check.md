- **An organiser adjustment no longer allocates or pays out after an officer
  took it over (#4680).** The waiver of a group organiser's unpaid extra, or
  an organiser's bank-transfer refund note, records its credit note in Xero
  first and then allocates the waiver or records the refund payment. If the
  job stalled in Xero after recording the note, an officer pressed **Reset
  stale running** and then resolved it by hand, the stalled job could still
  come back and allocate or pay out in Xero, so a refund could be paid twice.

  The job now checks that it is still its own immediately before each of
  those Xero calls, and stops if not: it records nothing and leaves the job as
  it stands. The audit log gets one Xero entry, and if the job was resolved by
  hand the finance contacts get one **Xero Sync Error** email naming the note,
  which the app neither allocated nor paid against. After a reset alone, or a
  **Retry**, the retry finishes from the recorded note. A Xero call already
  under way when the job is reset can still finish; that is reported as
  before.
