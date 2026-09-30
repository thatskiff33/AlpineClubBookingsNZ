- **The Finance dashboard's "Net collected cash" now counts the same bookings as
  every other Net Collected figure, so its number changes (#3637).** It used to
  count only bookings with a stay status (confirmed, paid, completed, pending
  and awaiting payment), and it did not check whether a booking had been
  deleted. It now counts every booking staying in the selected range, whatever
  its status, and leaves deleted bookings out: the rule the admin dashboard,
  the Payments page and Reports already use (#3372). So the figure **goes up**
  by any cancellation fee the club kept on a cancelled booking, and **goes
  down** by any payment on a deleted booking. The figure is worked out by the
  same calculation as those three pages. Guest nights, occupancy, booked
  revenue, outstanding additional payments and the payment status counts are
  unchanged.
- **Xero booking invoices read the shared list of payment statuses that mean
  money was taken (#3637).** Nothing Xero receives changes.
