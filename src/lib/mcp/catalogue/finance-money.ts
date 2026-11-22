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

import { adminCreditAdjustmentRequestSchema } from "@/lib/admin-credit-adjustment-schemas";
import { adminPaymentsFilterFields } from "@/lib/admin-payments-query";
import {
  ADMIN_PAYMENTS_CONNECTION_SHAPE,
  CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE,
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
];
