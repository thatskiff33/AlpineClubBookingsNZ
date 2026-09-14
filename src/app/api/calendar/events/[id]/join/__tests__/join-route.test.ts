import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Drive the join endpoint per-test: the acting session user, whether they can
// manage calendar events, and the event the id resolves to.
const mocks = vi.hoisted(() => ({
  sessionUser: null as Record<string, unknown> | null,
  canManage: false,
  event: null as Record<string, unknown> | null,
  buildMeetingJoinUrl: vi.fn(
    async (room: string) =>
      `https://meet.example.org/join?room=${room}&token=jwt`,
  ),
  logAudit: vi.fn(),
  findUnique: vi.fn(async (..._args: unknown[]) => mocks.event),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: vi.fn(async () =>
    mocks.sessionUser
      ? { ok: true, session: { user: mocks.sessionUser } }
      : { ok: false, response: new Response("unauth", { status: 401 }) },
  ),
}));

vi.mock("@/lib/calendar-access", () => ({
  canManageCalendarEvents: vi.fn(async () => mocks.canManage),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { calendarEvent: { findUnique: (...args: unknown[]) => mocks.findUnique(...args) } },
}));

// The link moved to `mirotalk-config` with #2940, where the club's own meeting
// configuration is resolved before the environment is consulted.
vi.mock("@/lib/mirotalk-config", () => ({
  buildMeetingJoinUrl: (room: string) => mocks.buildMeetingJoinUrl(room),
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

import { POST } from "../route";

const params = Promise.resolve({ id: "evt-1" });

function manager() {
  return { id: "admin-1", email: "a@example.com" };
}

function req() {
  return new Request("http://localhost/api/calendar/events/evt-1/join", {
    method: "POST",
  });
}

describe("POST /api/calendar/events/[id]/join", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionUser = null;
    mocks.canManage = false;
    mocks.event = null;
  });
  afterEach(() => vi.restoreAllMocks());

  it("forbids a non-manager (403) and never mints a token", async () => {
    mocks.sessionUser = { id: "member-1", email: "m@example.com" };
    mocks.canManage = false;
    const res = await POST(req() as never, { params });
    expect(res.status).toBe(403);
    expect(mocks.buildMeetingJoinUrl).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns a join URL for a manager on a meeting event with a room (200)", async () => {
    mocks.sessionUser = manager();
    mocks.canManage = true;
    mocks.event = { id: "evt-1", title: "Committee meeting", isMeeting: true, meetingRoom: "room-xyz" };
    const res = await POST(req() as never, { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { joinUrl: string };
    expect(typeof body.joinUrl).toBe("string");
    expect(body.joinUrl).toContain("room-xyz");
    expect(mocks.buildMeetingJoinUrl).toHaveBeenCalledWith("room-xyz");
    // Every mint of the host token is audited.
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "calendar.event.join", targetId: "evt-1" }),
    );
  });

  it("returns 400 for a manager on a non-meeting event", async () => {
    mocks.sessionUser = manager();
    mocks.canManage = true;
    mocks.event = { id: "evt-1", title: "Working bee", isMeeting: false, meetingRoom: null };
    const res = await POST(req() as never, { params });
    expect(res.status).toBe(400);
    expect(mocks.buildMeetingJoinUrl).not.toHaveBeenCalled();
  });

  it("returns 404 for a manager on an unknown id", async () => {
    mocks.sessionUser = manager();
    mocks.canManage = true;
    mocks.event = null;
    const res = await POST(req() as never, { params });
    expect(res.status).toBe(404);
    expect(mocks.buildMeetingJoinUrl).not.toHaveBeenCalled();
  });
});
