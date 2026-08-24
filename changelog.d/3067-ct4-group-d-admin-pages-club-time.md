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

  Nine things an operator may notice, all of them corrections: adding a booking
  with a past check-in date now decides "past" by the club's day rather than the
  browser's, which is what selects the retroactive pricing path; a life member's
  date no longer reads a day early; a family member's date of birth on a
  membership application no longer shares a formatter with the application's
  submission and review timestamps; partner-invitation expiry and family-group
  creation times on the family groups screen now follow the club; the
  promo-code redemption list's on-screen "Redeemed" time now matches the day
  already used for its export filename; on the family-group request review
  screen, a declared date of birth is now shown as the day it was declared while
  the "Requested" stamp beside it is converted into club time, so approving a
  request can no longer record a birthday a day out — which matters because the
  day decides an age tier, and the age tier decides a price band; a member's
  "last stay" now reads the same day in the summary strip at the top of their
  page and in the history line below it, instead of differing by a day; the
  payments screen's default "last updated" range now covers the whole of the
  club's day, where it previously cut off partway through it and dropped the most
  recent payments from the officer's view with nothing on screen to say so; and
  the dashboard's hut-leader coverage card now counts the same nights as the
  roster and bed-allocation cards beside it on a day boundary.

  Clubs whose recorded timezone matches the timezone their server was already
  running in will see no change at all.
