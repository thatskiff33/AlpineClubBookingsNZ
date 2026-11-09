- **Approving a held booking request no longer deadlocks with a member merge
  when the officer who quoted the hold is the duplicate (#4857).** An officer approving a booking request that had beds on
  hold, while a duplicate member record was being merged, could leave the two
  waiting on each other until the database cancelled one. This happened when
  the officer who quoted the hold was the duplicate, and the approval linked a
  guest to one of the two records being merged.

  The approval now locks the held booking first. When the merge is already
  holding it, the approval waits and then finishes. When the approval goes
  first, the merge waits for it; if the approval put one of the merged members
  on a booking the merge had not accounted for, the merge stops with nothing
  saved and can be run again.
