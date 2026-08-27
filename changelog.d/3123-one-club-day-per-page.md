- **An exported report's cover date and its filename can no longer disagree
  (#3123).** The PDF an officer downloads from the Reports screen stamps
  "Generated: 16 April 2026" on its first page and puts the same day in the saved
  file's name. Those were two separate readings of the clock, taken a few seconds
  apart with the page capture in between — so an export running across the club's
  midnight produced a file named for one day whose cover said another, in a
  document somebody keeps and later files by date. Both now come from a single
  reading.

- **A booking page decides once what day it is (#3123).** The "take myself off
  this stay" card and the guest-consent card beside it each worked out the club's
  current day for themselves, rather than using the one the page had already
  resolved for its other checks. Across the club's midnight that could offer a
  member a self-removal button that the very next check refused, or hide one they
  were still entitled to. Both cards now read the page's single answer.

- **Public fee and policy pages no longer print their season dates through a
  hard-coded New Zealand timezone (#3123).** The date ranges beside each season,
  booking period and cancellation period were formatted through
  `Pacific/Auckland` written into the code, rather than through the club's own
  settings — and the values being formatted are plain calendar dates that need no
  timezone at all. The published wording is unchanged for New Zealand clubs; a
  club elsewhere no longer has this one club's timezone baked into its public
  pages.
