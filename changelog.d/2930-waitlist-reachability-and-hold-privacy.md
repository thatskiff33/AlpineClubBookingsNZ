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
  Switching lodge clears the old lodge's numbers straight away rather than
  leaving them on screen until a reply comes back — which, for a lodge you are
  not able to book, never happened. A season label whose season has since been
  turned off stops being shown the next time that month is loaded.

  **Nothing reveals that a lodge is reserved for a private group.** When the
  whole lodge is held for one booking, members see exactly what they see when it
  is simply full, and that is now true of the underlying data as well as the
  wording: a refusal caused by a hold used to come back naming no nights at all
  where an ordinary full lodge named them, which showed up on screen as "at
  capacity on 0 nights" and told anyone paying attention that something else was
  going on. Both cases now read and behave identically. Members can join the
  waitlist over those nights, and are moved off it only once the hold no longer
  applies.

  Three member screens had the same gap, not one. **Changing the dates of a
  booking you already have** showed "Not enough beds available" over an empty
  list when a hold was the reason, and over an itemised one when the lodge was
  genuinely full — and the itemised version printed how many beds short each
  night was, which a held night has no answer for. **Settling a group booking**
  named no nights for the same reason, and named them in a different format from
  every other message the club sends. All three now say the same thing the same
  way, and the club's own count of how many beds are missing stays on the
  officer's screen, where it belongs.

  **The waitlist keeps your account credit, and the screen no longer over-promises
  what it can do.** Joining the waitlist from the review step sent everything
  except the credit you had chosen to apply. That request can still turn into a
  real booking if a bed frees up in the moment between reading the screen and
  pressing the button, so the booking could be created without the credit and
  cost more than the page had quoted. The credit box also said "credit covers
  entire booking — no card payment needed" on a stay that could only be
  waitlisted, which a waitlist place does not deliver: it holds no credit, and if
  a bed opens up later the stay is priced again. The box now says so, and still
  applies your credit to the booking on the spot if one turns out to be possible.

  **"Also waitlist me for another lodge" is offered wherever the waitlist is.**
  Those tick boxes only appeared on the older "lodge is fully booked" panel, so a
  member taken straight to the waitlist from the review step never saw them.

  **A lodge whose beds have not been set up yet no longer leaves you on a screen
  with nothing on it.** With no bed count configured, a lodge counts as having
  none — deliberately, so it cannot be overbooked by accident. Both the member's
  guests step and the officer's book-on-behalf screen were reading that as "you
  may add nobody": every add-guest control switched off at zero guests, under a
  heading that read "0 of 0 max", while the calendar was offering the waitlist.
  Neither screen imposes that ceiling now and the decision goes to the server.

  What that does not do is make such a lodge bookable. A booking still cannot
  exceed a lodge's bed count, so where there is none the server refuses the
  create outright rather than offering a waitlist place. The refusal at least
  names its cause, which a screenful of disabled buttons did not, but configuring
  the lodge's capacity is what actually unblocks it.

  Booking on a member's behalf from the admin screens is otherwise unchanged: a
  full night there still means the over-capacity confirmation an officer already
  knows, not the member waitlist.
