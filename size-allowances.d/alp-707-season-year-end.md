# File-size allowances for #5259

Each of these already-oversized files now takes the club's financial year-end
where it picks or names a season, instead of reading a process cache no browser
or cold server ever seeds. The growth is the one line that obtains it beside the
zone the file already obtains; moving it elsewhere would separate a season from
the year-end that defines it, which is the defect being fixed.

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1361
reason: imports and calls `useClubSeason()` so the membership preview line
  names the season by the club's year-end.

function: src/app/(admin)/admin/membership/members/[id]/page.tsx#MemberDetailPage
lines: 1249
reason: the one `useClubSeason()` call, beside the page's `useClubFormat()`.

file: src/app/(authenticated)/profile/page.tsx
lines: 708
reason: binds the resolved year-end once (`bindClubSeason`) for the current
  season and both season names on the page.

function: src/app/(authenticated)/profile/page.tsx#ProfilePage
lines: 581
reason: the one binding line, beside the page's `clubTime()` read.

file: src/app/api/admin/membership-types/[id]/route.ts
lines: 455
reason: the forced-edit check runs again inside the write transaction, so its
  current season (zone and year-end, which may read Xero) is resolved once
  before that transaction rather than inside it.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 746
reason: a bulk set-role judges age tiers in the season the club's resolved
  year-end names (#5259 review), resolved once before the transaction.

function: src/app/api/admin/members/bulk-update/route.ts#POST
lines: 675
reason: the same one resolution, beside the zone read it already makes.

file: src/lib/admin-members-service.ts
lines: 1665
reason: creating a member seeds its subscription row in the season the club's
  resolved year-end names (#5259 review), resolved before the transaction.

function: src/lib/admin-members-service.ts#createAdminMember
lines: 510
reason: the same one resolution, beside the zone read it already makes.

file: src/components/admin/subscription-lockout-settings-panel.tsx
lines: 797
reason: three calls into `useYearEndRefresh`, which redraws the admin layout
  when a save moves the year-end; the logic itself lives in that hook.

function: src/components/admin/subscription-lockout-settings-panel.tsx#SubscriptionLockoutSettingsPanel
lines: 685
reason: the same three calls.
