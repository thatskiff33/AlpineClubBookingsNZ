- **A refund owed on a group booking the organiser paid for by internet
  banking can now be paid back, and goes to the organiser (#3949).** When a
  joiner's change lowered the price of their place, or an appeal on their place
  was approved, the club's refund task on the payments board could be neither
  marked paid back ("more than was ever captured on this payment") nor, once
  the organiser had cancelled the group, dismissed. It stayed open for ever.

  Marking it paid back now works, before or after the organiser cancels the
  group, and records the refund against the joiner's share of the organiser's
  group payment. The money came from the organiser, so it goes back to the
  organiser: the task says "to the group organiser by bank transfer", and the
  joiner's email says the club will refund the group organiser directly. Tasks
  already stuck can simply be marked paid back now; nothing needs migrating.

  Until #4292 the app does not raise this refund's Xero credit note (the
  joiner's booking has no invoice of its own), so marking it paid back emails
  admins to credit the group's combined invoice by hand. A price review settled as money owed back on
  such a booking goes to the organiser the same way. A joiner's own cancellation
  after such a refund no longer marks the organiser's payment as never made.

  A joiner cancelling their own place on such a group with a refund due used to
  be refused; the cancel now goes ahead and raises the same kind of task, so the
  refund goes back to the organiser by bank transfer rather than to the joiner.
  It is worked out on the club's card refund tiers, as every refund to the
  organiser is, and admins get the "Manual refund needed" email for it.

  A change that lowers the price of such a place no longer offers the joiner
  account credit: the refund, at the card refund tier, always goes back to the
  organiser by bank transfer, as it does for a group paid by card.

  A later cancellation of the group by the organiser counts a refund already
  paid this way exactly once. Dismissing a change's refund after the group is
  cancelled is still refused, as before, and the refusal now names the
  organiser. Card-paid groups are unchanged.
