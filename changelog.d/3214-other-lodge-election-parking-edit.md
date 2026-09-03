- **An "other club member" tick is no longer half-applied on a change whose
  amount the office has to price by hand (#3214).** Some bookings hold nights
  whose original price the club's records cannot tell us — older ones, and ones
  created by approving a public request. Saving a change to one of those keeps
  the change but parks the money as a job for a person, and nothing on that path
  is re-priced. An other-lodge tick made in the same change was therefore taken
  by the screen and then quietly dropped, in both directions: ticking somebody
  did nothing at all, while the same change still saved the partner lodge, so an
  officer got a success, a lodge on the booking and no ticks; unticking somebody
  cleared the flag while their nights stayed sold at the other club's member
  rate, leaving the booking's records and its money disagreeing about what had
  been charged. Nothing on screen mentioned either.

  The change is now refused instead, and refused whole — the ticks and the lodge
  together, so nothing is saved and there is no half-applied edit to unpick. The
  message says plainly what was refused, why, and what to do next: save the rest
  of the change on its own, wait for the amount to be confirmed, then set the
  tick. The refusal appears before you press Save as well as after, so it is not
  a surprise at the end.

  Nothing an officer could previously do is lost. A booking that is already
  waiting on one of these amounts has refused the tick all along, for the same
  reason; this brings the one change that starts the wait into line with every
  other. Ordinary bookings are untouched — the tick works exactly as it did.
