/**
 * The Finance area's Xero actions (ALP-721, `INV-MCP-006`): the connection's
 * health, the sync queue and its repairs, and the member-to-contact links.
 * Each runs on a route the `finance` admin area gates, with the officer's
 * real permissions, and is offered only to an officer holding that area at
 * the route's level (`mcpActionAdminRequirement`). Setting Xero up, and
 * disconnecting it, stay on the website (`exclusions.ts`).
 */
import type { McpAction } from "../catalogue";

export const FINANCE_XERO_MCP_ACTIONS: readonly McpAction[] = [];
