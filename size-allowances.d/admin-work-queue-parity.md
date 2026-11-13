# File-size allowances for the officer work queue registry (#4962)

Each file below is a queue page or panel that now tells the sidebar its
queue changed. The Stuck States cache that would otherwise have grown
`src/lib/stuck-state-dashboard.ts` was split into its own module instead.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 971
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1435
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx
lines: 1498
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 820
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/membership-cancellations/page.tsx
lines: 1232
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1018
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2727
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2377
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.
