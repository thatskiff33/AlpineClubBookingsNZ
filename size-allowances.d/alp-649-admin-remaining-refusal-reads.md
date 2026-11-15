# File-size allowances for ALP-649

Each file grows by the lines it takes to throw a refusal through the shared
reader before parsing, and to catch what used to be an unhandled rejection
(#4976). Measured against the merged ALP-578/ALP-581/ALP-589 state this lane
is stacked on.

file: src/app/(admin)/admin/chores/page.tsx
lines: 748
reason: the one added line is the shared refusal reader's import; the save,
  delete and toggle handlers it serves stay beside the lodge-scope guard they
  share, and splitting the page shell is its own refactor.

The work-parties page's growth is folded into its existing entry in
`admin-save-failure-messages.md`, one file one allowance.

## Function allowances for the stacked lanes

This branch carries ALP-578 (#4975), ALP-581 and ALP-589 (#4976) into main.
Those lanes were written before the function-length ratchet (#4927) landed, so
none declared the growth they put inside page components that were already
over 300 lines. Each entry names the lane whose lines it holds. Every one is a
handler's error read or a focused action alert sitting beside the state it
fills; splitting these page components is its own refactor per page.

function: src/app/(admin)/admin/booking-desk/book/page.tsx#AdminBookPage
lines: 1536
reason: ALP-578's focused action alert and Xero-reconnect link replace the old
  error box, and ALP-649's quote read throws its refusal before parsing.

function: src/app/(admin)/admin/booking-desk/waitlist/page.tsx#AdminWaitlistPage
lines: 780
reason: ALP-589's force-confirm reads a refusal through the shared reader and
  keeps its unverified-outcome copy beside the capacity write it guards.

function: src/app/(admin)/admin/finance/refund-requests/page.tsx#RefundRequestsPage
lines: 824
reason: ALP-578 splits the queue's passive load error from its focused review
  failures, each with its Dismiss control, inside the queue's own state.

function: src/app/(admin)/admin/finance/reports/page.tsx#ReportsPage
lines: 585
reason: ALP-589's report load reads a refusal through the shared reader and
  drops a stale reply beside the request sequence it checks.

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 401
reason: ALP-589's billing writes parse only a success and read a refusal
  through the shared reader inside each handler.

function: src/app/(admin)/admin/finance/subscriptions/page.tsx#SubscriptionsPage
lines: 662
reason: ALP-589's Xero sync and manual-payment handlers read a refusal through
  the shared reader beside the state they update.

function: src/app/(admin)/admin/hut-leaders/page.tsx#HutLeadersPage
lines: 1391
reason: ALP-589's leader saves and PIN resets read a refusal, with its
  capacity and amendment details, inside each handler.

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 845
reason: ALP-581 gives the create a catch and the shared reader; ALP-578 turns
  the revoke and save errors into focused action alerts.

function: src/app/(admin)/admin/membership/members/[id]/_components/member-committee-assignments-card.tsx#MemberCommitteeAssignmentsCard
lines: 571
reason: ALP-578 separates the passive role load error from the focused save
  and removal failure, and positions the outcome when the form closes.

function: src/app/(admin)/admin/rules/age-tier-settings/page.tsx#AgeTierSettingsPage
lines: 430
reason: ALP-578's focused save alert and ALP-649's refusal read, keeping the
  403 view-only branch; ALP-578 already moved the row helpers out.

function: src/app/(admin)/admin/rules/fees/_components/finance-fees-sections.tsx#FinanceFeesSections
lines: 378
reason: ALP-589's fee writes check ok before parsing a refusal, one line more.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1133
reason: ALP-581's save names its fallback once so a refusal and a network
  failure say the same sentence, one line more.

function: src/app/(admin)/admin/rules/promo-codes/promo-codes-page-client.tsx#PromoCodesPageClient
lines: 1617
reason: ALP-589's save and delete name their fallback once and read a refusal
  through the shared reader inside each handler.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 439
reason: ALP-581's delete and toggle read a refusal through the shared reader
  and ALP-578 makes their failure a focused, re-announced alert.
