- **A database upgrade step for the schools work was renumbered so it runs after
  the audit-history tidy-up rather than before it (#2725).** Upgrade steps run in
  the order their names sort, and one that reached the main line while this piece
  of work was being built happened to sort after the schools step even though it
  was written later. Nothing could have gone wrong — the two touch completely
  different tables and neither depends on the other — but a club's upgrade record
  would have shown steps applied in an order that disagreed with their names, for
  good, and that is the record somebody reads when deciding whether an upgrade
  needs the system taken offline. The step itself is unchanged; only its name and
  the note explaining the move.
