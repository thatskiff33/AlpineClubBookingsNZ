/**
 * N-09: Bulk Communication History
 * GET /api/admin/communications/history
 * Returns past bulk sends with stats.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get audit log entries for bulk communications
  const auditEntries = await prisma.auditLog.findMany({
    where: { action: "BULK_COMMUNICATION_SENT" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      memberId: true,
      details: true,
      createdAt: true,
    },
  });

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

  return NextResponse.json({ history });
}
