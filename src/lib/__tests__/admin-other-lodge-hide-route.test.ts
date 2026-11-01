import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hiding an Other lodges row (#58, owner decision): only a row the central
 * server does not list (unkeyed after a whole download keyed the registry),
 * whatever cites it — hidden, never removed — by an administrator with lodge
 * edit, audited by id and name only.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
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
    otherLodge: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
    auditLog: { create: mocks.auditLogCreate },
  },
}));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));

import { POST } from "@/app/api/admin/other-lodges/[id]/hide/route";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] } };
const memberSession = { user: { id: "member-1", role: "USER", accessRoles: ["USER"] } };
const UPDATED_AT = new Date("2026-01-01T00:00:00.000Z");

function row(over: Record<string, unknown> = {}) {
  return {
    id: "ol-old",
    name: "Ruapehu Lodge (old)",
    centralId: null,
    hiddenAt: null,
    updatedAt: UPDATED_AT,
    ...over,
  };
}

const call = (id = "ol-old") =>
  POST(new Request(`https://site.test/api/admin/other-lodges/${id}/hide`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesKeyedAt: "2026-10-14T00:00:00.000Z" });
  mocks.findUnique.mockResolvedValue(row());
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.auditLogCreate.mockResolvedValue({});
});

describe("POST /api/admin/other-lodges/:id/hide (#58)", () => {
  it("HIDES an unlisted lodge, guarded and without moving updatedAt, and audits it by id and name only", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    const [args] = mocks.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: "ol-old", centralId: null, hiddenAt: null });
    expect(args.data.hiddenAt).toBeInstanceOf(Date);
    expect(args.data.updatedAt).toBe(UPDATED_AT);
    const [{ data }] = mocks.auditLogCreate.mock.calls[0];
    expect(data.action).toBe("OTHER_LODGE_HIDDEN");
    expect(data.metadata).toEqual({ hiddenOtherLodge: { id: "ol-old", name: "Ruapehu Lodge (old)" } });
  });

  it("never copies a booking officer's contact into the audit row", async () => {
    mocks.findUnique.mockResolvedValue({
      ...row(),
      bookingOfficerPhone: "+64 21 000 0000",
      bookingOfficerEmail: "officer@club.test",
    });
    await call();
    const serialized = JSON.stringify(mocks.auditLogCreate.mock.calls[0][0].data);
    expect(serialized).not.toContain("+64 21 000 0000");
    expect(serialized).not.toContain("officer@club.test");
  });

  it("refuses a lodge the central server still lists", async () => {
    mocks.findUnique.mockResolvedValue(row({ centralId: "c-1" }));
    const response = await call();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/only a lodge marked .not found/i);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses everything before a whole download has keyed the registry", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesKeyedAt: null });
    expect((await call()).status).toBe(409);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when a download keyed it meanwhile (the guarded write matches nothing)", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect((await call()).status).toBe(409);
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("404 for an unknown or already hidden lodge", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await call("nope")).status).toBe(404);
    mocks.findUnique.mockResolvedValue(row({ hiddenAt: new Date() }));
    expect((await call()).status).toBe(404);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a member without lodge edit", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    expect((await call()).status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
