# Size allowances for #5134

file: src/app/(admin)/admin/finance/xero/member-grouping/page.tsx
lines: 706
reason: Xero action failures take focus; those lines sit inside this file,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.

function: src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx#InboundEventsPanel
lines: 354
reason: Xero action failures take focus; those lines sit inside the function
  `InboundEventsPanel`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.

function: src/app/(admin)/admin/finance/xero/_components/missing-contacts-panel.tsx#MissingContactsPanel
lines: 381
reason: Xero action failures take focus; those lines sit inside the function
  `MissingContactsPanel`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.

function: src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx#OperationsPanel
lines: 486
reason: Xero action failures take focus; those lines sit inside the function
  `OperationsPanel`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.

function: src/app/(admin)/admin/finance/xero/_components/setup-panels.tsx#SetupPanels
lines: 404
reason: Xero action failures take focus; those lines sit inside the function
  `SetupPanels`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.

function: src/app/(admin)/admin/finance/xero/member-grouping/page.tsx#XeroMemberGroupingPage
lines: 581
reason: Xero action failures take focus; those lines sit inside the function
  `XeroMemberGroupingPage`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
  The component holds its own state and handlers next to its render, so a
  split would thread many setters through props for a change of a few lines.
