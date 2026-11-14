file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 844
reason: Keep the shared action-error state and its permanently mounted feedback beside the existing application actions; splitting this page is outside the presentation fix.

function: src/app/(admin)/admin/membership/member-applications/page.tsx#MemberApplicationsPage
lines: 685
reason: shared action-error and success feedback regions with focus and
  screen-reader announcement on the page; those lines sit inside the function
  `MemberApplicationsPage`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/members/[id]/merge/page.tsx#MemberMergePage
lines: 429
reason: shared action-error and success feedback regions with focus and
  screen-reader announcement on the page; those lines sit inside the function
  `MemberMergePage`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/setup/setup-page-client.tsx#SetupPageClient
lines: 440
reason: shared action-error and success feedback regions with focus and
  screen-reader announcement on the page; those lines sit inside the function
  `SetupPageClient`, which was already over its limit before this change, and
  lifting it apart is a refactor of its own, not part of this fix.
