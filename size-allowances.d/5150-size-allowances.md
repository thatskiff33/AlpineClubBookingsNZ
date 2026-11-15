# Size allowances for #5150

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 819
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
lines: 540
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
