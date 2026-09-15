- **The six database upgrade steps from the schools-and-membership work were
  renumbered one last time so they run after everything already on the main
  line (#2725, #3391).** Upgrade steps run in the order their names sort, and
  two steps reached the main line while this work was being built — the
  audit-history tidy-up and the member lodge roster — that sort after the
  steps this work adds, even though they were written later. A club upgrading
  to the main line before this work lands would otherwise have had an upgrade
  record whose order disagreed with the step names, for good, and that record is
  what somebody reads when deciding whether an upgrade needs the system taken
  offline. Nothing could have gone wrong — the steps touch different tables and
  none depends on another — and not one step changed; only their names, the
  notes explaining the move, and every place the runbooks name them.
