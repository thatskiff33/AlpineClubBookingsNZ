- **Far fewer of the refusals on booking and policy-exception requests can be
  used to find out whether a member exists (#3770).** At a club with member
  guests turned on, a member could name another family's member id alongside
  something that was going to be refused anyway, such as a date in the past, and
  tell from which refusal came back whether that id belonged to a real member.

  On a new booking, these are now checked before the named members are looked
  up, so they answer the same either way:
  - a stay range that does not make sense;
  - a guest who shares a name with the booker's own dependant;
  - a date in the past, a stay shorter than the lodge's minimum, a missing or
    unknown lodge, or too many guests;
  - the booker's own unpaid subscription;
  - Internet Banking when it is unavailable or too close to check-in;
  - a working bee or promo code that cannot apply.

  On a policy-exception request, the stay range and the dependant question are
  also checked first. So are a lodge that does not exist, replacing a request
  that is no longer open, and asking again while another request on the same
  booking is still open.

  What each message says has not changed. When a booking has more than one
  problem, though, a member may now see a different one of them first.

  When a policy-exception request names a member from outside the booker's
  family and there turns out to be nothing for a Booking Officer to review, the
  member now sees the usual "This member can't be added to this booking right
  now" message instead of "nothing to review". Those refusals on both exception
  requests are now recorded in the audit log, held to the same minimum response
  time as the booking screens, and counted towards the same limit on how often a
  member can try to add someone outside their family.

  Some refusals about the booker's own family still depend on everyone in the
  party being looked up first, such as a family member who is already booked
  those nights or whose subscription is unpaid. Those are a separate decision for
  the club's owner.
