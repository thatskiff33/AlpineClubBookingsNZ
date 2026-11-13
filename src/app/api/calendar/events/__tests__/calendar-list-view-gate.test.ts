import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/calendar/events` view gate (#2241).
 *
 * The events list is what actually serves the calendar, so hiding the PAGE from
 * organisation ("ORG") accounts without hiding this route would leave the data
 * one fetch away. It answers 404 — the same thing the whole `/api/calendar`
 * prefix answers when the `eventsCalendar` module is off — so an organisation
 * account cannot tell the two states apart.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  sessionUser: null as Record<string, unknown> | null,
  calendarEventFindMany: vi.fn(),
  committeeAssignmentFindFirst: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: vi.fn(async () =>
    mocks.sessionUser
      ? { ok: true, session: { user: mocks.sessionUser } }
      : { ok: false, response: new Response("unauth", { status: 401 }) },
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    calendarEvent: { findMany: mocks.calendarEventFindMany },
    committeeAssignment: { findFirst: mocks.committeeAssignmentFindFirst },
  },
}));

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET } from "../route";

function listReq() {
  return new Request("http://localhost/api/calendar/events") as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calendarEventFindMany.mockResolvedValue([]);
  mocks.committeeAssignmentFindFirst.mockResolvedValue(null);
  mocks.sessionUser = { id: "member-1", role: "USER", accessRoles: ["USER"] };
});

describe("GET /api/calendar/events view gate", () => {
  it("hides an inactive work party's entries (fork #118)", async () => {
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const where = mocks.calendarEventFindMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({
      OR: [
        { workPartyEventId: null },
        {
          workPartyEvent: {
            active: true,
            promoCode: { active: true, archivedAt: null },
          },
        },
      ],
    });
  });

  it("404s an organisation account and never reads the events table", async () => {
    mocks.sessionUser = { id: "org-1", role: "SCHOOL", accessRoles: ["ORG"] };

    const res = await GET(listReq());

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.calendarEventFindMany).not.toHaveBeenCalled();
  });

  it("404s a legacy SCHOOL account whose ORG token was cleared", async () => {
    mocks.sessionUser = { id: "org-2", role: "SCHOOL", accessRoles: [] };

    const res = await GET(listReq());

    expect(res.status).toBe(404);
    expect(mocks.calendarEventFindMany).not.toHaveBeenCalled();
  });

  it("serves an ordinary member as before", async () => {
    const res = await GET(listReq());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ events: [], canManage: false });
    expect(mocks.calendarEventFindMany).toHaveBeenCalledTimes(1);
  });
});
