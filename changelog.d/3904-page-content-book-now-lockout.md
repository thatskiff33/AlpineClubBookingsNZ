- **The Public fee and policy blocks panel can no longer lock itself up over a
  hidden Book Now page, and deleting a page handles its rare edge cases
  (#3852).** If the **Book Now** button was hidden while it still pointed at a
  page that was later hidden, every **Save visibility** failed with a generic
  message and the controls that could fix it were not on screen. The target
  choices now stay visible whenever a page target is saved, and a failed save
  shows the server's own reason, which names the setting to change.

  Deleting a page is also safer in the uncommon cases. The audit log copy of a
  deleted page is now the page as it was at the moment it was removed, so an
  edit made just before the delete is not lost; the message after the delete
  says when that copy is not complete because part of the page was redacted or
  too large to keep. Two officers deleting the same page at once now get one
  delete and one "page not found", not an error. A **Book Now** setting left
  pointing at a deleted page is set back to the booking flow and the message
  says so. A settings save whose chosen page is deleted at the same moment is
  refused with the usual "not published" message rather than an error. The
  delete confirmation now says when its footer or **Book Now** check could not
  run, and that links written as relative addresses are not detected; the
  "could not clear the stored copy" message no longer promises it clears in a
  few minutes, and says that saving any page clears it.
