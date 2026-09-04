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
  message says plainly what was refused, why, and what has to be true before the
  tick can be set: those nights have to carry a price, which happens when an
  officer settles the booking's amount. The refusal appears before you press Save
  as well as after, so it is not a surprise at the end.

  Nothing an officer could previously do is lost. A booking that is already
  waiting on one of these amounts has refused the tick all along, for the same
  reason; this brings the one change that starts the wait into line with every
  other. Ordinary bookings are untouched — the tick works exactly as it did.

- **An officer can now record what a booking's nights sold for, from the booking
  itself (#3214).** The refusal above ends by saying those nights have to carry a
  price first. On the bookings it most often meets — the ones created by
  approving a public request — there was no way to give them one: those
  bookings refuse the ordinary edits, so the job that asks for the figures could
  never be raised.

  Open the booking, look under **Admin tools**, and a guest the club cannot price
  now appears under **Nights whose sold price the records cannot tell us**, with
  the reason in plain words and whatever is on file for each night. Give a figure
  for every night of that guest's stay and press **Record what these nights sold
  for**.

  **It cannot change what anybody owes**, and that is arithmetic rather than a
  promise: the figures have to come to exactly what that guest's stay is already
  stored as being worth, so the amount owing is the same number afterwards. What
  changes is how that figure is made up night by night, which is what a later
  part-refund is worked out from. Nothing is filled in for you — no even split,
  no current rates, no starting figure in any box — and $0.00 is a real price
  for a night that was genuinely free.

  It covers the three ways the records can fail: some nights with no price, no
  night prices stored at all, and night prices that do not add up to the stay.
  It is offered per guest, so a booking with two such guests needs both. It is
  not offered while the booking is waiting on the office to confirm an amount,
  because that job asks for the same figures as part of settling it. A guest
  whose nights already add up is refused outright, so this cannot be used to
  re-price an ordinary booking. It needs **Finance — Edit**, and it is
  audited: the figures given, what each night held before, and what the stay was
  worth before and after — the same number, twice, so the log shows it.
