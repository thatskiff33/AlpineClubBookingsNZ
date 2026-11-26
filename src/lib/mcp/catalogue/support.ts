/**
 * The Support & System officer actions (ALP-724): every route the `support`
 * area guards bar the fresh-proof, Full Admin and AI-connection ones and
 * those with another permanent reason; and Admin Overview's one, the
 * work-queue counts (`overview`). Each family is a module of its own. Spread
 * into `MCP_ACTIONS`.
 */
import type { McpAction } from "../catalogue";

import { SUPPORT_AI_MCP_ACTIONS } from "./support-ai";
import { SUPPORT_MESSAGE_MCP_ACTIONS } from "./support-messages";
import { SUPPORT_RECORD_MCP_ACTIONS } from "./support-records";
import { SUPPORT_SYSTEM_MCP_ACTIONS } from "./support-system";

export const SUPPORT_MCP_ACTIONS: readonly McpAction[] = [
  ...SUPPORT_SYSTEM_MCP_ACTIONS,
  ...SUPPORT_RECORD_MCP_ACTIONS,
  ...SUPPORT_MESSAGE_MCP_ACTIONS,
  ...SUPPORT_AI_MCP_ACTIONS,
];
