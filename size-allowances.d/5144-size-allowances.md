# Size allowances for #5144

function: src/app/(admin)/admin/finance/xero/_components/setup-panels.tsx#SetupPanels
lines: 415
reason: a once-only latch on the contact-group auto-load; those lines
  sit inside the function `SetupPanels`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.
