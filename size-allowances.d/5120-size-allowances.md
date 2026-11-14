# Size allowances for #5120

file: src/app/(admin)/admin/display/devices/page.tsx
lines: 546
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 923
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 602
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1275
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 753
reason: adds one pointer comment line (the full path of the bulk member dialog,
  whose consequence wording must stay aligned with this route, issue #4973
  section 7) and extends an existing comment at the family-group removal.
  The route's behaviour is unchanged and it was already over its limit, so
  splitting it is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/display/devices/page.tsx#AdminDisplayDevicesPage
lines: 485
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `AdminDisplayDevicesPage`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 862
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `FamilyGroupsTab`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/members/page.tsx#MembersPage
lines: 540
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `MembersPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1128
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `HutFeesSection`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 409
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `SeasonsPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/api/admin/members/bulk-update/route.ts#POST
lines: 671
reason: adds one pointer comment line (the full path of the bulk member dialog,
  whose consequence wording must stay aligned with this route, issue #4973
  section 7) and extends an existing comment at the family-group removal.
  The route's behaviour is unchanged and it was already over its limit, so
  splitting it is a refactor of its own, not part of this fix.
