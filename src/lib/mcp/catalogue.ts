/**
 * The actions an AI app connection may run (ALP-653, `INV-MCP-006`).
 *
 * An action is one method of one existing API route, named so an AI app can
 * find it. The catalogue adds no behaviour and no permission: the dispatcher
 * (`dispatch.ts`) sends the call back through the site's own front door, so
 * the route's guards decide, exactly as they do for a browser.
 *
 * The request schemas here are the routes' own, imported from the lib modules
 * the routes import them from (`INV-SSOT`). A field described twice would let
 * the app be told one shape while the route enforces another. So is each
 * action's answer (`returns`): the shape the route projects a connection's
 * answer onto, from `connection-shapes.ts`.
 *
 * `mcp-route-census.test.ts` holds every route method in `src/app/api` to
 * either an entry here or a reasoned exclusion (`exclusions.ts`).
 *
 * The member's own actions are listed here. An officer area's actions live in
 * a module of their own under `catalogue/` and are spread in below; each runs
 * on a route that admin area gates, with the officer's real permissions
 * (`mcpActionAdminRequirement`).
 */
import { z } from "zod";

import { getAdminRouteRequirement, type AdminAccessRequirement } from "@/lib/admin-permissions";
import { availabilityQuerySchema } from "@/lib/availability-query-schema";
import { bookingIdParamsSchema, cancelBookingMutationSchema } from "@/lib/booking-cancel-schema";
import { bookingCreateCoreShape } from "@/lib/booking-create-fields";
import type { ConnectionShape } from "@/lib/connection-projection";
import {
  AGE_GROUPS_CONNECTION_SHAPE,
  AVAILABILITY_CONNECTION_SHAPE,
  BOOKING_MESSAGES_CONNECTION_SHAPE,
  CANCEL_BOOKING_CONNECTION_SHAPE,
  CANCEL_PREVIEW_CONNECTION_SHAPE,
  COMMITTEE_CONNECTION_SHAPE,
  CREDIT_BALANCE_CONNECTION_SHAPE,
  LODGE_LIST_CONNECTION_SHAPE,
  LODGE_ROSTER_CONNECTION_SHAPE,
  MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE,
  MEMBER_BOOKING_CONNECTION_SHAPE,
  MEMBER_BOOKING_LIST_CONNECTION_SHAPE,
  MEMBER_DRAFT_LIST_CONNECTION_SHAPE,
  MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE,
  MEMBER_FAMILY_CONNECTION_SHAPE,
  MEMBER_NOTICE_CONNECTION_SHAPE,
  MEMBER_NOTICE_LIST_CONNECTION_SHAPE,
  MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  MEMBER_PROFILE_CONNECTION_SHAPE,
  MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE,
  NOTICE_READ_CONNECTION_SHAPE,
  SKIFIELD_REPORT_CONNECTION_SHAPE,
  SUBSCRIPTION_STATUS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";
import { ROSTER_WINDOW_DAYS } from "@/lib/lodge-roster-window";
import { memberAuditLogQuerySchema } from "@/lib/member-audit-log-query";
import { memberNotificationPreferencesConnectionUpdateSchema } from "@/lib/member-notification-preferences";
import { memberProfileConnectionUpdateSchema } from "@/lib/member-profile-update-schema";
import { noticeIdParamsSchema } from "@/lib/notices-shared";
import type { StepUpHttpMethod } from "@/lib/step-up-routes";

import { FINANCE_MONEY_MCP_ACTIONS } from "./catalogue/finance-money";
import { FINANCE_XERO_CONTACTS_MCP_ACTIONS } from "./catalogue/finance-xero-contacts";
import { FINANCE_XERO_SYNC_MCP_ACTIONS } from "./catalogue/finance-xero-sync";

/**
 * `read` changes nothing. `write` changes something the member can undo.
 * `destructive` cannot be undone from the app. A view-only connection runs
 * `read` actions only.
 */
export type McpActionKind = "read" | "write" | "destructive";

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface McpAction {
  /** The tool name the AI app calls. Lower snake case, never reused. */
  readonly id: string;
  readonly title: string;
  /** What the action does, written for the AI app choosing between actions. */
  readonly summary: string;
  readonly method: StepUpHttpMethod;
  /** App Router path, dynamic segments in brackets: `/api/bookings/[id]`. */
  readonly path: string;
  /** One key per bracketed segment in `path`. */
  readonly params?: ObjectSchema;
  readonly query?: ObjectSchema;
  readonly body?: ObjectSchema;
  /** Body fields the catalogue sets and the app cannot. */
  readonly fixedBody?: Readonly<Record<string, unknown>>;
  readonly kind: McpActionKind;
  /**
   * For an officer route outside `/api/admin` (only `/api/finance`), the area
   * and level its own guard enforces, which the admin route map cannot say.
   * The census holds it to the guard the route calls. An `/api/admin` action
   * never sets it: the route map decides (`mcpActionAdminRequirement`).
   */
  readonly requires?: AdminAccessRequirement;
  /**
   * A `POST` that changes nothing, such as a quote, run as a `read`. The
   * census pins every route allowed to be one.
   */
  readonly preview?: true;
  /**
   * The fields the action answers with: the shape the route projects a
   * connection's answer onto (`connectionJson`), or, for a stage 1 route whose
   * whole answer was chosen for the member, a complete description of it.
   */
  readonly returns: ConnectionShape;
  /** Listed as its own tool. The rest are reached through `find_actions`. */
  readonly core: boolean;
  /**
   * A sentence appended to a successful result that points the member at the
   * website for the step an app cannot take. `{origin}` is the club's site and
   * `{id}` the `id` of the returned record.
   */
  readonly nextStep?: string;
}

/**
 * An action a member may ask for that only the website can do. The app is
 * answered with the page to open and nothing runs.
 */
export interface McpWebsiteOnlyAction {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Site path the member opens. `{id}` is filled from the `id` argument. */
  readonly page: string;
  readonly needsId: boolean;
}

const bookingIdParams = bookingIdParamsSchema;

export const MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "get_availability",
    title: "Check lodge availability",
    summary:
      "Free beds at a lodge for each night of one calendar month. `month` counts from 0 (January) to 11 (December).",
    method: "GET",
    path: "/api/availability",
    query: availabilityQuerySchema,
    kind: "read",
    returns: AVAILABILITY_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_lodges",
    title: "List lodges",
    summary: "The club's lodges that can be booked, with the id each booking action takes as `lodgeId`.",
    method: "GET",
    path: "/api/lodges",
    kind: "read",
    returns: LODGE_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_my_bookings",
    title: "List my bookings",
    summary:
      "The signed-in member's bookings, newest stay first: the ones they made and the ones they are a guest on. `truncated` is true when there are older ones than the 200 listed. `finalPriceCents` is null on a booking someone else made, and `priceBeingChecked` means the club has not yet confirmed the figure.",
    method: "GET",
    path: "/api/bookings/mine",
    kind: "read",
    returns: MEMBER_BOOKING_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_booking",
    title: "Read one of my bookings",
    summary:
      "A summary of one booking the signed-in member made or is a guest on: dates, lodge, status, party and, for a booking they made, the price and their note. `priceBeingChecked` means the club has not yet confirmed the figure.",
    method: "GET",
    path: "/api/bookings/[id]",
    params: bookingIdParams,
    kind: "read",
    returns: MEMBER_BOOKING_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_family_group",
    title: "Read my family group",
    summary:
      "The signed-in member and the active members of their family groups, with the member ids a booking's guest list takes.",
    method: "GET",
    path: "/api/members/family",
    kind: "read",
    returns: MEMBER_FAMILY_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_profile",
    title: "Read my profile",
    summary: "The signed-in member's own name, contact details, address and age group, and whether two-step sign-in is on.",
    method: "GET",
    path: "/api/profile/summary",
    kind: "read",
    returns: MEMBER_PROFILE_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_notices",
    title: "List club notices",
    summary: "Club notices the signed-in member can see, pinned first and then newest.",
    method: "GET",
    path: "/api/notices",
    kind: "read",
    returns: MEMBER_NOTICE_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "create_draft_booking",
    title: "Start a draft booking",
    summary:
      "Saves a draft booking for the signed-in member. A draft holds no beds and takes no payment: the member finishes and pays on the website.",
    method: "POST",
    path: "/api/bookings",
    body: z.object(bookingCreateCoreShape),
    fixedBody: { draft: true },
    kind: "write",
    returns: MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE,
    core: true,
    nextStep:
      "This is a draft. It holds no beds until the member confirms and pays at {origin}/bookings/{id}.",
  },
  {
    id: "preview_cancel_booking",
    title: "Preview cancelling a booking",
    summary:
      "What cancelling one of the signed-in member's own bookings would refund, and by which method, without cancelling it. Run this before `cancel_my_booking`.",
    method: "GET",
    path: "/api/bookings/[id]/cancel-preview",
    params: bookingIdParams,
    kind: "read",
    returns: CANCEL_PREVIEW_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "cancel_my_booking",
    title: "Cancel a booking",
    summary:
      "Cancels one of the signed-in member's own bookings and refunds it under the club's cancellation policy. This cannot be undone. `refundMethod` is `card` or `credit`. Only a booking the member made can be cancelled here, whatever the member's role on the website.",
    method: "POST",
    path: "/api/bookings/[id]/cancel",
    params: bookingIdParams,
    body: cancelBookingMutationSchema.pick({ refundMethod: true }),
    kind: "destructive",
    returns: CANCEL_BOOKING_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_my_draft_bookings",
    title: "List my draft bookings",
    summary: "Draft bookings the signed-in member saved and has not yet confirmed.",
    method: "GET",
    path: "/api/bookings/drafts",
    kind: "read",
    returns: MEMBER_DRAFT_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_credit_balance",
    title: "Read my account credit",
    summary: "The signed-in member's account credit balance, in cents.",
    method: "GET",
    path: "/api/member/credit-balance",
    kind: "read",
    returns: CREDIT_BALANCE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_subscription_status",
    title: "Read my subscription status",
    summary: "Whether the signed-in member's club subscription is paid for the current season.",
    method: "GET",
    path: "/api/member/subscription-status",
    kind: "read",
    returns: SUBSCRIPTION_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_notification_preferences",
    title: "Read my email preferences",
    summary:
      "Which emails the signed-in member has chosen to receive from the club: booking confirmations, reminders, bumps and cancellations, being added to a family member's booking, the chore roster, club notices and marketing. `true` means the email is sent.",
    method: "GET",
    path: "/api/notifications/preferences",
    kind: "read",
    returns: MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_my_notification_preferences",
    title: "Change my email preferences",
    summary:
      "Turns emails from the club on (`true`) or off (`false`) for the signed-in member. Only the preferences sent change. Answers with all of them. Marketing email can only be turned off here: the member turns it on themselves on the website.",
    method: "PUT",
    path: "/api/notifications/preferences",
    body: memberNotificationPreferencesConnectionUpdateSchema,
    kind: "write",
    returns: MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_my_profile",
    title: "Change my profile",
    summary:
      "Saves the signed-in member's own name, phone number, date of birth, addresses and occupation. `firstName`, `lastName` and the three phone fields are always saved, so send their current values from `get_my_profile` to keep them; any other field not sent keeps its stored value. Dates are `YYYY-MM-DD`. Refused if the result would leave the profile incomplete. Email address, password and two-step sign-in change only on the website.",
    method: "PUT",
    path: "/api/profile",
    // Dietary needs are never read by an app, so it is not offered a blind
    // write; the lobby-screen phone opt-in is a consent the member gives on
    // the website.
    body: memberProfileConnectionUpdateSchema,
    kind: "write",
    returns: MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_notice",
    title: "Read a club notice",
    summary:
      "One club notice the signed-in member can see, with its text, by the `id` from `list_notices`. Reading it here does not mark it read: run `mark_notice_read` for that. A notice that asks to be acknowledged is acknowledged on the website.",
    method: "GET",
    path: "/api/notices/[id]",
    params: noticeIdParamsSchema,
    kind: "read",
    returns: MEMBER_NOTICE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "mark_notice_read",
    title: "Mark a notice as read",
    summary:
      "Records that the signed-in member has read one club notice. Marking it again keeps the first time. This does not acknowledge a notice that asks for it.",
    method: "POST",
    path: "/api/notices/[id]/read",
    params: noticeIdParamsSchema,
    kind: "write",
    returns: NOTICE_READ_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_my_account_activity",
    title: "List my account activity",
    summary: `The signed-in member's own account history, newest first: bookings, payments, profile and family changes, sign-in and AI app events. \`category\` is one of ${MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map(({ value }) => `\`${value}\``).join(", ")}. \`page\` counts from 1; \`pageSize\` is at most 50.`,
    method: "GET",
    path: "/api/member/audit-log",
    query: memberAuditLogQuerySchema,
    kind: "read",
    returns: MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_lodge_roster",
    title: "See who is at the lodge",
    summary:
      `Who is staying over the next ${ROSTER_WINDOW_DAYS} nights at the lodges the signed-in member can book, as the club's roster page shows it: names, or a group label and head count, and their nights. \`to\` is the morning after the last night shown. Only when the club has the roster switched on.`,
    method: "GET",
    path: "/api/lodge-roster",
    kind: "read",
    returns: LODGE_ROSTER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_age_groups",
    title: "Read the club's age groups",
    summary:
      "The club's age groups (`tier`), their labels and age ranges, and whether each needs a paid subscription to book. Ages are as at the start of the season.",
    method: "GET",
    path: "/api/age-tier-settings",
    kind: "read",
    returns: AGE_GROUPS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_messages",
    title: "Read the club's booking messages",
    summary:
      "The club's standard booking messages, such as payment instructions, by key. `{{TOKEN}}` placeholders take their values from `tokens`; others are filled in for a particular booking.",
    method: "GET",
    path: "/api/booking-messages",
    kind: "read",
    returns: BOOKING_MESSAGES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_committee",
    title: "List the club committee",
    summary: "The club's published committee: each person's name, role and description.",
    method: "GET",
    path: "/api/committee",
    kind: "read",
    returns: COMMITTEE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_skifield_report",
    title: "Read the ski field report",
    summary:
      "The ski field's latest road, lift, facility, weather and trail status, as the club's website shows it. `visibility` says which sections the club shows. `stale` means the report could not be refreshed and is the last one fetched.",
    method: "GET",
    path: "/api/skifield-whakapapa",
    kind: "read",
    returns: SKIFIELD_REPORT_CONNECTION_SHAPE,
    core: false,
  },
  // Officer areas (ALP-721 onwards): shown only to an officer holding the area.
  ...FINANCE_MONEY_MCP_ACTIONS,
  ...FINANCE_XERO_SYNC_MCP_ACTIONS,
  ...FINANCE_XERO_CONTACTS_MCP_ACTIONS,
];

