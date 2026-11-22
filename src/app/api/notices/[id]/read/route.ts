import { NextResponse } from "next/server";
import { getNoticeForMember } from "@/lib/notices";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { NOTICE_READ_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { noticeIdParamsSchema } from "@/lib/notices-shared";

/**
 * Record that the acting member has opened a notice. memberId comes FROM THE
 * SESSION ONLY (never the body). Audience is re-checked via getNoticeForMember,
 * so an out-of-audience or non-existent notice returns 404 (indistinguishable).
 * The receipt upsert never overwrites an existing readAt, so a repeat POST keeps
 * the first-open timestamp.
 *
 * Fired by the client <MarkNoticeRead> component on detail-page mount — never a
 * server-render side effect, so a Link prefetch can never forge a read. Also
 * the AI app action `mark_notice_read` (ALP-718).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  const memberId = guard.session.user.id;
  const parsedParams = noticeIdParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = parsedParams.data;

  const notice = await getNoticeForMember(memberId, id);
  if (!notice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Double-click / concurrent-tab safety relies on Prisma compiling this
  // compound-unique upsert (no nested creates/relations) to a single native
  // INSERT ... ON CONFLICT DO NOTHING. Keep it that way: adding nested writes
  // would make Prisma fall back to find-then-write and reintroduce a P2002 race
  // on the second concurrent open.
  await prisma.noticeReadReceipt.upsert({
    where: { noticeId_memberId: { noticeId: id, memberId } },
    create: { noticeId: id, memberId },
    // Never overwrite readAt — the first open is authoritative.
    update: {},
  });

  return connectionJson(request, { ok: true }, NOTICE_READ_CONNECTION_SHAPE);
}
