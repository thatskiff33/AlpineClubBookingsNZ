- **The deadline for approving a member guest is now set on the club's own
  calendar, and clubs west of Greenwich were giving people a whole day less than
  their policy says (#3123).** When someone puts another member on their booking
  and the club asks that person first, the request holds a bed until a deadline:
  the club's configured number of days, but never later than the start of the day
  before check-in. Working that out involved a stay's check-in date, which is a
  plain calendar date, and turning the day before it into an actual moment, which
  does need a timezone.

  Both were being handled with the timezone of the server the site runs on, and
  the check-in date should not have been converted at all. For a club west of
  Greenwich the conversion named the previous day, so the deadline landed exactly
  twenty-four hours early — measured on `America/Denver`, a stay arriving on
  4 August produced a deadline on the 2nd where the club's policy says the 3rd.

  What that cost a person: the "answer by" date in the request email, the
  "expires" note on their booking, and the overnight sweep that releases the bed
  all came a day sooner than intended. For a booking made close to the stay it
  was worse — the too-early deadline was already in the past, so the request fell
  back to its two-hour minimum and the person had almost no time to reply.

  The check-in date is now read as the calendar date it is, with no timezone
  involved, and only the last step — turning the day before into a moment — uses
  the timezone saved on the club's own settings page. The dates shown on the
  consent card, the delegate's approval page and the booking list's consent chips
  are named by that same saved timezone rather than the server's.

  Clubs at or ahead of Greenwich — which is every club today, New Zealand
  included — were never affected and see no change. No stored deadline changes,
  and no existing request is re-dated.
