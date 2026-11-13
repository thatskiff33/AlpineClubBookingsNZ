import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

/**
 * Fork #118: a lodge-edit admin may edit and delete calendar events, but not an
 * entry a work party manages — the service refuses it and the route answers 409
 * with nothing audited.
 */
const h = vi.hoisted(() => ({
  lodgeEditMatrix: {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "edit",
    content: "none",
    support: "none",
  } satisfies AdminPermissionMatrix,
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: vi.fn(async () => ({
    ok: true,
    session: {
      user: { id: "admin-1", email: "a@example.com", adminPermissionMatrix: h.lodgeEditMatrix },
    },
  })),
}));
vi.mock("@/lib/calendar-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/calendar-service")),
  updateCalendarEvent: h.updateCalendarEvent,
  deleteCalendarEvent: h.deleteCalendarEvent,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));

import { WorkPartyManagedCalendarEventError } from "@/lib/calendar-service";
import { DELETE, PATCH } from "../route";

const params = Promise.resolve({ id: "evt-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.updateCalendarEvent.mockRejectedValue(new WorkPartyManagedCalendarEventError());
  h.deleteCalendarEvent.mockRejectedValue(new WorkPartyManagedCalendarEventError());
});

describe("calendar PATCH/DELETE on a work party's entry", () => {
  it("PATCH answers 409 and audits nothing", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/calendar/events/evt-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Renamed",
          allDay: true,
          startsAt: "2026-07-10T12:00:00.000Z",
          isMeeting: false,
        }),
      }) as never,
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/managed from Work Parties/);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("DELETE answers 409 and audits nothing", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/calendar/events/evt-1?scope=series", {
        method: "DELETE",
      }) as never,
      { params },
    );
    expect(res.status).toBe(409);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("other errors still propagate", async () => {
    h.deleteCalendarEvent.mockRejectedValue(new Error("db down"));
    await expect(
      DELETE(
        new Request("http://localhost/api/calendar/events/evt-1", {
          method: "DELETE",
        }) as never,
        { params },
      ),
    ).rejects.toThrow("db down");
  });
});
