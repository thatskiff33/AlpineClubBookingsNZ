- **Subscription categories can now be set for many members at once, filtered
  on the members list, and moved between deployments (#5248).** On
  **Admin → Members**, tick members and choose **Set Subscription Category**
  to set or clear their category for a season. A preview shows who moves from
  which category to which and who is skipped and why; each member keeps their
  membership type, and each change is written to that member's audit trail.
  Members already paid or invoiced for the season are flagged: their invoice
  for that season does not change. A category is set per season and is not
  carried into the next one.

  The members list has a **Subscription Category** filter, including
  **Individual (no category)**, and shows each member's category under their
  type and tier. The CSV export follows the filter.

  **Export & Import** now carries subscription categories and their fee
  schedules in the Membership fees category. Importing the same bundle twice
  changes nothing; which member is in which category is not carried. Grouping
  Xero contacts by subscription category is coming in a later release.

  Both bulk actions, **Set Subscription Category** and **Set Membership
  Type**, now handle each member the same way. If one member's change fails
  unexpectedly, the others still go through. The failed member shows a plain
  message, and the details go to the server log. A run in which nothing
  changed and at least one member failed is recorded in the audit log as a
  failure.
