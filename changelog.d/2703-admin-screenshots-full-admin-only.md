- **A screenshot taken by someone with admin access is now shown only to a Full
  Admin (#2703).** When a member reports a problem they can attach a picture of
  the screen they were looking at. Reading those reports needs "Support" access,
  which a club can hand out on its own — an officer can be given it to triage
  issue reports without being given any access to member records at all.

  That left a gap. If the person reporting the problem was themselves an
  officer, the picture could be of an admin screen, and an admin screen shows
  member names, addresses and dates of birth. A support-only officer could
  therefore read, off a picture, exactly the member details the club had
  deliberately not given them.

  From now on the system records — at the moment a report is filed, from the
  reporter's own access, and never from anything their browser tells it — whether
  the person who took the picture had admin access. If they did, the picture is
  shown only to a Full Admin. Every other officer sees the report in full, sees
  that a screenshot exists, and is told plainly why it is not shown. Everything
  else about the report is unchanged: the description, the page address, the
  browser details and the ability to resolve, reopen or delete the report all
  work exactly as before, and an officer can still delete a screenshot they
  cannot see.

  Pictures attached by an ordinary member are unaffected and are still shown to
  anyone with Support access, as they always have been.

  Reports that already existed when this release is installed carry no record of
  who took the picture, so the system assumes the cautious answer and shows
  those to Full Admins only. They clear themselves within a month, because
  screenshots are already deleted automatically after 30 days.

  The audit log now records, for every report an officer opens, whether the
  screenshot was shown, withheld, already expired or previously deleted, and
  writes a separate entry each time one is withheld. Neither entry records
  anything about what the picture showed.
