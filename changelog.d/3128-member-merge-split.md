- **The member-merge code was reorganised into smaller files, with nothing about
  merging changed (#3128).** Merging two member records behaves exactly as
  before: the same fields combine the same way, the same relations move, the
  same checks refuse the same merges, and the confirmation screen shows the same
  thing. At 3,814 lines this was the largest file in the system. The parts of it
  that are lists rather than actions — which relations a merge re-points, which
  columns are kept as a record of the deleted member, the checks that make sure
  neither list falls behind the database, and the rules for combining the two
  members' own details — now live in four files of their own.

  **Nothing was rewritten.** All 1,055 relocated lines are character-for-character
  identical to what they were, including every explanatory note, verified by
  machine rather than by eye.
