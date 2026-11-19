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
 * the app be told one shape while the route enforces another.
 *
 * `mcp-route-census.test.ts` holds every route method in `src/app/api` to
 * either an entry here or a reasoned exclusion (`exclusions.ts`).
 */
import { z } from "zod";

import { availabilityQuerySchema } from "@/lib/availability-query-schema";
import { bookingIdParamsSchema, cancelBookingMutationSchema } from "@/lib/booking-cancel-schema";
import { bookingCreateCoreShape } from "@/lib/booking-create-fields";
import type { StepUpHttpMethod } from "@/lib/step-up-routes";

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
    core: true,
  },
  {
    id: "list_lodges",
    title: "List lodges",
    summary: "The club's lodges that can be booked, with the id each booking action takes as `lodgeId`.",
    method: "GET",
    path: "/api/lodges",
    kind: "read",
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
    core: true,
  },
  {
    id: "get_my_profile",
    title: "Read my profile",
    summary: "The signed-in member's own name, contact details, address and age group.",
    method: "GET",
    path: "/api/profile/summary",
    kind: "read",
    core: true,
  },
  {
    id: "list_notices",
    title: "List club notices",
    summary: "Club notices the signed-in member can see, pinned first and then newest.",
    method: "GET",
    path: "/api/notices",
    kind: "read",
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
    core: true,
    nextStep:
      "This is a draft. It holds no beds until the member confirms and pays at {origin}/bookings/{id}.",
  },
  {
    id: "preview_cancel_booking",
    title: "Preview cancelling a booking",
    summary:
      "What cancelling a booking would refund, and by which method, without cancelling it. Run this before `cancel_my_booking`.",
    method: "GET",
    path: "/api/bookings/[id]/cancel-preview",
    params: bookingIdParams,
    kind: "read",
    core: true,
  },
  {
    id: "cancel_my_booking",
    title: "Cancel a booking",
    summary:
      "Cancels a booking and refunds it under the club's cancellation policy. This cannot be undone. `refundMethod` is `card` or `credit`. The website's rule decides whose booking it may be: the member's own, or any member's for an officer who may cancel bookings there.",
    method: "POST",
    path: "/api/bookings/[id]/cancel",
    params: bookingIdParams,
    body: cancelBookingMutationSchema.pick({ refundMethod: true }),
    kind: "destructive",
    core: true,
  },
  {
    id: "list_my_draft_bookings",
    title: "List my draft bookings",
    summary: "Draft bookings the signed-in member saved and has not yet confirmed.",
    method: "GET",
    path: "/api/bookings/drafts",
    kind: "read",
    core: false,
  },
  {
    id: "get_my_credit_balance",
    title: "Read my account credit",
    summary: "The signed-in member's account credit balance, in cents.",
    method: "GET",
    path: "/api/member/credit-balance",
    kind: "read",
    core: false,
  },
  {
    id: "get_my_subscription_status",
    title: "Read my subscription status",
    summary: "Whether the signed-in member's club subscription is paid for the current season.",
    method: "GET",
    path: "/api/member/subscription-status",
    kind: "read",
    core: false,
  },
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
