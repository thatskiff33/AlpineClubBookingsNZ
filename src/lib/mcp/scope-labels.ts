/**
 * What the two connection scopes are called on every screen (ALP-653): the
 * approval screen, a member's connected apps and the officers' list. One
 * wording, so "View only" on the screen a member approved cannot read as
 * something else where they later check it (`INV-SSOT`).
 */
import type { McpGrantScope } from "@prisma/client";

export const MCP_SCOPE_LABELS: Record<McpGrantScope, string> = {
  READ: "View only",
  READ_WRITE: "View and change",
};
