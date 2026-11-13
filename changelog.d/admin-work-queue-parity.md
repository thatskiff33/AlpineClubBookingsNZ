- **The admin dashboard and the sidebar now agree on what needs an officer, and
  the sidebar's counts stay current (#4962).** The dashboard's attention cards
  used to miss several queues the sidebar's Needs Attention section listed, and
  the two could show different numbers for Booking Requests. Both now come from
  one list, so the same admin sees the same queues with the same numbers in
  both places. Cards follow the same access and module rules as the pages they
  open, so an admin no longer sees a card for a page they cannot use.

  The dashboard now also shows Silent Xero Webhook, Membership Applications,
  Family Group Requests, Issue Reports and open manual refund tasks, counts
  policy exception and public booking requests under Booking Requests, and
  counts admin-initiated member deletions under Account Deletion Requests. The
  sidebar's Needs Attention section now lists manual refund tasks too, so a
  collapsed Finance section cannot hide them. Both show Stuck States to admins
  with Support access.

  The sidebar now refreshes its counts when you move between admin pages,
  return to the tab, or finish a decision on a queue page, instead of only
  when the admin area first loads. If the counts cannot be loaded it says
  "Couldn't load counts" with a Retry button rather than showing nothing, and
  the dashboard names any count it could not read.
