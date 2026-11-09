- **Approving a change request no longer risks deadlocking with a member merge
  (#4845).** Approving a locked-period change request while a duplicate member
  record was being merged could leave the two waiting on each other until the
  database cancelled one. This happened when the duplicate made the request or
  owned the booking, or was the officer approving it.

  The approval now locks its booking first. Both the approval and the merge
  finish. If the approving officer's own duplicate record is merged away
  first, the approval saves nothing and they approve it again from their
  surviving record.
