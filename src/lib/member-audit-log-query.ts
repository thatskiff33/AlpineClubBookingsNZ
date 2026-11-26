/**
 * The query of `GET /api/member/audit-log`, a member's own account activity.
 * Shared with the AI app action catalogue (ALP-718), so `list_my_account_activity`
 * takes exactly the fields the route parses (`INV-SSOT`).
 */
import { z } from "zod";

import { adminListPageField } from "@/lib/admin-list-page";

/** An account history page: this many entries unless asked, and at most the max. */
export const MEMBER_AUDIT_LOG_DEFAULT_PAGE_SIZE = 10;
export const MEMBER_AUDIT_LOG_MAX_PAGE_SIZE = 50;

export const memberAuditLogQuerySchema = z.object({
  category: z.string().optional().default("all"),
  page: adminListPageField,
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEMBER_AUDIT_LOG_MAX_PAGE_SIZE)
    .optional()
    .default(MEMBER_AUDIT_LOG_DEFAULT_PAGE_SIZE),
});
