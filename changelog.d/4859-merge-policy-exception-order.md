- **Approving a policy exception no longer risks deadlocking with a member
  merge (#4853).** Approving a member's policy-exception request to change an
  existing booking, while a duplicate member record was being merged, could
  leave the two waiting on each other until the database cancelled one. This
  happened when the duplicate made the request or owned the booking, or was the
  officer approving it.

  The approval now locks the booking first, as approving a change request does
  (#4845). Both the approval and the merge finish. If the approving officer's
  own duplicate record is merged away first, the approval saves nothing and they
  approve it again from their surviving record. Requests for new bookings were
  not affected.
