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
import {
  ADMIN_PAYMENTS_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REVIEWED_CONNECTION_SHAPE,
  CREDIT_APPROVALS_CONNECTION_SHAPE,
  MEMBER_CREDITS_CONNECTION_SHAPE,
  OPENING_CREDIT_BATCHES_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-money";
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
];
