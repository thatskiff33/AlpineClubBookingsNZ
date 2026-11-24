/**
 * The group-booking and whole-lodge AI app actions (ALP-797, `INV-MCP-006`),
 * split from `catalogue.ts` to keep each module within its size budget;
 * `MCP_ACTIONS` spreads them in. The same rules apply: request schemas and
 * answer shapes are the routes' own (`INV-SSOT`), and the route's guards
 * decide.
 *
 * Joining a group and paying a group's combined bill move money, the public
 * request forms are for visitors, and a school confirms its attendees from an
 * emailed link: those stay website-only (`exclusions.ts`).
 */
import {
  GROUP_BOOKING_CREATED_CONNECTION_SHAPE,
  GROUP_BOOKING_JOIN_STATUS_CONNECTION_SHAPE,
  GROUP_BOOKING_SUMMARY_CONNECTION_SHAPE,
  MY_WHOLE_LODGE_REQUESTS_CONNECTION_SHAPE,
  WHOLE_LODGE_REQUEST_SENT_CONNECTION_SHAPE,
  WHOLE_LODGE_REQUEST_WITHDRAWN_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-groups";
import {
  createGroupBookingSchema,
  groupBookingCodeParamsSchema,
  groupBookingJoinStatusSchema,
} from "@/lib/group-booking-request-schemas";
import type { McpAction } from "@/lib/mcp/catalogue";
import {
  memberWholeLodgeRequestSchema,
  wholeLodgeRequestIdParamsSchema,
} from "@/lib/member-whole-lodge-request-schema";
import { MY_WHOLE_LODGE_REQUEST_LIMIT } from "@/lib/member-whole-lodge-requests";

export const MCP_GROUP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_my_whole_lodge_requests",
    title: "List my whole-lodge requests",
    summary: `The signed-in member's own requests to book the whole lodge, newest first (up to ${MY_WHOLE_LODGE_REQUEST_LIMIT}): dates (\`YYYY-MM-DD\`), approximate party size, status (\`pending\`, \`approved\`, \`declined\` or \`withdrawn\`), the booking an approved one became, and whether it can still be withdrawn.`,
    method: "GET",
    path: "/api/booking-requests/whole-lodge",
    kind: "read",
    returns: MY_WHOLE_LODGE_REQUESTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_whole_lodge",
    title: "Ask to book the whole lodge",
    summary:
      "Sends the club's booking officer a request for the signed-in member's group to have a lodge to itself from `checkIn` to `checkOut` (`YYYY-MM-DD`, not in the past): the lodge (`lodgeId`, from `list_lodges`), an approximate `headcount`, who the group is (`groupDescription`), optional `notes`, and whether to put the member's account credit towards it if approved (`applyAccountCredit`). Nothing is booked or charged: the officer decides and sets the price. The answer is the same whether or not the lodge is free. A member may have only a few requests waiting at once. The booking officer is emailed it, so confirm it with the member first.",
    method: "POST",
    path: "/api/booking-requests/whole-lodge",
    body: memberWholeLodgeRequestSchema,
    kind: "destructive",
    returns: WHOLE_LODGE_REQUEST_SENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "withdraw_whole_lodge_request",
    title: "Withdraw a whole-lodge request",
    summary:
      "Withdraws one of the signed-in member's own whole-lodge requests by `id`, from `list_my_whole_lodge_requests`, while `canWithdraw` is true. Cannot be undone: the member would have to ask again.",
    method: "POST",
    path: "/api/booking-requests/whole-lodge/[id]/withdraw",
    params: wholeLodgeRequestIdParamsSchema,
    kind: "destructive",
    returns: WHOLE_LODGE_REQUEST_WITHDRAWN_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "open_group_booking",
    title: "Open a group on my booking",
    summary:
      "Opens a group on one of the signed-in member's own bookings (`organiserBookingId`) so other members can add their own bookings to it with the join code it answers with. `paymentMode` is `EACH_PAYS_OWN` (each joiner pays for themselves) or `ORGANISER_PAYS` (the member later pays one combined bill on the website). Optional `joinDeadline` (`YYYY-MM-DD`) and `maxJoiners`. Joining and paying happen on the website.",
    method: "POST",
    path: "/api/group-bookings",
    body: createGroupBookingSchema,
    kind: "write",
    returns: GROUP_BOOKING_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_group_booking",
    title: "Read a group booking",
    summary:
      "What the join page shows for a group's join `code`: its status, how it is paid for and how a member joining now pays, the organiser's first name, the lodge, the dates, the join deadline and whether it can be joined now. An unknown code answers Not Found.",
    method: "GET",
    path: "/api/group-bookings/[code]",
    params: groupBookingCodeParamsSchema,
    kind: "read",
    returns: GROUP_BOOKING_SUMMARY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_group_booking_joining",
    title: "Close or reopen my group to new joins",
    summary:
      "For a group the signed-in member organises, by join `code`: `action` `close` stops new members joining and `reopen` lets them join again. Members already in the group keep their bookings. A cancelled group cannot be reopened.",
    method: "PATCH",
    path: "/api/group-bookings/[code]",
    params: groupBookingCodeParamsSchema,
    body: groupBookingJoinStatusSchema,
    kind: "write",
    returns: GROUP_BOOKING_JOIN_STATUS_CONNECTION_SHAPE,
    core: false,
  },
];
