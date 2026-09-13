- **A full night on the booking calendar is no longer a dead end, and a checkout
  morning no longer has to be quiet (#2930).** The member booking calendar used
  to grey out every full night and refuse to let anyone click one. That looked
  tidy and cost members two perfectly ordinary bookings.

  The first was the waitlist. The club has had a waitlist all along, and the only
  way to reach it was to try to book dates that turn out to be full — but the
  calendar would not let a member choose those dates, and the guests step refused
  to continue if they did. The door was there and the screen in front of it was
  locked. A full future night is now selectable and labelled **Waitlist**;
  choosing it takes the member through the normal booking steps and offers them a
  place on the waitlist at the end.

  The second was the morning you leave. Nobody uses a bed on their check-out day,
  so a stay that ends on a busy Sunday is perfectly bookable — but the calendar
  greyed that Sunday out along with every other full night, and there was no way
  to say "I am leaving then". Once a check-in date is chosen, a full date is now
  offered as a check-out morning and says so, both on screen and to a screen
  reader.

  **You are no longer asked how you want to pay for a place you do not yet have.**
  A waitlist place takes no money and reserves no bed, so the payment-method
  choice has been removed from that path. It is asked for later, in the ordinary
  way, if a place opens up and the booking can actually be confirmed.

  **The calendar now counts the right lodge's beds.** Clubs with more than one
  lodge were shown free-bed counts worked out against a single club-wide bed
  total, so a smaller or capped lodge could be described as fuller or emptier
  than it really was. Each lodge's own bed count is now used for its own
  calendar. A month whose availability has not loaded — or could not be
  fetched — now says so on the day instead of being drawn as a completely empty
  lodge, and months already looked at stay loaded when paging back and forth.

  **Nothing reveals that a lodge is reserved for a private group.** When the
  whole lodge is held for one booking, members see exactly what they see when it
  is simply full, and that is now true of the underlying data as well as the
  wording: a refusal caused by a hold used to come back naming no nights at all
  where an ordinary full lodge named them, which showed up on screen as "at
  capacity on 0 nights" and told anyone paying attention that something else was
  going on. Both cases now read and behave identically. Members can join the
  waitlist over those nights, and are moved off it only once the hold no longer
  applies.

  Booking on a member's behalf from the admin screens is unchanged: a full night
  there still means the over-capacity confirmation an officer already knows, not
  the member waitlist.
