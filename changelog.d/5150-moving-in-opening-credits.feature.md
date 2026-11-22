- **A club moving in from another system can now load its people and its
  members' credit in one checked pass (#4988).** The member CSV import takes
  two new optional columns: **Membership Type**, which gives each new member that type
  for the current season, and **Family Key**, which puts new members who share a
  key into one family group. On **Refunds & Credits**, a new **Opening credits**
  card imports a CSV of the credit members held in the old system. It shows
  every line and the total before anything is posted, posts the whole file once
  with one approval, and can reverse the batch, with a reason, until any of it
  is spent. Opening credits send no email and make no Xero or card call. When a
  member spends one, the Xero credit note is coded to a new optional **Opening
  Credits** account mapping, for example a member credits held account, or to
  the hut fee refunds account while it is unset; never to goodwill. While
  that mapping is set, the spent credit is its own line, sent with the Xero
  tax rate mapped to the **Exempt** tax category; a GST-registered club maps
  Exempt first, and the account mapping refuses the Opening Credits account
  until it has, or on an account another mapping already uses. While the
  account is mapped and the club is, or is scheduled to be, GST-registered,
  clearing Exempt is refused, and the Xero health check
  warns a club that has no usable Exempt rate, for example after scheduling a
  GST registration, which is never refused for this. A configuration import
  is held to the same shared-account rule, and warns where Exempt is not
  mapped. A club that leaves the mapping unset sends exactly the
  credit note it sent before. A
  new guide, *Moving in from your old system*, sets out the load order, a safe
  way to carry over stays that are already paid, and the totals to check
  against the old records. Importing future bookings is coming separately
  (#5005).
