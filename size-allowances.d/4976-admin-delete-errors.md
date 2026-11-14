# File-size allowances for #4976 (admin delete errors)

Two route pages gain the failure branch their delete or remove handler never
had. Each branch reads the refusal through the shared
`src/lib/api-error-message.ts` helper and shows it in the page's own alert, so
it has to sit in the handler it completes.

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 897
reason: a list-level error state, its alert above the groups table, and the
  delete handler's failure and network branches. The handler and the alert it
  feeds belong beside the list they describe; moving them out would split one
  handler from the state it sets.

file: src/app/(admin)/admin/membership/committee/page.tsx
lines: 720
reason: the remove handler's non-403 failure branch and its network catch,
  plus one import name. A failure branch cannot live anywhere but in the
  handler it completes.

function: src/app/(admin)/admin/membership/committee/page.tsx#CommitteePage
lines: 609
reason: the remove handler's non-403 failure branch and its network catch sit
  inside `CommitteePage`, which was already over its function limit before
  this change (601 lines on main). The handler is defined in the component
  that owns the error state it sets; lifting the component apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 836
reason: the list-level error state, its alert above the groups table and the
  delete handler's failure and network branches sit inside `FamilyGroupsTab`,
  which was already over its function limit before this change (823 lines on
  main). The handler, its state and the alert are one unit with the list they
  describe; lifting the component apart is a refactor of its own, not part of
  this fix.
