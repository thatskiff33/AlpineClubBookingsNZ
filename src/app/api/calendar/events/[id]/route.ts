import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { canEditCalendarEvents } from "@/lib/calendar-access";
import {
  updateCalendarEvent,
  deleteCalendarEvent,
  WorkPartyManagedCalendarEventError,
} from "@/lib/calendar-service";
import {
  calendarEditScopeSchema,
  calendarEventInputSchema,
  resolveCalendarEventDates,
  serializeCalendarEvent,
} from "@/lib/calendar-events";

/**
 * Fork #118: an entry a work party manages is changed from Work Parties only.
 * 409 rather than 403 — the caller may edit calendar events, just not this one.
 */
async function refusingWorkPartyManaged<T>(
  mutation: () => Promise<T>,
): Promise<T | NextResponse> {
  try {
    return await mutation();
  } catch (error) {
    if (error instanceof WorkPartyManagedCalendarEventError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

/**
 * Update a calendar event. Restricted to lodge-edit admins ONLY — committee
 * members are create-only and may not edit existing events (see
 * src/lib/calendar-access.ts and docs/guides/calendar.md). `scope`
 * ("single" | "series", default "single") selects whether a recurring event's
 * edit applies to just this occurrence or the whole series — see
 * src/lib/calendar-service.ts for the propagate-vs-regenerate semantics.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  if (!canEditCalendarEvents(guard.session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = calendarEventInputSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const scope = calendarEditScopeSchema
    .catch("single")
    .parse((json.body as { scope?: unknown })?.scope);

  const dates = resolveCalendarEventDates(parsed.data);
  if ("error" in dates) {
    return NextResponse.json({ error: dates.error }, { status: 400 });
  }

  const recurrence = parsed.data.recurrence ?? null;
  if (recurrence) {
    if (recurrence.endMode === "until" && !recurrence.until) {
      return NextResponse.json(
        { error: "An end date is required for a recurrence that ends on a date." },
        { status: 400 },
      );
    }
    if (recurrence.endMode === "count" && !recurrence.count) {
      return NextResponse.json(
        { error: "A number of occurrences is required for this recurrence." },
        { status: 400 },
      );
    }
  }

  const result = await refusingWorkPartyManaged(() =>
    updateCalendarEvent(
      id,
      {
        title: parsed.data.title,
        location: parsed.data.location?.trim() || null,
        details: parsed.data.details?.trim() || null,
        allDay: parsed.data.allDay,
        isMeeting: parsed.data.isMeeting,
        startsAt: dates.startsAt,
        endsAt: dates.endsAt,
        recurrence,
      },
      scope,
      guard.session.user.id,
    ),
  );

  if (result instanceof NextResponse) return result;
  if (!result) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  logAudit({
    action: "calendar.event.update",
    memberId: guard.session.user.id,
    targetId: result.anchor.id,
    entityType: "CalendarEvent",
    category: "admin",
    outcome: "success",
    summary:
      result.scope === "series"
        ? "Calendar event series updated"
        : "Calendar event updated",
    details: `Updated calendar event: ${result.anchor.title}`,
    metadata: {
      title: result.anchor.title,
      scope: result.scope,
      startsAt: result.anchor.startsAt.toISOString(),
      isMeeting: result.anchor.isMeeting,
    },
  });

  return NextResponse.json({
    event: serializeCalendarEvent(result.anchor),
    scope: result.scope,
  });
}

/**
 * Delete a calendar event. Restricted to lodge-edit admins ONLY — committee
 * members are create-only and may not delete events, so a non-admin can never
 * wipe an admin's event or `?scope=series` whole series (see
 * src/lib/calendar-access.ts and docs/guides/calendar.md). `?scope=series`
 * deletes every occurrence of the series; the default ("single") deletes just
 * this occurrence. For `?scope=series`, `?exceptions=keep` (default) orphans any
 * detached per-occurrence exceptions into standalone events, while
 * `?exceptions=delete` removes them along with the rest of the series.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  if (!canEditCalendarEvents(guard.session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const searchParams = new URL(req.url).searchParams;
  const scope = calendarEditScopeSchema
    .catch("single")
    .parse(searchParams.get("scope"));
  // What a whole-series delete does with detached exceptions; default "keep".
  const exceptionMode =
    searchParams.get("exceptions") === "delete" ? "delete" : "keep";

  const result = await refusingWorkPartyManaged(() =>
    deleteCalendarEvent(id, scope, exceptionMode),
  );
  if (result instanceof NextResponse) return result;
  if (!result) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  logAudit({
    action: "calendar.event.delete",
    memberId: guard.session.user.id,
    targetId: id,
    entityType: "CalendarEvent",
    category: "admin",
    outcome: "success",
    summary:
      result.scope === "series"
        ? "Calendar event series deleted"
        : "Calendar event deleted",
    details: `Deleted calendar event: ${result.title}`,
    metadata: {
      title: result.title,
      scope: result.scope,
      deletedCount: result.deletedCount,
      exceptions: exceptionMode,
    },
  });

  return NextResponse.json({ success: true, scope: result.scope });
}
