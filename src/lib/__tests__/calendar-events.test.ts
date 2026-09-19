import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@prisma/client";

// The MiroTalk join link moved to `mirotalk-config.ts` with #2940, and with it
// the server-only import this file used to need; its own suite covers the link.
import {
  resolveCalendarEventDates,
  serializeCalendarEvent,
} from "@/lib/calendar-events";

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
});
