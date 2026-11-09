- **Approving a change request no longer risks deadlocking with a member merge
  (#4845).** Approving a locked-period change request while a duplicate member
  record was being merged could leave the two waiting on each other until the
  database cancelled one. This happened when the duplicate made the request or
  owned the booking, or was the officer approving it.

  The approval now locks its booking first. When the merge is holding that
  booking, both the approval and the merge finish. If the approving officer's
  own duplicate record is merged away first, the approval saves nothing and
  they approve it again from their surviving record.

  One rarer case is not fixed here and is tracked separately (#4855). The officer is
  the duplicate being merged, the booking is not one the merge moves, and the
  approval also adds a guest member or credits the booking's owner. The
  approval and the merge can still wait on each other until the database
  cancels one.
