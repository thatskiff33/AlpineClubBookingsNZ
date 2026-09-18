import { NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { canManageCalendarEvents } from "@/lib/calendar-access";
import { buildMeetingJoinUrl } from "@/lib/mirotalk-config";

/**
 * Mint a MiroTalk join URL for a meeting event, per click.
 *
 * The join token embeds shared host credentials (presenter=true), so it must
 * NOT be served in the list/serialise payload every member receives. Instead it
 * is minted here on demand and gated to calendar MANAGERS (committee members and
 * lodge-edit admins — the same authority that may create events), and every mint
 * is audited so the host-token issue leaves a trail. Ordinary members can never
 * obtain the token.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  if (!(await canManageCalendarEvents(guard.session.user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const event = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  if (!event.isMeeting || !event.meetingRoom) {
    return NextResponse.json(
      { error: "This event has no meeting." },
      { status: 400 },
    );
  }

  // Awaited since #2940: the link is built from the club's own meeting
  // configuration (Admin -> Integrations) before falling back to the
  // environment, so resolving it is a read rather than a lookup in memory.
  const joinUrl = await buildMeetingJoinUrl(event.meetingRoom);

  // Audited AFTER the link exists, and recording WHERE it went. The row used to
  // name only the event, so redirecting the meeting-server address, waiting for
  // a click and restoring it left nothing anywhere saying which host received
  // the token. The ORIGIN only — never the URL, which carries the token itself —
  // and an address that will not parse is recorded as such rather than dropped.
  let meetingHost: string;
  try {
    meetingHost = new URL(joinUrl).origin;
  } catch {
    meetingHost = "(unparseable)";
  }
  logAudit({
    action: "calendar.event.join",
    memberId: guard.session.user.id,
    targetId: event.id,
    entityType: "CalendarEvent",
    category: "admin",
    outcome: "success",
    summary: "Calendar meeting join link minted",
    details: `Minted MiroTalk join link for: ${event.title} (meeting server ${meetingHost})`,
    metadata: { title: event.title, meetingHost },
  });

  return NextResponse.json({ joinUrl });
}
