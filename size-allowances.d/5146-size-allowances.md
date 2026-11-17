# Size allowances for #5146

function: src/app/(admin)/admin/booking-desk/book/page.tsx#AdminBookPage
lines: 1538
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `AdminBookPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 842
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `RefundRequestsPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 845
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `FamilyGroupsTab`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/members/[id]/_components/member-committee-assignments-card.tsx#MemberCommitteeAssignmentsCard
lines: 571
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `MemberCommitteeAssignmentsCard`,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/age-tier-settings/page.tsx#AgeTierSettingsPage
lines: 434
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `AgeTierSettingsPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 453
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `SeasonsPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/website/mountain-conditions/_components/mountain-conditions-panel.tsx#MountainConditionsPanel
lines: 799
reason: adds focused action-failure alerts and attention hooks to ten admin
  pages; those lines sit inside the function `MountainConditionsPanel`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
