import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { formatDateOnly } from "@/lib/date-only";
import {
  workPartyEventDatesError,
  workPartyEventSchema,
} from "@/lib/work-party";
import { updateWorkPartyWithCalendar } from "@/lib/work-party-calendar";
import { removeWorkPartyCalendarEventsInTransaction } from "@/lib/calendar-work-party-entries";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const event = await prisma.workPartyEvent.findUnique({
    where: { id },
    include: {
      promoCode: {
        select: {
          id: true,
          redemptions: {
            select: {
              id: true,
              discountCents: true,
              createdAt: true,
              booking: {
                select: {
                  id: true,
                  checkIn: true,
                  checkOut: true,
                  status: true,
                  finalPriceCents: true,
                },
              },
              member: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });

  if (!event) {
    return NextResponse.json({ error: "Work party event not found" }, { status: 404 });
  }

  const { promoCode, ...eventFields } = event;
  return NextResponse.json({
    event: eventFields,
    attendingBookings: promoCode.redemptions,
    totalDiscountCents: promoCode.redemptions.reduce(
      (sum, redemption) => sum + redemption.discountCents,
      0
    ),
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const existing = await prisma.workPartyEvent.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Work party event not found" }, { status: 404 });
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = workPartyEventSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // #5148: the night cap binds only a change of dates, so a work party saved
  // longer before the cap can still be deactivated or re-described.
  const datesError = workPartyEventDatesError(parsed.data, existing);
  if (datesError) {
    return NextResponse.json({ error: datesError }, { status: 400 });
  }

  // Deactivating only stops new applications; existing redemptions and
  // bookings are never altered.
  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { active: true },
    });
    if (!lodge?.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      );
    }
  }

  // #5148: a work party that has calendar entries has them rewritten in the
  // same transaction as the save, so they never show its old dates.
  // Deactivated, they stay but the calendar hides them.
  const event = await updateWorkPartyWithCalendar(
    id,
    {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      discountPercent: parsed.data.discountPercent,
      active: parsed.data.active,
      lodgeId: parsed.data.lodgeId ?? null,
    },
    session.user.id
  );

  logAudit({
    action: "workparty.update",
    memberId: session.user.id,
    targetId: event.id,
    entityType: "WorkPartyEvent",
    entityId: event.id,
    category: "admin",
    outcome: "success",
    summary: "Work party event updated",
    details: `Updated work party event: ${event.name}`,
    metadata: {
      name: event.name,
      startDate: formatDateOnly(event.startDate),
      endDate: formatDateOnly(event.endDate),
      discountPercent: event.discountPercent,
      active: event.active,
      deactivated: existing.active && !event.active,
    },
  });

  return NextResponse.json({ event });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const existing = await prisma.workPartyEvent.findUnique({
    where: { id },
    include: {
      promoCode: { select: { id: true, redemptions: { select: { id: true } } } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Work party event not found" }, { status: 404 });
  }

  if (existing.promoCode.redemptions.length > 0) {
    return NextResponse.json(
      {
        error:
          "This event has attending bookings and cannot be deleted. Deactivate it instead.",
      },
      { status: 400 }
    );
  }

  await prisma.$transaction(async (tx) => {
    // #5148: its calendar entries and their series row go in the same
    // transaction, so a delete that fails leaves the calendar untouched.
    await removeWorkPartyCalendarEventsInTransaction(tx, id);
    await tx.workPartyEvent.delete({ where: { id } });
    await tx.promoCode.delete({ where: { id: existing.promoCodeId } });
  });

  logAudit({
    action: "workparty.delete",
    memberId: session.user.id,
    targetId: id,
    entityType: "WorkPartyEvent",
    entityId: id,
    category: "admin",
    outcome: "success",
    summary: "Work party event deleted",
    details: `Deleted work party event: ${existing.name}`,
    metadata: { name: existing.name },
  });

  return NextResponse.json({ success: true });
}
