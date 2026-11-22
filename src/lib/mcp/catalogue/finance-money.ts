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
import { adminPaymentsFilterFields } from "@/lib/admin-payments-query";
import { adminRefundRequestsQuerySchema } from "@/lib/admin-refund-requests-query";
import { adminReportQuerySchema } from "@/lib/admin-reports-query";
import { adminSubscriptionsQuerySchema } from "@/lib/admin-subscriptions-query";
import { bankRefundVoidAnsweredBodySchema } from "@/lib/bank-refund-void-answered-body";
import {
  ADMIN_PAYMENTS_CONNECTION_SHAPE,
  ADMIN_REPORTS_CONNECTION_SHAPE,
  ADMIN_SUBSCRIPTIONS_CONNECTION_SHAPE,
  BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REVIEWED_CONNECTION_SHAPE,
  CREDIT_APPROVALS_CONNECTION_SHAPE,
  MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE,
  MANUAL_REFUND_TASKS_CONNECTION_SHAPE,
  MANUAL_SUBSCRIPTION_PAYMENT_CONNECTION_SHAPE,
  MEMBER_CREDITS_CONNECTION_SHAPE,
  OPENING_CREDIT_BATCHES_CONNECTION_SHAPE,
  PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE,
  REFUND_REQUESTS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-money";
import {
  manualBookingPaymentBodySchema,
  manualSubscriptionPaymentBodySchema,
} from "@/lib/manual-payment-request-schemas";
import { recordIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

export const FINANCE_MONEY_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_payments",
    title: "List payments",
    summary:
      "One page of the club's booking payments, newest activity first unless `sortBy` says otherwise, with totals over every payment the filters match. Dates are `YYYY-MM-DD`; `from`/`to` bound the latest activity, `checkInFrom`/`checkInTo` the stay. `search` matches a member, booking or reference. Amounts are integer cents.",
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
      "Asks for a manual change to one member's account credit, in integer cents: positive adds credit and must name `grantAccount` (`MEMBER_OWN_MONEY` or `GOODWILL`), negative deducts and names none. Nothing changes until a different officer approves it. `idempotencyKey` is a new UUID for each request; sending the same one again does not make a second request.",
    method: "POST",
    path: "/api/admin/members/[id]/credits",
    params: recordIdParamsSchema,
    body: adminCreditAdjustmentRequestSchema,
    kind: "write",
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
      "Decides a pending manual credit adjustment: `decision` is `APPROVE` or `REJECT`. `id` is the member and `requestId` the request (from `list_credit_adjustment_requests`). Approving applies the amount to the member's account credit straight away and cannot be undone from the app; a correction is a new request. The officer who asked for an adjustment cannot approve it: a different officer must. Answers with the member's balance afterwards, in integer cents.",
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
      "Records that an officer has dealt with a bank-transfer refund whose Xero credit note was voided and that the nightly check could not match to one refund. `id` is the voided note's link from the stuck-states list. `note` (required, up to 500 characters) says what was done; `confirmed` must be `true`, sent only after the officer confirms. It moves no money and changes nothing in Xero, but the item leaves the list for good.",
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
      "Marks one member subscription paid outside Xero (`direction` `paid`), or reverses an earlier manual mark (`direction` `unpaid`). `id` is the subscription (from `list_subscriptions`). Marking paid must say `notifyMember` (true emails the member a receipt); a reversal emails nobody and must not send it. `note` (up to 500 characters) says how it was paid; `confirmed` must be `true`, sent only after the officer confirms. It never raises or voids a Xero invoice. It changes the member's money record straight away; a mistake is put right by reversing it.",
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
      "Records one booking's payment as settled in cash or by a bank transfer that never reached Xero (`direction` `paid`), or reverses an earlier manual settlement (`direction` `unpaid`; the booking stays booked, unpaid again). `id` is the booking. Marking paid must send `notifyMember` (true emails the member a booking confirmation) and `expectedAmountCents`, the amount owing the officer was shown, in integer cents: the payment is refused if the amount has changed since. If the booking also has an extra payment owing, send `additionalCoverage` with `covered` (does this money cover the extra too?) and `expectedAdditionalAmountCents`, the extra shown. A reversal sends none of these. `note` (up to 500 characters) says how it was paid; `confirmed` must be `true`, sent only after the officer confirms. It never raises or voids a Xero invoice.",
    method: "POST",
    path: "/api/admin/bookings/[id]/mark-paid",
    params: recordIdParamsSchema,
    body: manualBookingPaymentBodySchema,
    kind: "destructive",
    returns: MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE,
    core: false,
  },
];
