# File-size allowances for #5092 (admin delete errors, issue #4976)

Four admin pages gain the failure branch their delete, remove or toggle
handler never had. Each branch reads the refusal through the shared
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

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1278
reason: the season delete and toggle handlers each gain a named fallback
  sentence, an early return on a refusal, and a catch that shows that sentence
  when the request never arrives (1271 lines on main). The catch has to sit in
  the handler it completes.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1132
reason: the season delete and toggle handlers sit inside `HutFeesSection`, which
  was already over its function limit before this change (1126 lines on
  main). They share its lodge-scope guard and its `raiseError` path, so they
  stay beside it; lifting the component apart is a refactor of its own, not
  part of this fix.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 414
reason: the season delete and toggle handlers each gain a named fallback
  sentence, an early return on a refusal, and a catch that shows that sentence
  when the request never arrives. They sit inside `SeasonsPage`, which was
  already over its function limit before this change (407 lines on main), and
  share its lodge-scope guard and error state; lifting the component apart is
  a refactor of its own, not part of this fix.
