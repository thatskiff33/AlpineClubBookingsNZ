- **The finance dashboard's code is split into one module per view, with no
  change to what it shows (#2957).** The single 1,756-line page builder behind
  `/finance` now holds only the page-level loading, selection and view dispatch;
  each dashboard view (bookings, revenue and costs, ratios, pricing sensitivity,
  cash and balance sheet, sync health), the shared view-model shapes and the
  derived chart palette live in their own file under
  `src/lib/finance-dashboard-page/`. Every moved line is the same line, so
  totals, permissions (finance view versus finance manager), warnings, links,
  exports and screen states are unchanged. Finance administrators will notice
  nothing; future finance changes get a smaller, clearer surface to review.
