/**
 * N-09: Bulk Communication History
 * GET /api/admin/communications/history
 * Returns past bulk sends with stats.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      orderBy: { createdAt: "desc" },
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

  return NextResponse.json({ data: history, history, page, pageSize, total });
}
