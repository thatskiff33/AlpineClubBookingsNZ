/**
 * The Finance area's money actions (ALP-721, `INV-MCP-006`): payments,
 * account credits, refunds waiting on a person, subscriptions, billing and
 * the finance reports. Each runs on a route the `finance` admin area gates,
 * with the officer's real permissions, and is offered only to an officer
 * holding that area at the route's level (`mcpActionAdminRequirement`).
 * Refunds and anything else that asks for a fresh sign-in stay on the website
 * (`exclusions.ts`). Every amount is integer cents.
 */
import { z } from "zod";

import {
  adminCreditAdjustmentRequestSchema,
  adminCreditAdjustmentReviewParamsSchema,
  adminCreditAdjustmentReviewSchema,
  adminCreditApprovalsQuerySchema,
} from "@/lib/admin-credit-adjustment-schemas";
import { ADMIN_CREDIT_GRANT_ACCOUNTS } from "@/lib/admin-credit-grant-account";
import { adminPaymentsFilterFields } from "@/lib/admin-payments-query";
import { adminRefundRequestsQuerySchema } from "@/lib/admin-refund-requests-query";
import { adminReportQuerySchema } from "@/lib/admin-reports-query";
import { adminSubscriptionsQuerySchema } from "@/lib/admin-subscriptions-query";
import { bankRefundVoidAnsweredBodySchema } from "@/lib/bank-refund-void-answered-body";
import {
  DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS,
  financeBackfillMonthlyFactsBodyFields,
} from "@/lib/finance-backfill-request";
import {
  financeBookingMetricsQueryFields,
  MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS,
} from "@/lib/finance-booking-metrics-query";
import {
  ADMIN_PAYMENTS_CONNECTION_SHAPE,
  BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REVIEWED_CONNECTION_SHAPE,
  CREDIT_APPROVALS_CONNECTION_SHAPE,
  MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE,
  MANUAL_REFUND_TASKS_CONNECTION_SHAPE,
  MEMBER_CREDITS_CONNECTION_SHAPE,
  OPENING_CREDIT_BATCHES_CONNECTION_SHAPE,
  PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE,
  REFUND_REQUESTS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-payments";
import {
  ADMIN_REPORTS_CONNECTION_SHAPE,
  FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE,
  FINANCE_BOOKING_METRICS_CONNECTION_SHAPE,
  FINANCE_SYNC_RUN_CONNECTION_SHAPE,
  FINANCE_SYNC_STATUS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-reports";
import {
  ADMIN_SUBSCRIPTIONS_CONNECTION_SHAPE,
  MANUAL_SUBSCRIPTION_PAYMENT_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE,
  SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-subscriptions";
import {
  manualBookingPaymentBodySchema,
  manualSubscriptionPaymentBodySchema,
} from "@/lib/manual-payment-request-schemas";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { recordIdParamsSchema } from "@/lib/route-id-params";
import { CLOSE_ALREADY_PAID_REASON_MAX } from "@/lib/subscription-charge-already-paid";
import {
  closeAlreadyPaidFields,
  confirmAnnualBatchFields,
  FAMILY_INVOICED_NOTE_MAX,
  markFamilyInvoicedFields,
  refreshPreviewFields,
  retryChargeFields,
  subscriptionBillingMutationSchema,
  subscriptionBillingQuerySchema,
  unmarkFamilyInvoicedFields,
} from "@/lib/subscription-billing-request-schemas";

import type { McpAction } from "../catalogue";

/** A fixed `action` must be one the route's schema accepts. */
type BillingAction = z.input<typeof subscriptionBillingMutationSchema>["action"];

export const FINANCE_MONEY_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_payments",
    title: "List payments",
    summary:
      "One page of the club's booking payments, newest activity first unless `sortBy` says otherwise, with totals over every payment the filters match. Dates are `YYYY-MM-DD`; `from`/`to` bound the latest activity, `checkInFrom`/`checkInTo` the stay. `search` matches a member, booking or reference. Amounts are integer cents. A row's `refundedAmountCents` includes any account credit a cancellation issued; `cancellationSettlement` splits it into `refundToOriginalMethodCents` (back to the card or bank) and `accountCreditCents`; its `restoredAppliedCreditCents` is credit the booking had used, given back on cancellation, and is not part of `refundedAmountCents`. `disputes` lists any card dispute.",
    method: "GET",
    path: "/api/admin/payments",
    query: z.object(adminPaymentsFilterFields),
    kind: "read",
    returns: ADMIN_PAYMENTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_credit_adjustment",
    title: "Request a credit adjustment",
    summary:
      `Asks for a manual change to one member's account credit, in integer cents: positive adds credit and must name \`grantAccount\` (${ADMIN_CREDIT_GRANT_ACCOUNTS.map((account) => `\`${account}\``).join(" or ")}), negative deducts and names none. Nothing changes until a different officer approves it, and the requester can neither withdraw, approve nor reject it, so it cannot be undone from the app. \`idempotencyKey\` is a new UUID for each request; sending the same one again does not make a second request.`,
    method: "POST",
    path: "/api/admin/members/[id]/credits",
    params: recordIdParamsSchema,
    body: adminCreditAdjustmentRequestSchema,
    kind: "destructive",
    returns: CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_credit_adjustment_requests",
    title: "List credit adjustment requests",
    summary:
      "The manual account credit adjustments officers have asked for, newest first, with who asked and who decided. `status` is `PENDING` (the default: waiting for a second officer), `APPROVED`, `REJECTED` or `ALL`. Amounts are integer cents: positive adds credit, negative deducts. Each request's `id` and `memberId` are what `review_credit_adjustment` needs.",
    method: "GET",
    path: "/api/admin/credit-approvals",
    query: adminCreditApprovalsQuerySchema,
    kind: "read",
    returns: CREDIT_APPROVALS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_credits",
    title: "Get a member's account credit",
    summary:
      "One member's account credit: the balance they can spend, every credit and deduction on their ledger with the booking it came from or went to, and their adjustment requests still waiting for approval. `id` is the member. Amounts are integer cents.",
    method: "GET",
    path: "/api/admin/members/[id]/credits",
    params: recordIdParamsSchema,
    kind: "read",
    returns: MEMBER_CREDITS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "review_credit_adjustment",
    title: "Approve or reject a credit adjustment",
    summary:
      "Decides a pending manual credit adjustment: `decision` is `APPROVE` or `REJECT`. `id` is the member and `requestId` the request (from `list_credit_adjustment_requests`). Approving applies the amount to the member's account credit straight away and cannot be undone from the app; a correction is a new request. The officer who asked for an adjustment can neither approve nor reject it: a different officer must. Answers with the member's balance afterwards, in integer cents.",
    method: "PATCH",
    path: "/api/admin/members/[id]/credits/[requestId]",
    params: adminCreditAdjustmentReviewParamsSchema,
    body: adminCreditAdjustmentReviewSchema,
    kind: "destructive",
    returns: CREDIT_ADJUSTMENT_REVIEWED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_opening_credit_batches",
    title: "List opening-credit batches",
    summary:
      "The opening-credit batches posted so far (balances carried in from a previous system), newest first: each batch's total in integer cents, how many members it credited, who posted it and when, and whether and why it was reversed. Posting and reversing a batch are done on the website.",
    method: "GET",
    path: "/api/admin/opening-credits",
    kind: "read",
    returns: OPENING_CREDIT_BATCHES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "generate_payment_invoice",
    title: "Raise a missing Xero invoice for a payment",
    summary:
      "Raises the Xero invoice for one succeeded booking payment that has none. `id` is the payment (from `list_payments`). Answers `generated` with the invoice number, or `queued` when the Xero outbox will raise it shortly (or once Xero is reconnected). An invoice raised in Xero cannot be withdrawn from the app. Refused if the payment already has an invoice or did not succeed.",
    method: "POST",
    path: "/api/admin/payments/[id]/generate-invoice",
    params: recordIdParamsSchema,
    kind: "destructive",
    returns: PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "answer_bank_refund_void",
    title: "Answer a voided bank refund note",
    summary:
      `Records that an officer has dealt with a bank-transfer refund whose Xero credit note was voided and that the nightly check could not match to one refund. \`id\` is the voided note's link from the stuck-states list. \`note\` (required, up to ${MANUAL_PAYMENT_NOTE_MAX} characters) says what was done; \`confirmed\` must be \`true\`, sent only after the officer confirms. It moves no money and changes nothing in Xero, but the item leaves the list for good.`,
    method: "POST",
    path: "/api/admin/payments/bank-refund-voids/[id]/answered",
    params: recordIdParamsSchema,
    body: bankRefundVoidAnsweredBodySchema,
    kind: "destructive",
    returns: BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_manual_refund_tasks",
    title: "List money owed back by hand",
    summary:
      "The open tasks for money the club owes back by hand (oldest first), what kind of hand-back each is and why it cannot simply be marked paid or dismissed; the late card captures Stripe refunded itself in the last 30 days; and the tasks dismissed lately. `autoRefundedUnavailable` or `dismissedUnavailable` true means that list could not be read, not that it is empty. Amounts are integer cents. Settling, dismissing and reopening a task are done on the website.",
    method: "GET",
    path: "/api/admin/payments/manual-refund-tasks",
    kind: "read",
    returns: MANUAL_REFUND_TASKS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_refund_requests",
    title: "List refund requests",
    summary:
      "One page of members' refund requests (appeals), with each booking's payment, the most an approval can give back (`appealCeilingCents`) and, for an approved request, what has still to go back by card or bank transfer. `status` is `PENDING` (the default, oldest first), `APPROVED`, `REJECTED` or `ALL`. Amounts are integer cents. Approving or declining a request is done on the website.",
    method: "GET",
    path: "/api/admin/refund-requests",
    query: adminRefundRequestsQuerySchema,
    kind: "read",
    returns: REFUND_REQUESTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_finance_report",
    title: "Get the finance report",
    summary:
      "The admin report for a window of stay nights: bookings by status, booked revenue (stay nights in the window), net cash collected for those bookings, refunds and credits owed today across the club, extra payments still owing, guests, occupancy by night, revenue by day, week or month, booking trends by week, and member subscription counts for the current season. `from` and `to` are inclusive days, `YYYY-MM-DD`. `deleted` is `hide` (the default), `include` or `only` deleted bookings; `lodgeId` limits it to one lodge, otherwise every active lodge. Amounts are integer cents.",
    method: "GET",
    path: "/api/admin/reports",
    query: adminReportQuerySchema,
    kind: "read",
    returns: ADMIN_REPORTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_subscriptions",
    title: "List member subscriptions",
    summary:
      "One page of the season's member subscriptions with how many are paid, unpaid, overdue, not invoiced and not required. `seasonYear` is the season's starting year (the current season if omitted); `status` is `PAID`, `UNPAID`, `OVERDUE`, `NOT_INVOICED`, `NOT_REQUIRED` or `all`; `ageTier` and `xeroContactGroup` (a group name) narrow it; `sortBy` and `sortDir` order it. Each row's `id` is what `record_subscription_manual_payment` needs.",
    method: "GET",
    path: "/api/admin/subscriptions",
    query: adminSubscriptionsQuerySchema,
    kind: "read",
    returns: ADMIN_SUBSCRIPTIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "record_subscription_manual_payment",
    title: "Record a subscription paid by hand",
    summary:
      `Marks one member subscription paid outside Xero (\`direction\` \`paid\`), or reverses an earlier manual mark (\`direction\` \`unpaid\`). \`id\` is the subscription (from \`list_subscriptions\`). Marking paid must say \`notifyMember\` (true emails the member a receipt); a reversal emails nobody and must not send it. \`note\` (up to ${MANUAL_PAYMENT_NOTE_MAX} characters) says how it was paid; \`confirmed\` must be \`true\`, sent only after the officer confirms. It never raises or voids a Xero invoice. It changes the member's money record straight away; a mistake is put right by reversing it.`,
    method: "POST",
    path: "/api/admin/subscriptions/[id]/manual-payment",
    params: recordIdParamsSchema,
    body: manualSubscriptionPaymentBodySchema,
    kind: "destructive",
    returns: MANUAL_SUBSCRIPTION_PAYMENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "record_booking_manual_payment",
    title: "Record a booking paid in cash or by bank transfer",
    summary:
      `Records one booking's payment as settled in cash or by a bank transfer that never reached Xero (\`direction\` \`paid\`), or reverses an earlier manual settlement (\`direction\` \`unpaid\`; the booking stays booked, unpaid again). \`id\` is the booking. Marking paid must send \`notifyMember\` (true emails the member a booking confirmation) and \`expectedAmountCents\`, the amount owing the officer read off the booking on the website, in integer cents (no AI app action reports it yet: never send \`list_payments\`' \`amountCents\`, which leaves out applied credit and change fees): the payment is refused if the amount has changed since. If the booking also has an extra payment owing, send \`additionalCoverage\` with \`covered\` (does this money cover the extra too?) and \`expectedAdditionalAmountCents\`, the extra shown. A reversal sends none of these. \`note\` (up to ${MANUAL_PAYMENT_NOTE_MAX} characters) says how it was paid; \`confirmed\` must be \`true\`, sent only after the officer confirms. It never raises or voids a Xero invoice.`,
    method: "POST",
    path: "/api/admin/bookings/[id]/mark-paid",
    params: recordIdParamsSchema,
    body: manualBookingPaymentBodySchema,
    kind: "destructive",
    returns: MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_subscription_billing",
    title: "Preview subscription billing",
    summary:
      "The season's subscription billing preview: what confirming the annual batch would invoice, to whom and for how much (with each fee's lines, proration and the members it covers), who is exempt or already invoiced, the problems that stop a member being billed, the charges already raised and their Xero invoice state, and the due-days and family billing settings. `seasonYear` is the season's starting year and `decisionDate` (`YYYY-MM-DD`, default today) the day proration is worked out from. Amounts are integer cents. Reading it changes nothing; `preview.confirmationToken` is what `confirm_subscription_billing_batch` needs.",
    method: "GET",
    path: "/api/admin/subscription-billing",
    query: subscriptionBillingQuerySchema,
    kind: "read",
    returns: SUBSCRIPTION_BILLING_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "refresh_subscription_billing",
    title: "Refresh the subscription billing preview",
    summary:
      "Rebuilds the season's billing preview and closes the recorded billing problems the fresh preview no longer finds, then answers with the refreshed panel (as `get_subscription_billing`) and how many problems closed. `seasonYear` is the season's starting year and `decisionDate` a day, `YYYY-MM-DD`. Raises no invoice; repeating it is harmless.",
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(refreshPreviewFields),
    fixedBody: { action: "REFRESH_PREVIEW" satisfies BillingAction },
    kind: "write",
    returns: SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "confirm_subscription_billing_batch",
    title: "Confirm the annual subscription invoices",
    summary:
      "Raises the season's subscription charges exactly as previewed and queues their Xero invoices to be created and emailed to members. Send the `seasonYear` and `decisionDate` (`YYYY-MM-DD`) the preview was built with and its `confirmationToken` from `get_subscription_billing`; it is refused if anything changed since, so preview again. `confirmed` must be `true`, sent only after the officer has reviewed the preview and confirms. Charges cannot be withdrawn from the app once raised, and invoices reach members. Refused while Xero invoicing is switched off.",
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(confirmAnnualBatchFields),
    fixedBody: { action: "CONFIRM_ANNUAL_BATCH" satisfies BillingAction },
    kind: "destructive",
    returns: SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "retry_subscription_charge",
    title: "Retry a subscription charge's invoice",
    summary:
      "Queues the Xero invoice work again for one subscription charge whose invoice failed or was never raised. `chargeId` is the charge (from `get_subscription_billing`). A charge whose invoice was never raised gets one, which Xero may email to the member and which cannot be withdrawn from the app. Answers with the queued operation, or says no work was needed; repeating it is harmless. Refused while Xero invoicing is switched off.",
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(retryChargeFields),
    fixedBody: { action: "RETRY_CHARGE" satisfies BillingAction },
    kind: "destructive",
    returns: SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "close_paid_subscription_charge",
    title: "Close a subscription charge already paid",
    summary:
      `Closes one subscription charge held in conflict because every subscription it covers is already paid, so no invoice is raised for it. \`chargeId\` is the charge (from \`get_subscription_billing\`); \`reason\` (required, up to ${CLOSE_ALREADY_PAID_REASON_MAX} characters) is recorded with it. A closed charge cannot be reopened from the app; closing one already closed changes nothing.`,
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(closeAlreadyPaidFields),
    fixedBody: { action: "CLOSE_ALREADY_PAID" satisfies BillingAction },
    kind: "destructive",
    returns: SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "mark_family_invoiced",
    title: "Mark a family as already invoiced",
    summary:
      `Records that one family group has already been invoiced for the season some other way, so the annual batch raises no family charge for it. \`seasonYear\` is the season's starting year, \`familyGroupId\` the family and \`note\` (optional, up to ${FAMILY_INVOICED_NOTE_MAX} characters) why. Undone with \`unmark_family_invoiced\`; marking a family already marked changes nothing.`,
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(markFamilyInvoicedFields),
    fixedBody: { action: "MARK_FAMILY_INVOICED" satisfies BillingAction },
    kind: "write",
    returns: SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "unmark_family_invoiced",
    title: "Remove a family's already-invoiced mark",
    summary:
      "Removes the already-invoiced mark from one family group for the season, so the annual batch bills the family again. `seasonYear` is the season's starting year and `familyGroupId` the family. Undone with `mark_family_invoiced`; a family not marked changes nothing.",
    method: "POST",
    path: "/api/admin/subscription-billing",
    body: z.object(unmarkFamilyInvoicedFields),
    fixedBody: { action: "UNMARK_FAMILY_INVOICED" satisfies BillingAction },
    kind: "write",
    returns: SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_finance_booking_metrics",
    title: "Get finance booking metrics",
    summary:
      `The finance workspace's booking figures. A realised window (\`realizedFrom\`/\`realizedTo\`, and optionally \`realizedCutoff\`, the last day counted) covers stays that have happened: bookings, nights, occupancy and booked revenue by status and by day. A forward window (\`forwardFrom\`/\`forwardTo\`, and optionally \`forwardAsOf\`) covers bookings ahead, split into committed (paid) and at risk (not yet paid). Send one window or both; each pair goes together and spans at most ${MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS} days. Dates are \`YYYY-MM-DD\`. Also answers with payment totals (collected, refunded, owed) and how many bookings' money reconciles. Amounts are integer cents.`,
    method: "GET",
    path: "/api/finance/bookings/metrics",
    query: z.object(financeBookingMetricsQueryFields),
    kind: "read",
    requires: { area: "finance", level: "view" },
    returns: FINANCE_BOOKING_METRICS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_finance_sync_status",
    title: "Get the finance sync status",
    summary:
      "How the finance workspace's sync of reports from Xero is going: the latest run (when, how long, which reports succeeded or failed and why), the nightly schedule and its latest run, and recent failures.",
    method: "GET",
    path: "/api/finance/sync/status",
    kind: "read",
    requires: { area: "finance", level: "edit" },
    returns: FINANCE_SYNC_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "run_finance_sync",
    title: "Run the finance sync now",
    summary:
      "Pulls the finance workspace's reports from Xero now instead of waiting for the nightly run, and answers when it finishes: `completed`, or `partial` when some reports failed (see `datasetResults`). Refused with `already-running` if a sync is already under way. It only refreshes the workspace's copy of Xero's figures; repeating it is harmless.",
    method: "POST",
    path: "/api/finance/sync/run",
    kind: "write",
    requires: { area: "finance", level: "edit" },
    returns: FINANCE_SYNC_RUN_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "backfill_finance_monthly_facts",
    title: "Backfill the finance monthly figures",
    summary:
      `Rebuilds the finance workspace's month-by-month figures from Xero's history, twelve months at a time, back to \`fromMonth\` (\`YYYY-MM\`, optional; otherwise until Xero has no earlier figures). \`maxChunks\` (optional, default ${DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS}) caps how many twelve-month steps it takes. It replaces the workspace's stored monthly figures with Xero's and changes nothing in Xero; repeating it is harmless. Refused while another finance sync is running.`,
    method: "POST",
    path: "/api/finance/sync/backfill-monthly-facts",
    body: z.object(financeBackfillMonthlyFactsBodyFields),
    kind: "write",
    requires: { area: "finance", level: "edit" },
    returns: FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE,
    core: false,
  },
];
