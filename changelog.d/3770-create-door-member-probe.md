- **Booking a stay or asking for a policy exception can no longer be used to
  find out whether a member exists (#3770).** At a club with member guests
  turned on, a member could name another family's member id alongside something
  that was going to be refused anyway, such as a date in the past, and tell from
  which refusal came back whether that id belonged to a real member.

  Those refusals are now checked before the member is looked up: a stay range
  that does not make sense, a guest who shares a name with the booker's own
  dependant, a date in the past, a missing or unknown lodge, and too many guests.
  The answer is now the same whether the named member exists or not. What each
  message says has not changed, but when a booking has more than one problem, a
  member may now see a different one of them first.

  When a policy-exception request names a member from outside the booker's
  family and there turns out to be nothing for a Booking Officer to review, the
  member now sees the usual "This member can't be added to this booking right
  now" message instead of "nothing to review". This applies to both new bookings
  and changes to an existing booking.
