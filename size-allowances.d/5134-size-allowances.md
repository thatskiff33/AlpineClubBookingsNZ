# Size allowances for #5134

file: src/app/(admin)/admin/finance/xero/member-grouping/page.tsx
lines: 705
reason: Xero action failures take focus; those lines sit inside this file,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx#InboundEventsPanel
lines: 339
reason: Xero action failures take focus; those lines sit inside the function
  `InboundEventsPanel`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/xero/_components/missing-contacts-panel.tsx#MissingContactsPanel
lines: 377
reason: Xero action failures take focus; those lines sit inside the function
  `MissingContactsPanel`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx#OperationsPanel
lines: 475
reason: Xero action failures take focus; those lines sit inside the function
  `OperationsPanel`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/xero/_components/setup-panels.tsx#SetupPanels
lines: 392
reason: Xero action failures take focus; those lines sit inside the function
  `SetupPanels`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/xero/member-grouping/page.tsx#XeroMemberGroupingPage
lines: 580
reason: Xero action failures take focus; those lines sit inside the function
  `XeroMemberGroupingPage`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.
