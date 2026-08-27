- **A security scanner's high-severity warning about the rich email editor has
  been cleared, and the code it pointed at now uses the right tool (#3144).**
  Nothing was ever wrong with the emails a club sends: the warning was a false
  alarm, and this change confirms that and removes the cause of the confusion.

  Some background. When an administrator writes an email body with bold, italics
  and lists, everything they submit is reduced to a short list of safe formatting
  before it is stored, so nothing pasted in from elsewhere can carry hidden
  instructions into a member's inbox. There is one extra repair step: if somebody
  half-selects a placeholder like `{{firstName}}` and bolds part of it, the
  placeholder ends up split across formatting tags, and the system tidies it back
  into one piece so the member's real name still appears.

  That tidying step removed the stray formatting with a simple text search, and
  an automated scanner flagged the search as the kind that can be tricked. It
  could not see that everything the step produces is put back through the full
  safety reduction immediately afterwards, which is what actually makes it safe.
  Twelve deliberately hostile inputs were tried against the real code and every
  one came out harmless.

  The tidying now uses the same proven component that does the safety reduction,
  rather than a hand-written text search sitting next to it. The result is
  identical — eight hundred generated inputs were compared old against new with
  no difference at all — so no stored email body changes, and nothing an
  administrator does looks any different. The hostile inputs are now kept as
  permanent tests, so a future change to this area has to keep them harmless.
