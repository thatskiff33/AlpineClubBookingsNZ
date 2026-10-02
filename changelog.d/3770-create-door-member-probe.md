- **Most refusals on booking and policy-exception requests no longer give away
  whether a member exists (#3770).** At a club with member guests turned on, a
  member could name another family's member id alongside something that was
  going to be refused anyway, such as a date in the past, and tell from which
  refusal came back whether that id belonged to a real member.

  On a new booking, these are now checked before the named members are looked
  up, so they answer the same either way:
  - a stay range that does not make sense, including a guest whose own stay
    starts in the past;
  - a guest who shares a name with the booker's own dependant;
  - a date in the past, a stay shorter than the lodge's minimum, a missing or
    unknown lodge, a lodge the booker may not book, a room from another lodge,
    or too many guests;
  - the booker's own unpaid subscription;
  - a night the lodge is already full on, judged on the member guests;
  - Internet Banking when it is unavailable or too close to check-in;
  - a working bee that cannot apply;
  - a promo code that is unknown, inactive, out of date, for another lodge,
    assigned to someone else, or waiting for the member to choose which guests
    get it.

  The booker's own family is now checked before anyone from outside it is
  looked up, both on a new booking and on a policy-exception request. A family
  member whose details are incomplete is reported in full. On a new booking, the
  same goes for a family member who is already booked those nights, whose
  membership type does not allow bookings, or whose subscription is unpaid.
  Before, an outsider's refusal took priority over those messages; now the
  family message comes first. Where member guests are switched off, naming an
  outsider is still refused first, exactly as before.

  Three rules can be met by an adult from outside the family:
  - having a paid-up adult member;
  - having an adult host;
  - having an adult with any children.

  If a member names such a person, these rules are now checked once that person
  is known. An outsider who is still waiting to agree does not count towards a
  paid-up adult member or, when the booking is made, an adult host. They do
  still count as the adult with children, as before. If the
  rule is still not met, the member sees the usual "This member can't be added
  to this booking right now" message instead of the detailed one. A member can
  no longer avoid the hosting check by sending the reason an officer would give.

  On a policy-exception request, these are also checked first:
  - the stay range and the dependant question;
  - a lodge that does not exist;
  - replacing a request that is no longer open;
  - asking again while another request on the same booking is still open.

  What each message says has not changed, apart from the neutral messages
  described here. When a booking has more than one problem, though, a member may
  now see a different one of them first.

  When a policy-exception request names a member from outside the booker's
  family and there turns out to be nothing for a Booking Officer to review, the
  member now sees the usual "This member can't be added to this booking right
  now" message instead of "nothing to review". Those refusals on both exception
  requests are now recorded in the audit log, held to the same minimum response
  time as the booking screens, and counted towards the same limit on how often a
  member can try to add someone outside their family.

  Some refusals still come after the named members are looked up:
  - a promo code that has reached one of its usage limits, needs an assigned
    member to be staying, or that some of the chosen guests cannot use;
  - refusals caused by two requests landing at the same moment.
