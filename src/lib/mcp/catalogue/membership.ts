/**
 * The Membership admin area's AI app actions (ALP-720, `INV-MCP-006`).
 *
 * Each runs on an `/api/admin` route that `getAdminRouteRequirement` gives to
 * the `membership` area, with the officer's real permissions, so an officer
 * without the area is never offered one and its route refuses one anyway. The
 * area's other routes have a permanent reason in `exclusions.ts`.
 */
import type { McpAction } from "../catalogue";

import { MEMBERSHIP_LOCKER_MCP_ACTIONS } from "./membership-lockers";

export const MEMBERSHIP_MCP_ACTIONS: readonly McpAction[] = [...MEMBERSHIP_LOCKER_MCP_ACTIONS];
