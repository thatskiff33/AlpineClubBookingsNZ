- **Two lanes adding an entry to the same list no longer collide, and the rule
  that prevents it is now written down (#3111).** This repository had solved the
  same problem three times — a directory of per-pull-request changelog files, a
  directory of per-lane file-size allowances, and a union-merge on the changelog
  itself — and had never stated the general rule behind them. So each solution
  read as its own special case, and the next artifact of the same shape got a
  single shared file that four parallel workstreams then appended to at once.

  The rule now lives in the contributor contract, with a row in its lookup table
  so somebody adding a new shared list is pointed at it: an artifact every lane
  adds an entry to is a directory of one file per entry, never one shared file.
  A check keeps the four known artifacts from quietly regressing, and refuses a
  new fragment directory that nobody has documented.

  The audit also found a fourth member of the class nobody had registered: the
  blue/green migration-safety ledger, one row per migration and appended to by
  every schema change. Concurrent additions to it used to conflict on the last
  line for no reason; they now merge automatically, keeping both rows, which is
  what every one of those conflicts was resolved to by hand anyway.

  Nothing an operator or member sees changes. This is repository housekeeping.
