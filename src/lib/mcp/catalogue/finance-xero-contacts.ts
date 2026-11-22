/**
 * The Finance area's Xero contact and invoice actions (ALP-721,
 * `INV-MCP-006`): linking members to Xero contacts, the mismatch, duplicate,
 * erased-member and missing-contact reviews, missing invoices and cash
 * credits. Each runs on a route the `finance` admin area gates, with the
 * officer's real permissions, and is offered only to an officer holding that
 * area at the route's level (`mcpActionAdminRequirement`).
 */
import type { McpAction } from "../catalogue";

export const FINANCE_XERO_CONTACTS_MCP_ACTIONS: readonly McpAction[] = [];
