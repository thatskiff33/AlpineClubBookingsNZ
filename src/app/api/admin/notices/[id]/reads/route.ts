import { NextResponse } from "next/server";
import { resolveNoticeAudienceMembers } from "@/lib/notices";
import { noticeIdParamsSchema } from "@/lib/notices-shared";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { noticeReadsQuerySchema } from "@/lib/admin-membership-api/notices";
import { connectionJson } from "@/lib/mcp-connection-request";
import { NOTICE_READS_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-notices";

/**
 * Read-status report for one notice (view level). The notice's CURRENT effective
 * audience left-joined with its read receipts, paginated, plus summary counts.
 * An AI app connection is not sent members' email addresses (ALP-720).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const parsedParams = noticeIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }
  const noticeId = parsedParams.data.id;

  const notice = await prisma.notice.findUnique({
    where: { id: noticeId },
    select: { id: true, requiresAcknowledgement: true },
  });
  if (!notice) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }

  const query = noticeReadsQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: query.error.flatten() },
      { status: 400 },
    );
  }
  const { page, pageSize } = query.data;

  const audience = await resolveNoticeAudienceMembers(noticeId);
  const receipts = await prisma.noticeReadReceipt.findMany({
    where: {
      noticeId,
      memberId: { in: audience.map((a) => a.memberId) },
    },
    select: { memberId: true, readAt: true, acknowledgedAt: true },
  });
  const receiptByMember = new Map(receipts.map((r) => [r.memberId, r]));

  const rows = audience.map((member) => {
    const receipt = receiptByMember.get(member.memberId) ?? null;
    return {
      memberId: member.memberId,
      name: member.name,
      email: member.email,
      audienceVia: member.audienceVia,
      readAt: receipt?.readAt.toISOString() ?? null,
      acknowledgedAt: receipt?.acknowledgedAt?.toISOString() ?? null,
    };
  });

  const audienceCount = rows.length;
  const readCount = rows.filter((r) => r.readAt !== null).length;
  const acknowledgedCount = rows.filter((r) => r.acknowledgedAt !== null).length;

  const start = (page - 1) * pageSize;
  const pagedRows = rows.slice(start, start + pageSize);

  return connectionJson(
    request,
    {
      requiresAcknowledgement: notice.requiresAcknowledgement,
      rows: pagedRows,
      page,
      pageSize,
      total: audienceCount,
      totalPages: Math.max(1, Math.ceil(audienceCount / pageSize)),
      audienceCount,
      readCount,
      acknowledgedCount,
    },
    NOTICE_READS_CONNECTION_SHAPE,
  );
}
