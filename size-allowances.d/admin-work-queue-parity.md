# File-size allowances for the officer work queue registry (#4962)

Each file below is a queue page or panel that now tells the sidebar its
queue changed. The Stuck States cache that would otherwise have grown
`src/lib/stuck-state-dashboard.ts` was split into its own module instead.
The `function:` entries cover the same calls inside components already over
the function-length limit.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 1016
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1492
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx
lines: 1467
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 895
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/app/(admin)/admin/membership/membership-cancellations/page.tsx
lines: 1289
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1029
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Splitting this page is its own
  piece of work.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2081
reason: the only growth is the import of `notifyAdminQueueChanged` and the
  call at each decision that changes this queue, so the Needs Attention badge
  refetches after the officer acts (#4962). The call has to sit at the
  mutation site, after the request succeeds; moving it into a helper would
  add a file and still need a call here. Main's #4998 grew this file to 2079
  lines first; splitting it is its own piece of work.

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 844
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/hut-leaders/page.tsx#HutLeadersPage
lines: 1395
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx#DeletionRequestsClient
lines: 966
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/membership/deletion-requests/deletion-requests-client.tsx#AdminInitiatedDeletionSection
lines: 357
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/membership/member-applications/page.tsx#MemberApplicationsPage
lines: 724
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/membership/membership-cancellations/page.tsx#MembershipCancellationRequests
lines: 928
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/app/(admin)/admin/system/issue-reports/page.tsx#AdminIssueReportsPage
lines: 369
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/components/admin/booking-requests/booking-approvals-panel.tsx#BookingApprovalsPanel
lines: 557
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/components/admin/booking-requests/policy-exception-requests-panel.tsx#PolicyExceptionRequestsPanel
lines: 836
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/components/admin/booking-requests/public-booking-requests-panel.tsx#PublicBookingRequestsPanel
lines: 2323
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/components/admin/family-groups/request-review-section.tsx#FamilyGroupRequestReviewSection
lines: 460
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.

function: src/components/admin/manual-refund-task-queue.tsx#ManualRefundTaskQueue
lines: 1329
reason: the only growth is the `notifyAdminQueueChanged` call at each
  decision inside this component that changes its queue, so the Needs
  Attention badge refetches after the officer acts (#4962). The call has to
  sit in the handler that made the request, after it succeeds. Splitting
  this component is its own piece of work.
