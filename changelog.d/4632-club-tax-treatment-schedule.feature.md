- **The club's GST/tax treatment is now a dated schedule a Full Admin can
  change from the Xero settings screen (#4632).** `/admin/finance/xero` has a
  new "GST / tax treatment" card showing the treatment in force and any
  future change already scheduled. A Full Admin can schedule a change — GST
  registration, the rate, and the Xero tax code it invoices under — for a
  future date; Xero's own tax-rate list is checked first, so a code Xero
  cannot carry is refused rather than saved on a guess. A booking, membership
  charge or other Xero document keeps the treatment in force when it was made
  for its whole life: nothing already invoiced, credited or posted changes
  when the schedule changes.
