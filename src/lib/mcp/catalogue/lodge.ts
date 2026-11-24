/**
 * The Lodge Operations officer actions (ALP-722): every route the `lodge`
 * area guards bar the fresh-proof, kiosk and access-detail ones, each family
 * in a module of its own. Spread into `MCP_ACTIONS`.
 */
import type { McpAction } from "../catalogue";

import { LODGE_CHORE_WORK_PARTY_MCP_ACTIONS } from "./lodge-chores-work-parties";
import { LODGE_HUT_LEADER_MCP_ACTIONS } from "./lodge-hut-leaders";
import { LODGE_MAINTENANCE_MCP_ACTIONS } from "./lodge-maintenance";
import { LODGE_SETUP_MCP_ACTIONS } from "./lodge-setup";

export const LODGE_MCP_ACTIONS: readonly McpAction[] = [
  ...LODGE_HUT_LEADER_MCP_ACTIONS,
  ...LODGE_CHORE_WORK_PARTY_MCP_ACTIONS,
  ...LODGE_SETUP_MCP_ACTIONS,
  ...LODGE_MAINTENANCE_MCP_ACTIONS,
];
