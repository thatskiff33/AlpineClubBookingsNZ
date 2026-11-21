import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@prisma/client";

// The MiroTalk join link moved to `mirotalk-config.ts` with #2940, and with it
// the server-only import this file used to need; its own suite covers the link.
import {
  resolveCalendarEventDates,
  serializeCalendarEvent,
  whereVisibleCalendarEvent,
} from "@/lib/calendar-events";
import { showsRepeatMarker } from "@/lib/calendar-client";

describe("resolveCalendarEventDates", () => {
  it("returns start with null end for an all-day event", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-01T05:00:00.000Z",
      allDay: true,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.endsAt).toBeNull();
    expect(result.startsAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps a valid timed end", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T19:00:00.000Z",
      endsAt: "2026-08-01T20:30:00.000Z",
      allDay: false,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.endsAt?.toISOString()).toBe("2026-08-01T20:30:00.000Z");
  });

  it("rejects an end before the start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "2026-08-01T20:00:00.000Z",
      endsAt: "2026-08-01T19:00:00.000Z",
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });

  it("rejects an unparseable start", () => {
    const result = resolveCalendarEventDates({
      startsAt: "not-a-date",
      endsAt: null,
      allDay: false,
    });
    expect("error" in result).toBe(true);
  });
});

describe("serializeCalendarEvent", () => {
  const base: CalendarEvent = {
    id: "evt-1",
    title: "Committee meeting",
    location: "Clubrooms",
    details: null,
    allDay: false,
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T20:00:00.000Z"),
    isMeeting: false,
    meetingRoom: null,
    createdById: "member-1",
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    seriesId: null,
    detachedFromSeries: false,
    workPartyEventId: null,
  };

  it("never emits a meeting URL/token field — even for a meeting with a room", () => {
    // SECURITY: the host token must not be served in the list payload. The DTO
    // carries no join URL at all; the token is minted per click on the gated,
    // audited join endpoint instead.
    const dto = serializeCalendarEvent({
      ...base,
      isMeeting: true,
      meetingRoom: "xyz",
    });
    expect(dto).not.toHaveProperty("meetingUrl");
    // No value anywhere in the DTO leaks the room slug or a join link.
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain("xyz");
    expect(serialised).not.toContain("/join");
  });

  it("still exposes isMeeting so the client can render a Join affordance", () => {
    expect(serializeCalendarEvent({ ...base, isMeeting: true }).isMeeting).toBe(
      true,
    );
    expect(serializeCalendarEvent(base).isMeeting).toBe(false);
  });

  it("summarises the recurrence rule for a series event", () => {
    const dto = serializeCalendarEvent({
      ...base,
      seriesId: "series-1",
      series: {
        id: "series-1",
        frequency: "WEEKLY",
        interval: 1,
        until: null,
        count: 5,
        createdById: "member-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(dto.recurrence).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      endMode: "count",
      until: null,
      count: 5,
    });
  });

  it("has a null recurrence for a one-off event", () => {
    expect(serializeCalendarEvent(base).recurrence).toBeNull();
  });

  it("sends no recurrence for a work party's nights, stored as a series only to move together (#5148)", () => {
    const series = {
      id: "series-1",
      frequency: "DAILY" as const,
      interval: 1,
      until: null,
      count: 3,
      createdById: "member-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const dto = serializeCalendarEvent({
      ...base,
      seriesId: "series-1",
      series,
      workPartyEventId: "wp-1",
    });
    expect(dto.recurrence).toBeNull();
    expect(dto.workPartyEventId).toBe("wp-1");
    expect(showsRepeatMarker(dto)).toBe(false);
    expect(
      showsRepeatMarker(
        serializeCalendarEvent({ ...base, seriesId: "series-1", series }),
      ),
    ).toBe(true);
  });
});

describe("whereVisibleCalendarEvent (#5148)", () => {
  const open = { active: true, promoCode: { active: true, archivedAt: null } };
  const onlyOrdinary = { AND: [{ workPartyEventId: null }] };
  const member = { accessRoles: ["USER"], role: "USER", canLogin: true };
  const on = { workParties: true };

  it("shows a member ordinary events, and a work party's only while it is open", () => {
    expect(
      whereVisibleCalendarEvent(
        { startsAt: { lte: new Date(0) } },
        { modules: on, viewer: member },
      ),
    ).toEqual({
      startsAt: { lte: new Date(0) },
      AND: [{ OR: [{ workPartyEventId: null }, { workPartyEvent: open }] }],
    });
  });

  // Owner decision of 20 Nov 2026: work party entries are shown to members only.
  const nonMembers: Array<[string, Parameters<typeof whereVisibleCalendarEvent>[1]["viewer"]]> = [
    ["a non-member login", { accessRoles: [], role: "NON_MEMBER", canLogin: true }],
    ["a lodge kiosk", { accessRoles: ["LODGE"], role: "LODGE", canLogin: true }],
    ["an admin-only account", { accessRoles: ["ADMIN"], role: "ADMIN", canLogin: true }],
    ["an organisation account", { accessRoles: ["ORG"], role: "USER", canLogin: true }],
    ["a school login that also holds USER", { accessRoles: ["USER"], role: "SCHOOL", canLogin: true }],
    ["a member whose login is disabled", { ...member, canLogin: false }],
  ];
  it.each(nonMembers)("shows %s ordinary events only", (_label, viewer) => {
    expect(whereVisibleCalendarEvent({}, { modules: on, viewer })).toEqual(onlyOrdinary);
  });

  it("hides every work party's entries from a member while the Work parties module is off", () => {
    expect(
      whereVisibleCalendarEvent({}, { modules: { workParties: false }, viewer: member }),
    ).toEqual(onlyOrdinary);
  });

  it("keeps a caller's own OR and AND intact rather than overwriting them", () => {
    const callerOr = [{ endsAt: null }, { endsAt: { gte: new Date(0) } }];
    const where = whereVisibleCalendarEvent(
      { OR: callerOr, AND: { title: "x" } },
      { modules: on, viewer: member },
    );
    expect(where.OR).toEqual(callerOr);
    expect(where.AND).toEqual([
      { title: "x" },
      { OR: [{ workPartyEventId: null }, { workPartyEvent: open }] },
    ]);
  });
});
