/**
 * The static route folders that sit beside a `[param]` folder some catalogued
 * action fills from the app's arguments. `/api/admin/members/[id]` with an
 * `id` of `export` would be `/api/admin/members/export`, a different route
 * that the action was never checked against, so the dispatcher refuses these
 * names as address arguments. No record id is spelt like a route folder.
 *
 * The census (`mcp-route-census.test.ts`) derives this list from the route
 * tree and fails until it matches exactly, so a new action or a new sibling
 * folder cannot leave a gap.
 */
export const MCP_STATIC_SIBLING_SEGMENTS: ReadonlySet<string> = new Set([
  "active",
  "bulk",
  "bulk-membership-type",
  "bulk-subscription-category",
  "bulk-update",
  "cleanup",
  "create-group",
  "drafts",
  "eligible-family",
  "exception-requests",
  "export",
  "import",
  "import-from-config",
  "invitations",
  "invite",
  "join",
  "link",
  "member-search",
  "mine",
  "non-member-contact",
  "partner-invite",
  "partner-invites",
  "pending-counts",
  "quote",
  "reorder",
  "request-adult",
  "request-child",
  "request-join",
  "request-removal",
  "requests",
  "roll-forward",
  "rooms",
  "search",
  "send-password-reset",
  "send-setup-invite",
  "settings",
  "subject-access",
]);
