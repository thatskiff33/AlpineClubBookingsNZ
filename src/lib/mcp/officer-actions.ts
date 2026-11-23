import { getAdminRouteRequirement, type AdminAccessRequirement } from "@/lib/admin-permissions";

import type { McpAction } from "./catalogue";

/**
 * The admin area and level an action needs, or null for a member action.
 * An officer action is offered only to someone holding it (`server.ts`), and
 * its route runs with the officer's real permissions, so the route's own
 * guard decides the call exactly as it does for the officer's browser.
 */
export function mcpActionAdminRequirement(
  action: Pick<McpAction, "path" | "method">,
): AdminAccessRequirement | null {
  return getAdminRouteRequirement(action.path, action.method);
}
