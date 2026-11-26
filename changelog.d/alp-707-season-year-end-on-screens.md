- **Admin season pickers and season names now follow the club's financial year-end (#5259).**
  A club sets the month its financial year ends in, but screens drawn in the
  browser always assumed March: a club whose year ends in June still saw
  "2026 - 2027 (Apr-Mar)" on Subscriptions, and the picker selected April-based
  seasons. The year-end now reaches those screens from the server, so the
  season each picker selects and the name it shows both follow the setting. On
  15 June 2026 a June club's Subscriptions screen opens on "2025 - 2026
  (Jul-Jun)", the season it is still in. This covers Subscriptions, Membership
  Types roll-forward, a member's seasonal membership card, summary strip and
  subscription history, the two bulk membership dialogs, the member profile
  and the member data export. The routes behind them, and the member imports,
  now default to that same season too.

  Clubs whose year ends in March, which is every club running today, see the
  same seasons and names as before. One small difference: between January and
  March, the two bulk membership dialogs briefly showed the calendar year as
  the current season while they loaded. They now show the club's season year
  from the start, which is the value they settle on anyway.
