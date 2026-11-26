/**
 * An account history as an AI app connection receives it (`INV-MCP-006`):
 * the member's own (`list_my_account_activity`) and an officer's view of one
 * member's (`list_member_activity`). Each entry carries when, what kind, the
 * outcome and its summary; never request details, devices, addresses or
 * metadata.
 */
import type { AuditTimelineResponse } from "@/lib/audit-query";
import { connectionShapeFor } from "@/lib/connection-projection";

export const MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE = connectionShapeFor<AuditTimelineResponse>({
  data: { createdAt: true, category: true, outcome: true, summary: true },
  total: true,
  page: true,
  pageSize: true,
  totalPages: true,
  category: true,
});
