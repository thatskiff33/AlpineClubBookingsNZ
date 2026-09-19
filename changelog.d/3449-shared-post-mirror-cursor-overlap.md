- **A post shared by another club can no longer be missed from your message
  board for good (#3449).** The pull that brings other clubs' shared posts onto
  your board remembers how far it got and asks the central server only for what
  changed since then. Two posts saved at the central server at almost the same
  moment can become visible out of order, and a post caught on the wrong side
  of that gap was stepped over and never asked for again — silently, because a
  missing post leaves no gap on the board to notice.

  Each pull now starts a minute before where it got to, which closes that gap.
  It is the same re-ask the Alpine Central Server download gained in #2995,
  from the same single setting. You will not notice it: a post the re-ask brings
  back that is already on your board exactly as delivered is recognised and
  written nowhere, and is reported as unchanged rather than as a change in the
  job's result. The remembered position only ever moves forward and only to
  where the central server says the pull got to, the first pull after you
  connect is unchanged, and a pull that fails part-way keeps what it had
  already applied and picks up from there next time — nothing is lost.

  As with the download, a central server that marks its place with a reference
  of its own rather than a timestamp gets no re-ask, and the application log
  now says so on each such pull.
