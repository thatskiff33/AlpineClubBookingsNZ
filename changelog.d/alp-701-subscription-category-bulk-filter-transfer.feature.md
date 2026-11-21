- **Subscription categories can now be set for many members at once, filtered
  on the members list, and moved between deployments (#5248).** On
  **Admin → Members**, tick members and choose **Set Subscription Category**
  to set or clear their category for a season. A preview shows who moves from
  which category to which and who is skipped and why; each member keeps their
  membership type, and each change is written to that member's audit trail.
  Members already paid or invoiced for the season are flagged: the new
  category takes effect from their next invoice.

  The members list has a **Subscription Category** filter, including
  **Individual (no category)**, and shows each member's category under their
  type and tier. The CSV export follows the filter.

  **Export & Import** now carries subscription categories and their fee
  schedules in the Membership fees category. Importing the same bundle twice
  changes nothing; which member is in which category is not carried. Grouping
  Xero contacts by subscription category is coming in a later release.
