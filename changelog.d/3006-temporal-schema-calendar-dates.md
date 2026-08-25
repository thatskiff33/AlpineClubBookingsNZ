- Dates that mean a calendar day — a date of birth, a joining date, a promo
  code's window, a group booking's join deadline — are now stored as real
  dates rather than as timestamps that everybody agreed to keep at midnight.
  Along the way this fixed four places where the day shown or used was wrong
  by one: the age-up job could miss a member whose birthday fell exactly on
  the season start, which decides their age tier and therefore their price;
  editing a promo code walked its start and end dates a day earlier each time
  it was saved, for clubs west of Greenwich; the new-member report counted
  from a day too early; and a member's age could read a year out on the day
  before their birthday.
