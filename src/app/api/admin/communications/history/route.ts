/**
 * N-09: Bulk Communication History
 * GET /api/admin/communications/history
 * Returns one page of past bulk sends with stats, newest first, through the
 * shared admin list page keys (INV-OPS-020).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { adminListPage, adminListPageQueryFields } from "@/lib/admin-list-page";

const querySchema = z.object({
  ...adminListPageQueryFields,
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

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

  return NextResponse.json({
    data: history,
    history,
    ...adminListPage({ page, pageSize, total }),
  });
}
