import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireAdmin,
  mockModuleEnabled,
  mockMoveBedAllocationsSameDate,
  mockApplyBedAllocationMove,
  mockCreateAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockModuleEnabled: vi.fn(),
  mockMoveBedAllocationsSameDate: vi.fn(),
  mockApplyBedAllocationMove: vi.fn(),
  mockCreateAuditLog: vi.fn(),
}));

// Arguments are FORWARDED, not dropped: the permission descriptor the route
// asks for is the only observable difference between the read guard and the
// write guard, so a mock that swallowed it would let `requireBedAllocationRead`
// be substituted for `requireBedAllocationWrite` on the apply route with every
// test still green.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: () => mockModuleEnabled(),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));
vi.mock("@/lib/bed-allocation-manual-writes", async () => {
  const actual = (await vi.importActual("@/lib/bed-allocation-manual-writes")) as typeof import("@/lib/bed-allocation-manual-writes");
  return {
    ...actual,
    moveBedAllocationsSameDate: (...args: unknown[]) =>
      mockMoveBedAllocationsSameDate(...args),
  };
});
vi.mock("@/lib/bed-allocation-move", async () => {
  const actual = (await vi.importActual("@/lib/bed-allocation-move")) as typeof import("@/lib/bed-allocation-move");
  return {
    ...actual,
    applyBedAllocationMove: (...args: unknown[]) =>
      mockApplyBedAllocationMove(...args),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

function patch(body: unknown) {
  return import("@/app/api/admin/bed-allocation/allocations/route").then(
    ({ PATCH }) =>
      PATCH(
        new Request("http://localhost/api/admin/bed-allocation/allocations", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
  );
}

describe("PATCH /api/admin/bed-allocation/allocations (#2366)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockModuleEnabled.mockResolvedValue(true);
    mockMoveBedAllocationsSameDate.mockResolvedValue({
      noop: false,
      promotedPartners: [],
      allocations: [
        {
          id: "allocation-1",
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-2",
          bedId: "bed-2",
          stayDate: new Date("2026-07-01T00:00:00.000Z"),
          source: "MANUAL",
        },
      ],
    });
    mockApplyBedAllocationMove.mockResolvedValue({
      noop: false,
      movedRowCount: 1,
      promotedRowCount: 0,
      affectedNights: ["2026-07-01"],
    });
  });

  it("passes only allocation ids, destination bed and actor to the atomic service", async () => {
    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      noop: false,
      allocations: [
        {
          id: "allocation-1",
          bedId: "bed-2",
          stayDate: "2026-07-01",
        },
      ],
    });
    expect(mockMoveBedAllocationsSameDate).toHaveBeenCalledWith({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
      actorMemberId: "admin-1",
    });
    // The service writes the move, promotion and audit inside one transaction.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("enforces bookings:edit on both apply shapes", async () => {
    const typed = await patch({
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "BOOKING_GUEST",
      previewDigest: `v1:${"a".repeat(64)}`,
    });
    expect(typed.status).toBe(200);
    expect(mockRequireAdmin).toHaveBeenNthCalledWith(1, {
      permission: { area: "bookings", level: "edit" },
    });

    const legacy = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });
    expect(legacy.status).toBe(200);
    expect(mockRequireAdmin).toHaveBeenNthCalledWith(2, {
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("rejects any client-supplied target date before the service runs", async () => {
    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
      stayDate: "2026-07-09",
    });

    expect(response.status).toBe(400);
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });

  it("accepts only the strict typed preview-confirm request", async () => {
    const digest = `v1:${"a".repeat(64)}`;
    const response = await patch({
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "BOOKING_GUEST",
      previewDigest: digest,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      noop: false,
      movedRowCount: 1,
      promotedRowCount: 0,
      affectedNights: ["2026-07-01"],
    });
    expect(mockApplyBedAllocationMove).toHaveBeenCalledWith({
      request: {
        anchorAllocationId: "allocation-1",
        destinationBedId: "bed-2",
        scope: "BOOKING_GUEST",
        previewDigest: digest,
      },
      actorMemberId: "admin-1",
    });
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });

  it.each([
    {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "ALLOCATION_NIGHT",
    },
    {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "ALLOCATION_NIGHT",
      previewDigest: `v1:${"a".repeat(64)}`,
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    },
    {
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
      destinationBedId: "bed-2",
    },
    // The branch's headline invariant on the typed shape: a scope, an anchor, a
    // destination and a digest — never a target date. The typed schema is
    // `.strict()`, so a `stayDate` alongside an otherwise valid typed body must
    // be refused rather than quietly ignored.
    {
      anchorAllocationId: "allocation-1",
      destinationBedId: "bed-2",
      scope: "BOOKING_GUEST",
      previewDigest: `v1:${"a".repeat(64)}`,
      stayDate: "2026-07-09",
    },
  ])("rejects incomplete or mixed typed/legacy shapes", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(mockApplyBedAllocationMove).not.toHaveBeenCalled();
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });

  it("preserves the legacy 31-row cap", async () => {
    const accepted = Array.from({ length: 31 }, (_, index) => `a-${index}`);
    const response = await patch({ allocationIds: accepted, bedId: "bed-2" });
    expect(response.status).toBe(200);

    mockMoveBedAllocationsSameDate.mockClear();
    const refused = await patch({
      allocationIds: [...accepted, "a-31"],
      bedId: "bed-2",
    });
    expect(refused.status).toBe(400);
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });

  it("returns a server-side no-op without adding a route audit", async () => {
    mockMoveBedAllocationsSameDate.mockResolvedValue({
      noop: true,
      allocations: [],
      promotedPartners: [],
    });

    const response = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      noop: true,
      allocations: [],
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("keeps module and admin authorization on the move route", async () => {
    mockModuleEnabled.mockResolvedValue(false);
    const disabled = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });
    expect(disabled.status).toBe(404);

    mockModuleEnabled.mockResolvedValue(true);
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    const forbidden = await patch({
      allocationIds: ["allocation-1"],
      bedId: "bed-2",
    });
    expect(forbidden.status).toBe(403);
    expect(mockMoveBedAllocationsSameDate).not.toHaveBeenCalled();
  });
});
