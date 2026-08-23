- **Member, public, lodge and lobby-display screens now show dates and times in
  the club's own timezone, not the viewer's (#2870).** These pages used to work
  out what "today" was, and how to spell a date and time, from whatever timezone
  the server or the member's own browser happened to be in. They now use the club
  timezone recorded in settings, so a member booking from overseas sees the same
  lodge nights as a member standing in the lodge.

  It also separates two things that had been treated as one. A *calendar day* — a
  lodge night, a date of birth — is shown as the day it actually is, with no
  timezone applied. A *moment in time* — when an application was submitted, when
  a hold expires — is converted into club time first. The member dashboard was
  running both kinds through a single formatter, which looked correct in New
  Zealand and was a day early anywhere west of Greenwich.

  What an operator or member may notice: the dashboard's dates are correct for
  clubs outside New Zealand; a dependant's date of birth on a membership
  nomination no longer reads a day early; the finance dashboard's "as of" date
  now follows the club's day, so the morning's figures no longer sit a day behind
  the afternoon's; and the lobby display screen is given the club's timezone
  directly by the server rather than guessing from the machine it runs on.

  Public payment and invitation links are also more robust: if the information
  behind one of those links is missing or malformed, the page now shows what it
  can instead of failing to load.

  Clubs whose recorded timezone matches the timezone their server was already
  running in will see no change at all.
