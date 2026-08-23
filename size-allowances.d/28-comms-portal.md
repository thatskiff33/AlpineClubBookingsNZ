# File-size allowances for #28

Seven already-over-budget files grow here. Six of the seven gain **rows in a
hand-kept registry**, not new concerns: the message board added a model, an
admin area, a route prefix, a cron job and a module flag, and this repository
deliberately keeps one authoritative list of each. Splitting a registry so that
it can accept one more row is the specific mistake those lists exist to prevent
— a second file holding one of N sibling entries is how the next reader misses
one, and in `member-merge.ts` and `admin-permissions.ts` the guard tests are
built on there being exactly one place to look.

**Nothing here is a new file, a rename into scope, or a file crossing its budget
for the first time.** Every one was over budget on the base ref.

file: src/lib/member-merge.ts
lines: 3768
reason: two relation specs, one generic-resolver row and one snapshot column,
  each landing in the authoritative list its own kind lives in. The whole
  contract of this module is that `MEMBER_MERGE_RELATION_SPECS` is the single
  enumeration a DMMF walk can be checked against; a second file holding two of
  eighty-odd relations would defeat the completeness test that makes the file
  trustworthy. The file is a long-standing split candidate on other grounds and
  is not made materially worse by four entries.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 956
reason: two module-gated tiles in the dashboard grid, in the same shape as the
  five already inline beside them (Induction, Maintenance, Lockers, Promo,
  Bookings) — card, lead line, full-width button. The seam does not exist:
  `SummaryLinkCard` above is a different shape (whole card is the link, no
  button) and the owner asked specifically for a button like Induction's.
  Extracting only these two would leave a reader finding five sibling tiles
  inline and two elsewhere, with no rule saying which to follow next time.
  Roughly a fifth of the growth is the comment explaining why each tile is
  gated on its module rather than shown unconditionally.

file: src/proxy.ts
lines: 1211
reason: one matcher entry, `/api/club-posts/:path*`, and the comment saying why
  it must exist — the first matcher entry excludes every `/api/...` path, so
  without it the commsPortal feature-route rule would be half dead. It sits
  directly beside the calendar and maintenance-report entries added for the
  identical reason; that argument is only legible where the three are together.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1125
reason: `commsPortal` joins the travelling module flags, with the reasoning for
  why it travels when `alpineCentralServer` does not. That judgement is only
  reviewable next to the flag it is being distinguished from, four lines above.

file: src/lib/admin-cron-health.ts
lines: 802
reason: one job definition among ten, in the list `getAdminCronJobDefinitions`
  returns. The contract test asserts every recorded job appears in this exact
  list, so there is one correct place for it.

file: src/components/admin-sidebar.tsx
lines: 1068
reason: one navigation entry in the membership section, plus its icon import.
  This file is the sidebar; a row of it cannot live anywhere else.

file: src/lib/admin-permissions.ts
lines: 769
reason: two route prefixes in the membership area's list, and the comment
  recording that they had been resolving to the `overview` catch-all while
  their handlers enforced `membership`. `ROUTE_AREA_PREFIXES` is the single
  table the drift guard compares the route tree against.
