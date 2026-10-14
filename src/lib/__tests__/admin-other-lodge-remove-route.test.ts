import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Removing an Other lodges row by hand (#58): only a row the central server
 * does not list (unkeyed after the registry was keyed by a whole download) and
 * that nothing here refers to, by an administrator with lodge edit, audited.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  auditLogCreate: vi.fn(),
  loadServerNzSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    otherLodge: { findUnique: mocks.findUnique, deleteMany: mocks.deleteMany },
    auditLog: { create: mocks.auditLogCreate },
  },
}));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));

import { POST } from "@/app/api/admin/other-lodges/[id]/remove/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] } };
const memberSession = { user: { id: "member-1", role: "USER", accessRoles: ["USER"] } };

function row(over: Record<string, unknown> = {}) {
  return {
    id: "ol-old",
    name: "Ruapehu Lodge (old)",
    centralId: null,
    location: null,
    bookingOfficerName: null,
    bookingOfficerEmail: null,
    bookingOfficerPhone: null,
    bedCapacity: null,
    amenities: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    _count: { bookings: 0, bookingRequests: 0 },
    ...over,
  };
}

const call = (id = "ol-old") =>
  POST(new Request(`https://site.test/api/admin/other-lodges/${id}/remove`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesKeyedAt: "2026-10-14T00:00:00.000Z" });
  mocks.findUnique.mockResolvedValue(row());
  mocks.deleteMany.mockResolvedValue({ count: 1 });
  mocks.auditLogCreate.mockResolvedValue({});
});

describe("POST /api/admin/other-lodges/:id/remove (#58)", () => {
  it("removes an unlisted, unreferenced lodge, guarded on its central id still being null, and audits it", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "ol-old", centralId: null } });
    const [{ data }] = mocks.auditLogCreate.mock.calls[0];
    expect(data.action).toBe("OTHER_LODGE_REMOVED");
    expect(data.metadata.removedOtherLodge).toMatchObject({ id: "ol-old", name: "Ruapehu Lodge (old)" });
  });

  it("refuses a lodge the central server still lists", async () => {
    mocks.findUnique.mockResolvedValue(row({ centralId: "c-1" }));
    const response = await call();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/only a lodge marked .not found/i);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses everything before a whole download has keyed the registry", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesKeyedAt: null });
    expect((await call()).status).toBe(409);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a booking", { bookings: 1, bookingRequests: 0 }],
    ["a booking request", { bookings: 0, bookingRequests: 1 }],
  ])("refuses a lodge %s refers to", async (_label, counts) => {
    mocks.findUnique.mockResolvedValue(row({ _count: counts }));
    const response = await call();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/still refer to it/i);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses when a booking cites it between the check and the delete (foreign key)", async () => {
    mocks.deleteMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
        code: "P2003",
        clientVersion: "test",
      }),
    );
    const response = await call();
    expect(response.status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses when a download keyed it meanwhile (the guarded delete matches nothing)", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call()).status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("404 for an unknown lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await call("nope")).status).toBe(404);
  });

  it("refuses a member without lodge edit", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    expect((await call()).status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
