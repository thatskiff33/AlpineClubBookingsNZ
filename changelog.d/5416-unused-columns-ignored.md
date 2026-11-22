- **Three settings columns nothing uses are no longer named in the app's
  database queries, ahead of removing them in the next release (#5396).** They
  are a retired multi-lodge module switch, a waitlist notification preference
  that was never offered, and a retired school hut-leader switch. Nothing a
  member or officer sees changes, and this release changes nothing in the
  database: the three columns stay where they are.

  The reason for doing it in two steps is upgrade safety. While one release is
  being replaced by the next, the old one is still saving settings, and every
  save names every column it knows about. Removing a column the old release
  still names would make those saves fail until the switch-over finished. From
  this release on the app no longer names the three columns, so the next release
  can remove them safely. Notes in the code that said the multi-lodge column was
  already safe to remove were wrong for exactly this reason and have been
  corrected.

  One visible detail: a member's personal-data export no longer lists the
  never-offered waitlist preference. No one could ever set it, so the export
  loses nothing about the member.
