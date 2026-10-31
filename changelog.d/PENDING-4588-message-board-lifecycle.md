- **Removed and expired message-board posts now stay gone, and a new post can
  no longer lose its picture to the clean-up (#4588).** Five rare faults in
  the club message board are closed:
  - A post from another club that an administrator removed here no longer gets
    its words and pictures written back when that club edits it. A removal
    from the Alpine Central Server also leaves it removed here, so a post the
    server later restores does not reappear.
  - The clean-up of abandoned uploads no longer deletes a picture that a member
    attached to a new post at the same moment.
  - The retention clean-up now deletes every picture of an expired post, even
    one added while it ran, instead of leaving the file on the server.
  - A board sync that ran so long that a second one took over now stops
    without writing anything more.
  - A shared post that came back from the central server before its sharing
    was recorded is no longer duplicated, and it now shows as shared.

  Nothing changes on screen, and there is nothing to do.
