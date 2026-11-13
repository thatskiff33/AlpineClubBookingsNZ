- **A club moving in from another system can now load its people and its
  members' credit in one checked pass.** The member CSV import takes two new
  optional columns: **Membership Type**, which gives each new member that type
  for the current season, and **Family Key**, which puts new members who share a
  key into one family group. On **Refunds & Credits**, a new **Opening credits**
  card imports a CSV of the credit members held in the old system. It shows
  every line and the total before anything is posted, posts the whole file once
  with one approval, and can reverse the batch, with a reason, until any of it
  is spent. Opening credits send no email and make no Xero or card call. When a
  member spends one, Xero codes it as the member's own money, not goodwill. A
  new guide, *Moving in from your old system*, sets out the load order, a safe
  way to carry over stays that are already paid, and the totals to check
  against the old records. Importing future bookings is coming separately
  (#5005).

- Refuse opening-credit reversal after a later deduction even when its database
  transaction began before the batch posted.
