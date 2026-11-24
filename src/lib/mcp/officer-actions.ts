/**
 * Officer actions: the one home for which admin area an AI app action needs
 * and whether this caller may be offered it (`INV-MCP-009`).
 *
 * An officer action is one whose route needs an admin area. It is offered only
 * to an officer who holds that area at that level and whose connection was
 * approved on the screen that says the app can act as an officer
 * (`McpGrant.officerConsentAt`). Its route then runs with the officer's real
 * permissions, so the route's own guard decides the call exactly as it does
 * for the officer's browser. Nothing else reads the requirement or the
 * consent: every officer area's actions go through these functions.
 */
import type { Session } from "next-auth";

import {
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";

import type { McpAction } from "./catalogue";

/** What the officer predicates read about a call: who is calling, and on which connection. */
export interface McpOfficerContext {
  readonly caller: { readonly officerConsent: boolean };
  readonly session: Session;
}

/**
 * Said to an app whose officer holds an action's admin area but whose
 * connection was not approved on the screen that says the app can act as an
 * officer (owner decision, #5305 item 1).
 */
export const MCP_OFFICER_RECONNECT_MESSAGE =
  "Officer actions are not available on this connection: it was not approved for them. " +
  "To use them, the officer connects the app again from the club website and approves the screen that says the app can act as an officer. " +
  "Their member actions keep working meanwhile.";

/**
 * The admin area and level an action needs, or null for a member action: what
 * the route itself demands. That is the route's explicit `requireAdmin`
 * permission where it names one (`requires`, held to the handler by the
 * census), else the path's rule in `admin-permissions.ts`. `requires` comes
 * first because only the entry knows a route whose handler asks for more than
 * the path's rule, such as a read that needs edit.
 */
export function mcpActionAdminRequirement(
  action: Pick<McpAction, "path" | "method" | "requires">,
): AdminAccessRequirement | null {
  return action.requires ?? getAdminRouteRequirement(action.path, action.method);
}

/**
 * Whether this caller could ever run the action: an officer action is hidden
 * from anyone without its admin area at its level, and from a connection its
 * officer has not approved for officer actions, in the tool list, in
 * `find_actions` and `describe_action`, and is not run for them. The route
 * still decides on the call itself; this only keeps the list honest.
 */
export function mcpCallerMayUse(action: McpAction, context: McpOfficerContext): boolean {
  const requirement = mcpActionAdminRequirement(action);
  if (requirement === null) return true;
  return context.caller.officerConsent && hasAdminAreaAccess(context.session.user, requirement);
}

/** The officer holds this action's area, but the connection lacks their approval for officer actions. */
export function officerMustReconnectFor(action: McpAction, context: McpOfficerContext): boolean {
  const requirement = mcpActionAdminRequirement(action);
  return requirement !== null && !context.caller.officerConsent && hasAdminAreaAccess(context.session.user, requirement);
}

/** An officer whose connection is not approved for officer actions. */
export function officerMustReconnect(context: McpOfficerContext): boolean {
  return !context.caller.officerConsent && hasAdminPortalAccess(context.session.user);
}
