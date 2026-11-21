# Size allowances for #5150

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 848
reason: adds the moving-in member import columns and opening-credit batches;
  those lines sit inside the function `RefundRequestsPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/membership/members/_components/member-import-dialog.tsx#MemberImportDialog
lines: 575
reason: adds the moving-in member import columns and opening-credit batches;
  those lines sit inside the function `MemberImportDialog`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/membership/members/page.tsx#MembersPage
lines: 544
reason: adds the moving-in member import columns and opening-credit batches;
  those lines sit inside the function `MembersPage`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/app/api/admin/members/import/route.ts#POST
lines: 635
reason: adds the moving-in member import columns and opening-credit batches;
  those lines sit inside the function `POST`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

file: src/lib/member-credit.ts
lines: 1214
reason: the opening-credit post and reversal rows move here from
  `opening-credit-batch.ts` (#4988, issue watchpoint 7), so this module stays
  the one place that creates `MemberCredit` rows and the reversal reuses its
  negative-adjustment balance rule rather than a copy.
