/**
 * The query of `GET /api/member/audit-log`, a member's own account activity.
 * Shared with the AI app action catalogue (ALP-718), so `list_my_account_activity`
 * takes exactly the fields the route parses (`INV-SSOT`).
 */
import { z } from "zod";

import { adminListPageField } from "@/lib/admin-list-page";

export const memberAuditLogQuerySchema = z.object({
  category: z.string().optional().default("all"),
  page: adminListPageField,
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(10),
});