export const MCP_WEBSITE_ONLY_ACTIONS: readonly McpWebsiteOnlyAction[] = [
  {
    id: "pay_for_booking",
    title: "Pay for a booking",
    summary: "Card details are entered on the club website, never in an AI app.",
    page: "/bookings/{id}",
    needsId: true,
  },
  {
    id: "change_sign_in_details",
    title: "Change password or two-step sign-in",
    summary: "Passwords and two-step sign-in are changed on the club website, after signing in again.",
    page: "/profile",
    needsId: false,
  },
  {
    id: "manage_connected_apps",
    title: "Disconnect an AI app",
    summary: "Connected AI apps are listed and disconnected on the member's profile page.",
    page: "/profile",
    needsId: false,
  },
];

/** `/api/bookings/[id]` → `src/app/api/bookings/[id]/route.ts`. */
export function mcpActionRouteFile(action: Pick<McpAction, "path">): string {
  return `src/app${action.path}/route.ts`;
}

/** The finance workspace's API, gated by its own guards rather than the admin route map. */
export const FINANCE_WORKSPACE_API_PREFIX = "/api/finance";

/**
 * The admin area and level an action needs, or null for a member action
 * (`INV-MCP-009`).
 * An officer action is offered only to someone holding it (`server.ts`), and
 * its route runs with the officer's real permissions, so the route's own
 * guard decides the call exactly as it does for the officer's browser.
 */
