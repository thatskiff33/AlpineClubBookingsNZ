- A booking left without adult supervision because the member was asked about
  their other booking and chose not to move it now says exactly that in the
  booking officer's queue, on its own. Until this update it shared the wording
  every other uncovered booking carries - "no longer covered after a later
  change" - which is true of an administrative cancellation, a lifecycle change,
  a data correction and a rule the club itself tightened. So an officer could
  read the entry and not know whether anybody had decided anything, and counting
  the entries by reason mixed a member's own deliberate choice in with changes
  nobody chose. That count is what a club looks at to judge whether its
  supervision setting is doing its job, and it now separates the two. The
  booking's history still records the member's decision in words as well, since
  the words say which booking they were editing when they were asked (#3241,
  `INV-HOST-052`).
- This completes the change promised in the previous release, where the label
  had to be added to the database one release before anything wrote it: the
  version of the site still running while a new one is being put in place cannot
  read a label it has never heard of, and here that read is the one every
  supervision re-check performs rather than merely a screen (#3241,
  `INV-HOST-052`).
