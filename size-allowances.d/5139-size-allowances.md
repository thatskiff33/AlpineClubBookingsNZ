# Size allowances for #5139

file: src/app/(admin)/admin/booking-desk/waitlist/page.tsx
lines: 1026
reason: the page reads and writes its URL page through the shared parser and
  writer and takes its range sentence from formatAdminListRange. The local
  range arithmetic comes out, but the four-name import of the shared helpers
  adds more lines than that removes (+3 net). Splitting a 1000-line route
  page shell is a refactor of its own, not part of this change.

file: src/app/(admin)/admin/finance/payments/page.tsx
lines: 1502
reason: the page drops its local page parser and range arithmetic for the
  shared helpers, but the four-name import of those helpers adds one line more
  than the removed code (+1 net). Splitting a 1500-line route page shell is a
  refactor of its own, not part of this change.

file: src/app/(admin)/admin/finance/subscriptions/page.tsx
lines: 892
reason: the page drops its local page parser and range arithmetic for the
  shared helpers, but the four-name import of those helpers adds one line more
  than the removed code (+1 net). Splitting an 890-line route page shell is a
  refactor of its own, not part of this change.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 605
reason: the page renders the shared Pagination directly in place of the
  deleted member pagination wrapper and builds its range sentence with
  formatAdminListRange, which adds three lines of props and one net import
  line (+4). Splitting a 600-line route page shell is a refactor of its own,
  not part of this change.

function: src/app/(admin)/admin/membership/members/page.tsx#MembersPage
lines: 542
reason: the shared Pagination and its range sentence are rendered inside
  `MembersPage`, which was already over its limit before this change (+3 net
  in the function). Lifting the component apart is a refactor of its own, not
  part of this change.
