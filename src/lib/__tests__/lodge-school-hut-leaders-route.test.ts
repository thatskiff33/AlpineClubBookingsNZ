/**
 * #3819: `/api/admin/lodge-settings/school-hut-leaders` — one lodge's "Who can
 * be hut leader for school bookings". Lodge view to read, lodge edit to write,
 * an active lodge named, the whole four-kind object, and an audit row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  lodgeFindUnique: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolHutLeaderKinds: mocks.load,
  saveSchoolHutLeaderKinds: mocks.save,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));

import { GET, PUT } from "@/app/api/admin/lodge-settings/school-hut-leaders/route";

const STORED = {
  teacherOnBooking: false,
  custodian: true,
  memberOnBooking: true,
  memberStayingSeparately: true,
};
const NEXT = { ...STORED, teacherOnBooking: true, memberStayingSeparately: false };

const URL_BASE = "http://localhost/api/admin/lodge-settings/school-hut-leaders";

function put(body: unknown) {
  return PUT(
    new Request(URL_BASE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.lodgeFindUnique.mockResolvedValue({ active: true });
  mocks.load.mockResolvedValue(STORED);
  mocks.save.mockResolvedValue({ previous: STORED, saved: NEXT });
});

describe("school hut-leader kinds route (#3819)", () => {
  it("reads one lodge's kinds with lodge view access", async () => {
    const res = await GET(new Request(`${URL_BASE}?lodgeId=lodge-2`));
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "lodge", level: "view" } });
    expect(await res.json()).toEqual({ kinds: STORED });
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), "lodge-2");
  });

  it("refuses a read that names no lodge, or an inactive one", async () => {
    expect((await GET(new Request(URL_BASE))).status).toBe(400);
    mocks.lodgeFindUnique.mockResolvedValue({ active: false });
    expect((await GET(new Request(`${URL_BASE}?lodgeId=lodge-2`))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("writes only with lodge edit access: a view-only admin is refused before anything is read or written", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const res = await put({ lodgeId: "lodge-2", kinds: NEXT });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "lodge", level: "edit" } });
    expect(res.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("saves the whole object and audits the before and after", async () => {
    const res = await put({ lodgeId: "lodge-2", kinds: NEXT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kinds: NEXT });
    expect(mocks.save).toHaveBeenCalledWith({
      lodgeId: "lodge-2",
      kinds: NEXT,
      updatedByMemberId: "admin-1",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_SETTINGS_UPDATED",
        entityId: "lodge-2",
        category: "admin",
        metadata: expect.objectContaining({
          previousSchoolHutLeaderKinds: STORED,
          newSchoolHutLeaderKinds: NEXT,
        }),
      }),
    );
  });

  it.each([
    ["a missing kind", { lodgeId: "lodge-2", kinds: { teacherOnBooking: true } }],
    ["an unknown kind", { lodgeId: "lodge-2", kinds: { ...NEXT, everyone: true } }],
    ["a non-boolean", { lodgeId: "lodge-2", kinds: { ...NEXT, custodian: "yes" } }],
    ["no lodge", { kinds: NEXT }],
  ])("refuses %s", async (_label, body) => {
    expect((await put(body)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a write to an inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ active: false });
    expect((await put({ lodgeId: "lodge-2", kinds: NEXT })).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
