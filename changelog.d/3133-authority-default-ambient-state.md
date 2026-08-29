- **A season name can no longer be rendered from a stale guess without the code
  saying so.** `INV-SSOT-003` already forbade a function from quietly filling in
  the club's timezone for a caller that did not state it. The same rule now
  covers values that come from a **cache the running process may never have
  filled in** — the club's financial year-end, its name and branding, its email
  colours, and the deployment's timezone environment variables read through a
  helper. That gap was not theoretical: a background job that mints Xero invoices
  never fills that cache, so a club whose financial year does not end in March
  had the wrong season printed on real invoice lines, and every line of code
  involved looked correct. Two of the three season-label helpers now **require**
  the year-end, so leaving it out fails the build instead of silently printing
  March. Nothing a member or an administrator sees changes.
