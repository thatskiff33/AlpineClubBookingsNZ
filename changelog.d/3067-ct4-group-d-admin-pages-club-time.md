- **Admin screens now show dates and times in the club's own timezone, not the
  computer's (#2870).** Every admin page used to work out what "today" was, and
  how to spell a date and time, from whatever timezone the server or the
  administrator's own browser happened to be in. They now use the club timezone
  recorded in settings, so an officer working from another country sees exactly
  what an officer at the lodge sees.

  This also separates two things that had quietly been treated as one. A
  *calendar day* — a lodge night, a date of birth, the day someone became a life
  member — is now shown as the day it actually is, with no timezone applied to
  it at all. A *moment in time* — when a payment was recorded, when an invitation
  expires, when a booking was created — is converted into club time first. Screens
  that showed both kinds side by side were previously running them through one
  formatter, so one of the two was always a day out for any club outside New
  Zealand.

  Five things an operator may notice, all of them corrections: adding a booking
  with a past check-in date now decides "past" by the club's day rather than the
  browser's, which is what selects the retroactive pricing path; a life member's
  date no longer reads a day early; a family member's date of birth on a
  membership application no longer shares a formatter with the application's
  submission and review timestamps; partner-invitation expiry and family-group
  creation times on the family groups screen now follow the club; and the
  promo-code redemption list's on-screen "Redeemed" time now matches the day
  already used for its export filename.

  Clubs whose recorded timezone matches the timezone their server was already
  running in will see no change at all.
