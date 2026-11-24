/**
 * ALP-722 (`INV-MCP-006`): the club calendar's officer actions an officer's AI
 * app connection may run: creating, changing and deleting events. Each route
 * answers the browser as before; the connection gets exactly the action's
 * `returns` fields (`expectActionContract`). Every handler runs twice
 * (connection, then browser), so the service mocks answer both runs.
 *
 * Also pinned: a connection creates events on the Lodge edit leg alone, never
 * on a committee seat (record-derived reach, which a connection never
 * carries), and an unknown edit or delete scope is refused rather than read as
 * one occurrence.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  committeeSeat: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireActiveSession: h.requireActiveSession }));
vi.mock("@/lib/prisma", () => ({ prisma: { committeeAssignment: { findFirst: h.committeeSeat } } }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/calendar-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/calendar-service")),
  createCalendarEvent: h.createCalendarEvent,
  updateCalendarEvent: h.updateCalendarEvent,
  deleteCalendarEvent: h.deleteCalendarEvent,
}));

import { POST as createEvent } from "@/app/api/calendar/events/route";
import { DELETE as deleteEvent, PATCH as updateEvent } from "@/app/api/calendar/events/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { memberSession } from "@/lib/__tests__/helpers/sessions";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

// A repeating event, so the series rule is filled and checked.
const SERIES_EVENT = {
  id: "evt-1",
  title: "Committee meeting",
  location: "Clubrooms",
  details: "Agenda to follow",
  allDay: false,
  startsAt: new Date("2026-07-14T07:30:00.000Z"),
  endsAt: new Date("2026-07-14T09:00:00.000Z"),
  isMeeting: true,
  meetingRoom: "room-secret-slug",
  seriesId: "series-1",
  detachedFromSeries: false,
  workPartyEventId: null,
  createdById: "officer-1",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  series: {
    id: "series-1",
    frequency: "WEEKLY",
    interval: 1,
    until: null,
    count: 6,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  },
};

const EVENT_ARGS = {
  title: "Committee meeting",
  location: "Clubrooms",
  details: "Agenda to follow",
  allDay: false,
  startsAt: "2026-07-14T07:30:00.000Z",
  endsAt: "2026-07-14T09:00:00.000Z",
  isMeeting: true,
  recurrence: { frequency: "WEEKLY", interval: 1, endMode: "count", count: 6 },
};

const SERIALIZED_EVENT = {
  id: "evt-1",
  title: "Committee meeting",
  location: "Clubrooms",
  details: "Agenda to follow",
  allDay: false,
  startsAt: "2026-07-14T07:30:00.000Z",
  endsAt: "2026-07-14T09:00:00.000Z",
  isMeeting: true,
  seriesId: "series-1",
  detachedFromSeries: false,
  recurrence: { frequency: "WEEKLY", interval: 1, endMode: "count", until: null, count: 6 },
  workPartyEventId: null,
};

function signIn(session: ReturnType<typeof officerMemberSession>) {
  h.requireActiveSession.mockResolvedValue({ ok: true, session });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn(officerMemberSession());
  h.committeeSeat.mockResolvedValue(null);
  h.createCalendarEvent.mockResolvedValue(SERIES_EVENT);
  h.updateCalendarEvent.mockResolvedValue({ anchor: SERIES_EVENT, scope: "series" });
  h.deleteCalendarEvent.mockResolvedValue({ title: SERIES_EVENT.title, scope: "series", deletedCount: 6 });
});

describe("club calendar officer actions (ALP-722)", () => {
  it("create_calendar_event answers the saved event, as the browser always was", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "create_calendar_event",
      handler: createEvent,
      args: EVENT_ARGS,
    });
    expect(connection).toEqual({ event: SERIALIZED_EVENT });
    expect(browser).toEqual({ event: SERIALIZED_EVENT });
    // The meeting room, which builds the host link, is never in the answer.
    expect(JSON.stringify(connection)).not.toContain("room-secret-slug");
  });

  it("update_calendar_event passes the scope through and answers the event and scope", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "update_calendar_event",
      handler: updateEvent,
      args: { id: "evt-1", ...EVENT_ARGS, scope: "series" },
    });
    expect(h.updateCalendarEvent).toHaveBeenCalledWith("evt-1", expect.any(Object), "series", "officer-1");
    expect(connection).toEqual({ event: SERIALIZED_EVENT, scope: "series" });
    expect(browser).toEqual(connection);
  });

  it("delete_calendar_event passes scope and exceptions through and answers success and scope", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "delete_calendar_event",
      handler: deleteEvent,
      args: { id: "evt-1", scope: "series", exceptions: "delete" },
    });
    expect(h.deleteCalendarEvent).toHaveBeenCalledWith("evt-1", "series", "delete");
    expect(connection).toEqual({ success: true, scope: "series" });
    expect(browser).toEqual(connection);
  });

  it("defaults an edit and a delete to one occurrence, keeping edited occurrences", async () => {
    const { request } = patch({ ...EVENT_ARGS });
    expect((await updateEvent(request, { params: Promise.resolve({ id: "evt-1" }) })).status).toBe(200);
    expect(h.updateCalendarEvent).toHaveBeenCalledWith("evt-1", expect.any(Object), "single", "officer-1");

    const deleted = await deleteEvent(new NextRequest("https://club.example.test/api/calendar/events/evt-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "evt-1" }),
    });
    expect(deleted.status).toBe(200);
    expect(h.deleteCalendarEvent).toHaveBeenCalledWith("evt-1", "single", "keep");
  });

  it("refuses an unknown scope instead of changing one occurrence", async () => {
    const { request } = patch({ ...EVENT_ARGS, scope: "everything" });
    expect((await updateEvent(request, { params: Promise.resolve({ id: "evt-1" }) })).status).toBe(400);
    const deleted = await deleteEvent(
      new NextRequest("https://club.example.test/api/calendar/events/evt-1?scope=series&exceptions=maybe", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "evt-1" }) },
    );
    expect(deleted.status).toBe(400);
    expect(h.updateCalendarEvent).not.toHaveBeenCalled();
    expect(h.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("lets a committee member without Lodge edit create on the website but not through a connection", async () => {
    signIn(memberSession({ id: "committee-1" }));
    h.committeeSeat.mockResolvedValue({ id: "seat-1" });

    const browser = await createEvent(create(false), {} as never);
    expect(browser.status).toBe(201);

    h.createCalendarEvent.mockClear();
    const connection = await createEvent(create(true), {} as never);
    expect(connection.status).toBe(403);
    expect(h.createCalendarEvent).not.toHaveBeenCalled();
  });
});

function patch(body: Record<string, unknown>) {
  return {
    request: new NextRequest("https://club.example.test/api/calendar/events/evt-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

function create(viaConnection: boolean) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (viaConnection) headers[MCP_PRINCIPAL_HEADER] = "contract-test-principal";
  return new NextRequest("https://club.example.test/api/calendar/events", {
    method: "POST",
    headers,
    body: JSON.stringify(EVENT_ARGS),
  });
}
