# File-size allowances for #4960 (officer queue paging)

Five already-over-budget queue screens grow because each now pages its list
(INV-OPS-019). The shared parts — the page state, the total line, the pager,
the off-page deep-link read, the pinned-record note, and the route page shape —
live once in `use-admin-queue-page.ts`, `admin-pagination.tsx`,
`pinned-queue-record-note.tsx` and `admin-list-page.ts`. What stays in each
screen is its own wiring: which filter resets the page, which URL keys it
writes, and where the pager sits. Two other files that would have crossed
their budget for the first time were cut back under it instead.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 982
reason: the refund appeal list gains its page state, its page in the URL
  and a pager inside its own section, while the credit approvals list on the
  same screen stays unpaged; moving one list out is a screen split of its own.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 866
reason: the screen kept its filter only in memory; paging needs the filter
  and page read from and written to the URL, and that wiring belongs beside
  the filter state it mirrors rather than in a second module.

file: src/app/(admin)/admin/membership/membership-cancellations/page.tsx
lines: 1287
reason: two queues on one screen each page on their own, with separate URL
  keys cleared on a tab change; both loads already live in this file and the
  per-queue wiring has to sit next to them.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1027
reason: the fixed 100-row read becomes a paged read with the shared pager;
  the change is the panel's own load and render wiring.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2765
reason: the public queue gains paging and the pinned deep-linked request
  inside its existing load and list render; splitting this panel is a
  refactor of its own, well beyond this change.

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 806
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `RefundRequestsPage`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/app/(admin)/admin/membership/member-applications/page.tsx#MemberApplicationsPage
lines: 693
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `MemberApplicationsPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/membership/membership-cancellations/page.tsx#MembershipCancellationRequests
lines: 921
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `MembershipCancellationRequests`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/components/admin/booking-requests/booking-approvals-panel.tsx#BookingApprovalsPanel
lines: 556
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `BookingApprovalsPanel`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/components/admin/booking-requests/booking-change-requests-panel.tsx#BookingChangeRequestsPanel
lines: 587
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `BookingChangeRequestsPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/components/admin/booking-requests/policy-exception-requests-panel.tsx#PolicyExceptionRequestsPanel
lines: 835
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `PolicyExceptionRequestsPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/components/admin/booking-requests/public-booking-requests-panel.tsx#PublicBookingRequestsPanel
lines: 2332
reason: the officer queue pager, its page state and its URL wiring; those
  lines sit inside the function `PublicBookingRequestsPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