export function mcpActionAdminRequirement(
  action: Pick<McpAction, "path" | "method" | "requires">,
): AdminAccessRequirement | null {
  return getAdminRouteRequirement(action.path, action.method) ?? action.requires ?? null;
}

export function findMcpAction(id: string): McpAction | undefined {
  return MCP_ACTIONS.find((action) => action.id === id);
}

export function findMcpWebsiteOnlyAction(id: string): McpWebsiteOnlyAction | undefined {
  return MCP_WEBSITE_ONLY_ACTIONS.find((action) => action.id === id);
}

const EMPTY_INPUT = z.object({});

/**
 * The one flat object an app sends for an action: its path, query and body
 * fields together. The catalogue test refuses an action whose three parts
 * share a key, so each argument has one destination.
 */
export function mcpActionInputSchema(action: McpAction): ObjectSchema {
  const shape = {
    ...action.params?.shape,
    ...action.query?.shape,
    ...action.body?.shape,
  };
  return Object.keys(shape).length === 0 ? EMPTY_INPUT : z.object(shape);
}

/**
 * JSON Schema for an action's arguments as the app must send them: `io:
 * "input"` describes a date as the string the route parses, not the value the
 * route's transform produces.
 */
export function mcpActionInputJsonSchema(action: McpAction): Record<string, unknown> {
  const schema = z.toJSONSchema(mcpActionInputSchema(action), {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: "object" };
}

/** Where each of an app's flat arguments goes on the request. */
export function splitMcpActionArguments(
  action: McpAction,
  args: Readonly<Record<string, unknown>>,
): {
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly body: Record<string, unknown> | null;
} {
  const pick = (schema: ObjectSchema | undefined) => {
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(schema?.shape ?? {})) {
      if (args[key] !== undefined) picked[key] = args[key];
    }
    return picked;
  };
  const hasBody = action.body !== undefined || action.fixedBody !== undefined;
  return {
    params: pick(action.params),
    query: pick(action.query),
    // `fixedBody` is spread last: an app cannot turn a draft into a booking.
    body: hasBody ? { ...pick(action.body), ...action.fixedBody } : null,
  };
}
