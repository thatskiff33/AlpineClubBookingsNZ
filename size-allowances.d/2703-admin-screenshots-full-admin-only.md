# File-size allowances for #2703

Both files are admin-origin screenshot boundary work (`INV-PRIV-021`). The third
file the gate flagged, `src/app/(admin)/admin/issue-reports/page.tsx`, is NOT
declared here and takes no allowance: it would have crossed its budget for the
first time, so the screenshot badge and panel were lifted into
`src/components/admin/issue-report-screenshot.tsx` instead and the page came back
under its ceiling.

file: src/app/api/admin/issue-reports/[id]/route.ts
lines: 350
reason: the growth is the gate itself and the comments that hold it. Three
  things had to land in this file and none of them has a seam that splits
  cleanly. The decision is already extracted — it lives in
  `src/lib/issue-report-screenshot-access.ts`, which is the one home for the
  rule, so what is left here is a required `access` argument on `mapReport`
  plus the two call sites that must produce one, and a second audit write on
  the refusal. Splitting the detail read from the action handler would put the
  two payload builders that must agree about the boundary in different files,
  which is precisely the drift that let the PATCH reply serve pixels the GET
  beside it refused — which is why both now build their payload through one
  `screenshotAccessFor` in this file. The remaining lines are comments
  explaining why a payload path is gated, and they are worth more here than the
  length costs.

file: src/app/api/issue-reports/route.ts
lines: 276
reason: sixteen lines, and eleven of them are one comment. The code is the
  member query selecting joined access roles, one call to the shared derivation
  helper, and the field on the create. The comment is load-bearing: it is the
  only statement at the write site that the classification comes from the
  reporter's server-side standing and never from the `pageUrl` parsed four lines
  above it, which is the single mistake this whole issue exists to prevent. A
  reader who does not see that sentence next to both values has every reason to
  "simplify" the derivation into the URL that is already in scope.
