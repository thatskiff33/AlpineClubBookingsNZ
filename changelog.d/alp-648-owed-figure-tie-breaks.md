- **A card refund still owed now reads the same every time when two records
  share a timestamp (#4284).** When two card refunds were raised, or two
  refunds recorded, in the same instant, "Refunds owed", Net Collected and the
  Xero "paid twice" alert could match a refund to a different one of them from
  one page load to the next - and on one read call a refund still being sent
  as already paid. They are now always matched in one fixed order.
