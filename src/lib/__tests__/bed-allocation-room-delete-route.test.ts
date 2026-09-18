import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// DELETE /api/admin/bed-allocation/rooms/[id] follows the bed DELETE route
// pattern: the shared requireBedInventoryWrite guard, an audit entry on
// success, and the shared bedAllocationErrorResponse mapper for typed guard
// errors. The next-auth chain (session-guards / admin-modules) is mocked so the
// real guard wrapper and the real error mapper both run without loading auth.
const { mockRequireAdmin, mockDeleteBedAllocationRoom, mockLogAudit } =
  vi.hoisted(() => ({
    mockRequireAdmin: vi.fn(),
    mockDeleteBedAllocationRoom: vi.fn(),
    mockLogAudit: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({ getLodgeCapacityStatus: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: () => Promise.resolve(true),
}));
// #2352 slice-1 review: these writers now clear the STORED public pages, not just
// the capacity tag. `revalidatePath` needs a static-generation store that no unit
// test has, so the shared helper is stubbed here; its own contents are pinned by
// public-content-invalidation-contract.test.ts.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

vi.mock("@/lib/bed-allocation-rooms", async (importActual) => {
  const actual =
    (await importActual()) as typeof import("@/lib/bed-allocation-rooms");
  return {
    ...actual,
    deleteBedAllocationRoom: (...args: unknown[]) =>
      mockDeleteBedAllocationRoom(...args),
    updateBedAllocationRoom: vi.fn(),
  };
});

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import {
  BedAllocationAdminError,
} from "@/lib/bed-allocation-admin-contract";

function callDelete(id: string) {
  return import("@/app/api/admin/bed-allocation/rooms/[id]/route").then(
    ({ DELETE }) =>
      DELETE(
        new Request(
          `http://localhost/api/admin/bed-allocation/rooms/${id}`,
          { method: "DELETE" },
        ),
        { params: Promise.resolve({ id }) },
      ),
  );
}

describe("DELETE /api/admin/bed-allocation/rooms/[id] (#1674)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
  });

  it("deletes the room, writes an audit entry, and returns it", async () => {
    mockDeleteBedAllocationRoom.mockResolvedValue({
      id: "room-1",
      name: "Bunkroom",
    });

    const res = await callDelete("room-1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.room).toEqual({ id: "room-1", name: "Bunkroom" });
    expect(mockDeleteBedAllocationRoom).toHaveBeenCalledWith({ id: "room-1" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_ROOM_DELETED",
        entityType: "LodgeRoom",
        entityId: "room-1",
        memberId: "admin-1",
      }),
    );
  });

  it("returns the guard response and does not delete when unauthorised", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const res = await callDelete("room-1");

    expect(res.status).toBe(403);
    expect(mockDeleteBedAllocationRoom).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("maps the allocation-history guard error to 409 with the steering message", async () => {
    const message =
      "This room has allocation history and cannot be deleted. Deactivate it instead.";
    mockDeleteBedAllocationRoom.mockRejectedValue(
      new BedAllocationAdminError(message, 409),
    );

    const res = await callDelete("room-1");
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe(message);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("maps an unknown room to 404", async () => {
    mockDeleteBedAllocationRoom.mockRejectedValue(
      new BedAllocationAdminError("Room not found", 404),
    );

    const res = await callDelete("missing");

    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
