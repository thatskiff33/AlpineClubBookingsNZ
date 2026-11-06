- **A subscription billing category can now be set independently of a
  member's membership type (#4554).**
  Previously, the only way to bill two
  members as a couple or a family was the "Family" membership type itself —
  which also changed their booking rights and hut rate, since membership
  type was the only lever that controlled both. A club with two Senior
  members who are a couple had no way to bill them a flat couple's rate
  while both kept full Senior booking rights.

  A new **Subscription Categories** page (reached from the Membership &
  Members setup hub) lets an admin define club-specific billing categories —
  "Couple," "2 Adults + 2+ Children," or any other composition the club
  bills differently. Each category gets its own flat annual fee on the Fees
  page, independent of age tier and billing basis. On a member's profile,
  the existing Membership Type selector is untouched, and a new Subscription
  Category selector sits alongside it — assign the category to each member
  of a couple or family and the next billing run charges them together at
  the category's flat rate instead of their individual membership-type fee.

  A member with no category assigned (the default for every existing
  member) bills exactly as before. Booking rights, hut rate, and the
  unpaid-subscription lockout are decided entirely by membership type, both
  before and after this change — a category only ever affects the annual
  subscription amount and how it is grouped.

  Bulk category assignment, filtering the members list by category, and
  Xero contact grouping by category are not part of this change; assignment
  is one member at a time, from their profile, for now.
