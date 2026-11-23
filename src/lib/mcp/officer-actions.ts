import { getAdminRouteRequirement, type AdminAccessRequirement } from "@/lib/admin-permissions";

import type { McpAction } from "./catalogue";

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
  // `requires` first: the map files all of `/api/finance` under one prefix, so
  // only the entry, which the census holds to the handler's guard, knows a
  // workspace read that needs edit.
  return action.requires ?? getAdminRouteRequirement(action.path, action.method);
}
