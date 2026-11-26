/**
 * The Finance officer actions (ALP-721): every route the `finance` area guards
 * bar the fresh-proof ones and those with a permanent reason in
 * `exclusions.ts`. Each family is a module of its own. Spread into
 * `MCP_ACTIONS`.
 */
import type { McpAction } from "../catalogue";

import { FINANCE_MONEY_MCP_ACTIONS } from "./finance-money";
import { FINANCE_XERO_CONTACTS_MCP_ACTIONS } from "./finance-xero-contacts";
import { FINANCE_XERO_SYNC_MCP_ACTIONS } from "./finance-xero-sync";

export const FINANCE_MCP_ACTIONS: readonly McpAction[] = [
  ...FINANCE_MONEY_MCP_ACTIONS,
  ...FINANCE_XERO_SYNC_MCP_ACTIONS,
  ...FINANCE_XERO_CONTACTS_MCP_ACTIONS,
];
