# Size allowances for #5130

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 825
reason: a shared-reader import, a named fallback sentence and a
  network-failure branch in four admin save and delete handlers; those lines
  sit inside the function `FamilyGroupsTab`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1127
reason: a shared-reader import, a named fallback sentence and a
  network-failure branch in four admin save and delete handlers; those lines
  sit inside the function `HutFeesSection`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 408
reason: a shared-reader import, a named fallback sentence and a
  network-failure branch in four admin save and delete handlers; those lines
  sit inside the function `SeasonsPage`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(admin)/admin/work-parties/page.tsx#AdminWorkPartiesPage
lines: 463
reason: a shared-reader import, a named fallback sentence and a
  network-failure branch in four admin save and delete handlers; those lines
  sit inside the function `AdminWorkPartiesPage`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.
