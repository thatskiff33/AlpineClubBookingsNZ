# Size allowances for #5147

function: src/lib/xero-supplementary-invoices.ts#createXeroSupplementaryInvoice
lines: 577
reason: records supplementary and primary-update invoice export manifests;
  those lines sit inside the function `createXeroSupplementaryInvoice`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

file: src/lib/xero-booking-invoices.ts
lines: 1553
reason: records supplementary and update invoice manifests; those lines sit
  inside this file, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.
