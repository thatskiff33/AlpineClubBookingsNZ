import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { addWorkPartyToCalendar } from "@/lib/work-party-calendar";

/**
 * "Add to calendar" (fork #118): put an existing work party on the Events
 * Calendar. New work parties are added automatically; this is for one made
 * before the feature, or while the calendar module was off, and so is an
 * explicit officer choice rather than a backfill — the club may already have
 * typed it on the calendar by hand.
 *
 * Lodge edit, like every other work-party write. Refused while the Events
 * Calendar module is off. Pressed again on a work party that is already on the
 * calendar, it regenerates the same entries rather than adding a second set.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const modules = await loadEffectiveModuleFlags();
  if (!modules.eventsCalendar) {
    return NextResponse.json(
      { error: "The Events Calendar module is off." },
      { status: 409 }
    );
  }

  const workParty = await prisma.workPartyEvent.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!workParty) {
    return NextResponse.json(
      { error: "Work party event not found" },
      { status: 404 }
    );
  }

  const entryCount = await addWorkPartyToCalendar(
    workParty.id,
    session.user.id
  );

  logAudit({
    action: "workparty.calendar.add",
    memberId: session.user.id,
    targetId: workParty.id,
    entityType: "WorkPartyEvent",
    entityId: workParty.id,
    category: "admin",
    outcome: "success",
    summary: "Work party added to the calendar",
    details: `Added work party event to the calendar: ${workParty.name}`,
    metadata: { name: workParty.name, entryCount },
  });

  return NextResponse.json({ entryCount });
}
