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

file: src/lib/admin-member-detail-service.ts
lines: 1728
reason: imports the resolved current-season helper the member detail payload
  now takes its season from.
