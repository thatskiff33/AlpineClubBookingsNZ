/**
 * PATCH /api/admin/bookings/[id]/guest-dietary (#3029, `INV-PRIV-022`,
 * `INV-MOD-060`): the one write of a stored booking value.
 *
 * `bookings:edit` (route guard AND a database-verified grant), refused while the
 * field is OFF, one row matched on booking + guest, the shared 500 limit, an
 * audit row that says the value changed and never what it is, and no write to
 * the member profile, pricing, email or Xero.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  settingsFindUnique: vi.fn(),
  bookingGuestFindFirst: vi.fn(),
  bookingGuestUpdateMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => {
  const client = {
    member: { findUnique: mocks.memberFindUnique, update: mocks.memberUpdate },
    memberFieldsSettings: { findUnique: mocks.settingsFindUnique },
    bookingGuest: {
      findFirst: mocks.bookingGuestFindFirst,
      updateMany: mocks.bookingGuestUpdateMany,
    },
    auditLog: { create: mocks.auditLogCreate },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PATCH } from "@/app/api/admin/bookings/[id]/guest-dietary/route";
import { routeParams } from "@/lib/__tests__/helpers/requests";

const VALUE = "Anaphylactic to shellfish";

function patch(body: unknown, bookingId = "bk-1") {
  return PATCH(
    new Request(`http://localhost/api/admin/bookings/${bookingId}/guest-dietary`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    routeParams({ id: bookingId }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  mocks.memberFindUnique.mockResolvedValue({
    active: true,
    canLogin: true,
    accessRoles: [{ role: "ADMIN_BOOKINGS", roleDefinition: null }],
  });
  mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: true });
  mocks.bookingGuestFindFirst.mockResolvedValue({ dietaryRequirements: null });
  mocks.bookingGuestUpdateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH guest-dietary (INV-PRIV-022, INV-MOD-060)", () => {
  it("asks requireAdmin for bookings:edit", async () => {
    await patch({ guestId: "g1", dietaryRequirements: VALUE });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("saves one row on booking + guest, audits without the value, and never touches the profile", async () => {
    const res = await patch({ guestId: "g1", dietaryRequirements: `  ${VALUE}  ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guestId: "g1", dietaryRequirements: VALUE });
    expect(mocks.bookingGuestUpdateMany).toHaveBeenCalledWith({
      where: { id: "g1", bookingId: "bk-1", booking: { deletedAt: null } },
      data: { dietaryRequirements: VALUE },
    });
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    const audit = JSON.stringify(mocks.auditLogCreate.mock.calls[0]![0]);
    expect(audit).not.toContain("shellfish");
    expect(audit).toContain("booking.guest_dietary.updated");
    expect(audit).toContain('"category":"booking"');
  });

  it("records a clear as a clear, and writes no audit row when nothing changed", async () => {
    mocks.bookingGuestFindFirst.mockResolvedValue({ dietaryRequirements: VALUE });
    await patch({ guestId: "g1", dietaryRequirements: "  " });
    expect(JSON.stringify(mocks.auditLogCreate.mock.calls[0]![0])).toContain(
      "booking.guest_dietary.cleared",
    );
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      canLogin: true,
      accessRoles: [{ role: "ADMIN_BOOKINGS", roleDefinition: null }],
    });
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: true });
    mocks.bookingGuestFindFirst.mockResolvedValue({ dietaryRequirements: VALUE });
    mocks.bookingGuestUpdateMany.mockResolvedValue({ count: 1 });
    await patch({ guestId: "g1", dietaryRequirements: VALUE });
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses while the field is OFF, without touching a stored value", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ showDietaryRequirements: false });
    const res = await patch({ guestId: "g1", dietaryRequirements: VALUE });
    expect(res.status).toBe(409);
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an actor whose database roles lack bookings:edit, even past the route guard", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      active: true,
      canLogin: true,
      accessRoles: [{ role: "ADMIN_READONLY", roleDefinition: null }],
    });
    const res = await patch({ guestId: "g1", dietaryRequirements: VALUE });
    expect(res.status).toBe(403);
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
  });

  it("404s a guest of another booking or a deleted booking", async () => {
    mocks.bookingGuestFindFirst.mockResolvedValue(null);
    const res = await patch({ guestId: "g-other", dietaryRequirements: VALUE });
    expect(res.status).toBe(404);
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
  });

  it("400s over 500 characters, a missing value and an unknown key", async () => {
    for (const body of [
      { guestId: "g1", dietaryRequirements: "x".repeat(501) },
      { guestId: "g1" },
      { guestId: "g1", dietaryRequirements: VALUE, memberId: "m-1" },
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(mocks.bookingGuestUpdateMany).not.toHaveBeenCalled();
  });
});
