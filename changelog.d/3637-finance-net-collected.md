- **The Finance dashboard's "Net Collected Cash" now counts the same bookings as
  every other Net Collected figure, so its number changes (#3637).** It used to
  count only bookings with a stay status (confirmed, paid, completed, pending
  and awaiting payment), and it did not check whether a booking had been
  deleted. It now counts every booking staying in the selected range, whatever
  its status, and leaves deleted bookings out: the rule the admin dashboard,
  the Payments page and Reports already use (#3372). So the figure **goes up**
  by any cancellation fee the club kept on a cancelled booking. (It would also
  drop a deleted booking's payment, but the admin delete only acts on bookings
  already cancelled, which this figure never counted before, so in practice
  that changes nothing.) The figure is worked out by the
  same calculation as those three pages. Its "may understate" warning now
  checks the same bookings the figure counts, in the same words Reports and the
  Payments page use. The card is now titled "Net Collected Cash", as it is on
  the Payments page and Reports. Guest nights, occupancy, booked
  revenue, outstanding additional payments and the payment status counts are
  unchanged.
- **Xero booking invoices read the shared list of payment statuses that mean
  money was taken (#3637).** Nothing Xero receives changes.
- **The "Net Collected Cash may understate" warning prints its booking or
  payment count in the club's number format (#3637)**, so 1,234 reads "1,234"
  on the Finance dashboard, the Payments page and Reports alike.
