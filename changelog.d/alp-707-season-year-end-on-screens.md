- **Admin season pickers and season names now follow the club's financial year-end (#5259).**
  A club sets the month its financial year ends in, but screens drawn in the
  browser always assumed March: a club whose year ends in June still saw
  "2026 - 2027 (Apr-Mar)" on Subscriptions, and the picker selected April-based
  seasons. The year-end now reaches those screens from the server, so the
  season each picker selects and the name it shows both follow the setting. On
  15 June 2026 a June club's Subscriptions screen opens on "2025 - 2026
  (Jul-Jun)", the season it is still in. This covers Subscriptions, Membership
  Types roll-forward, a member's seasonal membership card, summary strip and
  subscription history, the bulk membership dialog (which now starts on the
  current season rather than the calendar year), the member profile and the
  member data export, and the routes those screens call.

  Clubs whose year ends in March, which is every club running today, see no
  change.
