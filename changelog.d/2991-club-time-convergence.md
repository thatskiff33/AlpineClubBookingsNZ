- **The club's own timezone now decides every date and time the club shows, and
  the platform can prove it (#2991).** Whatever timezone the server happens to
  run in, and whatever timezone the person looking at the screen is in, a lodge
  night, a booking date, a payment stamp and a season label all read the same.
  That was the intent of the whole Club Time change; this is the piece that
  demonstrates it rather than assuming it.

  Two proofs were built. One runs the club's real calculations under six
  different server timezones, from eleven hours behind Greenwich to fourteen
  ahead, and checks the answers do not budge. The other loads member and admin
  screens as if the viewer's browser were in six different countries and checks
  the dates on screen do not budge either. Each of them first shows that the
  timezone genuinely changed — by reading a real date and time out of it, not by
  comparing the timezone's name — so a check that quietly stopped testing
  anything fails loudly instead of passing.

  A third proof covers daylight saving in both hemispheres, leap day, month end
  and year end: the number of nights a stay occupies is a calendar fact and
  never changes, while the real time between arrival and departure can be
  twenty-three or twenty-five hours when the clocks move.

- **Three ways of accidentally re-introducing the bug are now blocked
  automatically (#2991).** Reading a date through the server's own clock,
  treating the deployment's environment timezone as the club's, and reaching for
  the `date-fns` library — which does the first of those inside its own code,
  where nothing here could see it — all now fail the build with a message that
  names the right replacement. Each block was deliberately broken to confirm it
  actually catches what it claims to.

- **Four real defects were found and fixed while closing that off (#2991).**
  Check-in reminder emails and non-member hold deadlines were each stepped
  forward a day using the server's clock rather than the calendar, so on a
  daylight-saving weekend they landed an hour off and could pick the wrong
  night. The admin booking calendar could draw a booking one day early in any
  country whose clocks go forward at midnight. And one calculation in the hut
  leader roster job was being made and then never used.

- **Timezone-forcing advice in the contributor testing guide was wrong and has
  been corrected (#2991).** On the shell this repository documents for Windows,
  setting the timezone to `UTC` works while setting it to any named place is
  silently ignored — so a check written by following that advice would appear to
  test six timezones and actually test one. The guide now carries the
  measurement and the methods that do work.
