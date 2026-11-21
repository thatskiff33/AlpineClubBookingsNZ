# Size allowances for #5285

file: src/lib/booking-exception-approval.ts
lines: 1251
reason: decides the approval email's payment line from the cash records; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
