- **Shared message-board posts no longer clash when the mirror and an
  administrator act on the same post at once (#4586).** Three rare timing
  faults in the copy of other clubs' board posts are closed. A board sync that
  ran long enough for a second one to take over no longer clears the second
  one's claim when it finishes, so a third sync cannot start beside it. A post
  removed from the central server while an administrator removes it here is
  now removed once, cleanly, instead of one of the two failing with a database
  deadlock. And the sync now decides whether a post is new or changed at the
  moment it writes it, so a post that changed in between is handled as it now
  stands. Nothing changes on screen and there is nothing to do.
