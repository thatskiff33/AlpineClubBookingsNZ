# File-size allowances for the Communication Portal epic (upstream merge)

Seven already-over-budget files grow relative to thatskiff33/main. Six of the
seven gain **rows in a hand-kept registry**, not new concerns: the message
board added a model, an admin area, route prefixes, cron jobs and a module
flag, and this repository deliberately keeps one authoritative list of each —
in `member-merge.ts` and `admin-permissions.ts` the guard tests are built on
there being exactly one place to look. These entries were declared once before
on the fork's own PRs (#28/#29 there) and spent when those merged; against
this base the growth is new again, so it is declared again.

Nothing here is a new file, a rename into scope, or a file crossing its budget
for the first time. The three genuinely new modules in this change —
`club-post-html.ts`, `club-post-editor.tsx`, `club-post-mirror.ts` — were
written to their own ceilings, and the member composer was deliberately NOT
folded into the 2,500-line admin `page-content-panel.tsx`.

file: src/lib/member-merge.ts
lines: 3814
reason: two relation specs, one generic-resolver row and two snapshot-column
  entries, each landing in the authoritative list its own kind lives in
  (upstream's own additions to this file merge alongside). The contract of
  this module is that `MEMBER_MERGE_RELATION_SPECS` and the snapshot list are
  the single enumerations the DMMF completeness test checks against; a second
  file holding two of eighty-odd relations defeats the test that makes the
  file trustworthy.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 984
reason: two module-gated tiles in the dashboard grid, the same shape as the
  five already inline beside them (card, lead line, full-width button), plus
  the message-board feed card's move below the booking lists and its 7-day
  count. The one extracted tile component in this file (SummaryLinkCard) is a
  different shape — whole card is the link, no button — which is not what the
  owner asked for; extracting only these two would leave five sibling tiles
  inline and two elsewhere with no rule saying which to follow.

file: src/proxy.ts
lines: 1211
reason: one matcher entry, `/api/club-posts/:path*`, and the comment saying
  why it must exist — the first matcher entry excludes every `/api/...` path,
  so without it the commsPortal feature-route rule would be half dead. It sits
  directly beside the calendar and maintenance-report entries added for the
  identical reason; that argument is only legible where the three are together.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1125
reason: `commsPortal` joins the travelling module flags, with the reasoning
  for why it travels when `alpineCentralServer` does not. That judgement is
  only reviewable next to the flag it is being distinguished from, a few lines
  above.

file: src/lib/admin-cron-health.ts
lines: 874
reason: three job definitions in the list `getAdminCronJobDefinitions`
  returns — retention, share retry and mirror sync. The cron-recording
  contract test asserts every job that records a run appears in this exact
  list. The mirror entry matters doubly: the push path failing is DESIGNED to
  be silent because polling covers it, so its health row going stale is the
  one signal an operator gets that the covering poll has stopped.

file: src/components/admin-sidebar.tsx
lines: 1176
reason: one navigation entry in the membership section plus its icon import
  (upstream's own sidebar additions merge alongside). This file is the
  sidebar; a row of it cannot live anywhere else.

file: src/lib/admin-permissions.ts
lines: 795
reason: two route prefixes in the membership area's list, and the comment
  recording that they had been resolving to the `overview` catch-all while
  their handlers enforced `membership`. `ROUTE_AREA_PREFIXES` is the single
  table the drift guard compares the route tree against.
