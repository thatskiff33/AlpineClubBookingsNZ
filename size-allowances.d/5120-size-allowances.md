# Size allowances for #5120

The bulk-update route (`src/app/api/admin/members/bulk-update/route.ts`) was
already past its hard ceiling of 750 lines on `origin/main` (752, #4926), where a
file may only stay the same length or shrink. Its request schema moved out
verbatim to `schema.ts` beside it, so it ends at 739 lines and needs no file
allowance. Its function allowance below stays: `POST` still carries the pointer
comment line and the extended comment.

file: src/app/(admin)/admin/display/devices/page.tsx
lines: 546
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 924
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 606
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1274
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside this file, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(admin)/admin/display/devices/page.tsx#AdminDisplayDevicesPage
lines: 485
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `AdminDisplayDevicesPage`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 861
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `FamilyGroupsTab`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/members/page.tsx#MembersPage
lines: 543
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `MembersPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1135
reason: adds destructive-action confirmation wording and dialogs to admin
  pages; those lines sit inside the function `HutFeesSection`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 455
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
