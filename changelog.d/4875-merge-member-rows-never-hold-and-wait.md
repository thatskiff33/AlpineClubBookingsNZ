- **Merging two member records no longer deadlocks with an officer's approval
  made from the duplicate account, and no longer quietly drops what that
  officer recorded (#4855).**
  If a booking officer approved a change request or a held booking request
  from the very account being merged while the merge ran, the database could
  stop one of the two with a deadlock, and the admin saw an error. In the
  other order both finished, but the merge then wiped the officer's name off
  the request they had just approved.

  The merge now waits for each of the member records it needs one at a time,
  holding none of the others while it waits, so in these races the officer's
  approval completes instead of being stopped. If anything still points at the
  duplicate once the merge has those records, the merge stops with "Records naming the duplicate changed while the
  merge was running. Nothing was saved." Run the preview again and confirm;
  nothing needs to be repaired.
