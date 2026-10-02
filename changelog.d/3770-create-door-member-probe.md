- **Booking and policy-exception requests no longer give away whether a member
  exists through which refusal comes back (#3770).** At a club with member
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
  - a working bee that cannot apply;
  - a promo code that is unknown, inactive, out of date, for another lodge,
    assigned to someone else, or waiting for the member to choose which guests
    get it.

  The booker's own family is now also checked before anyone from outside it is
  looked up. A family member who is already booked those nights, whose
  membership type does not allow bookings, whose subscription is unpaid, or whose
  details are incomplete is reported in full. Before, an outsider's refusal took
  priority over those messages; now the family message comes first on this
  screen.

  If a booking needs a paid-up adult member or an adult host, and the member has
  named someone from outside their family, the check now waits until that
  person is known. If they meet the requirement, the booking goes ahead as
  before. If the requirement is still not met, the member sees the usual "This
  member can't be added to this booking right now" message instead of the
  detailed one.

  On a policy-exception request, these are also checked first:
  - the stay range and the dependant question;
  - a lodge that does not exist;
  - replacing a request that is no longer open;
  - asking again while another request on the same booking is still open.

  What each message says has not changed, apart from the two neutral messages
  described here. When a booking has more than one problem, though, a member may
  now see a different one of them first.

  When a policy-exception request names a member from outside the booker's
  family and there turns out to be nothing for a Booking Officer to review, the
  member now sees the usual "This member can't be added to this booking right
  now" message instead of "nothing to review". Those refusals on both exception
  requests are now recorded in the audit log, held to the same minimum response
  time as the booking screens, and counted towards the same limit on how often a
  member can try to add someone outside their family.

  Some promo-code refusals still come after the lookup, because they depend on
  who is on the priced booking. These are a code that has reached one of its
  usage limits, a code that needs an assigned member to be staying, and a code
  that some of the chosen guests cannot use or that allows fewer guests than
  were chosen.
