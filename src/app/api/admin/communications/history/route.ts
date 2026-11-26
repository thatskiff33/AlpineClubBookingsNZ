/**
 * N-09: Bulk Communication History
 * GET /api/admin/communications/history
 * Returns one page of past bulk sends with stats, newest first, through the
 * shared admin list page keys (INV-OPS-020). An AI app connection is sent
 * the `history` list once, without its `data` copy (ALP-720).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { adminListPage } from "@/lib/admin-list-page";
import { communicationHistoryQuerySchema } from "@/lib/admin-membership-api/notices";
import { connectionJson } from "@/lib/mcp-connection-request";
import { COMMUNICATION_HISTORY_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-notices";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = communicationHistoryQuerySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { page, pageSize } = parsed.data;

  // Get audit log entries for bulk communications
  const where = { action: "BULK_COMMUNICATION_SENT" };
  const [auditEntries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      // `id` breaks createdAt ties so a send never repeats or vanishes between pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize,
      skip: (page - 1) * pageSize,
      select: {
        id: true,
        memberId: true,
        details: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const history = auditEntries.map((entry) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(entry.details || "{}");
    } catch {
      // ignore parse errors
    }
    return {
      id: entry.id,
      sentBy: entry.memberId,
      subject: parsed.subject || "Unknown",
      recipientFilter: parsed.recipientFilter || "unknown",
      totalRecipients: parsed.totalRecipients || 0,
      eligibleRecipients: parsed.eligibleRecipients || 0,
      queued: parsed.queued || 0,
      sentAt: entry.createdAt,
    };
  });

  return connectionJson(
    request,
    {
      data: history,
      history,
      ...adminListPage({ page, pageSize, total }),
    },
    COMMUNICATION_HISTORY_CONNECTION_SHAPE,
  );
}
