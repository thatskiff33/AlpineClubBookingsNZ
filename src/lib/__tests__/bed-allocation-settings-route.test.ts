import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lodgeFindUnique: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  createAuditLog: vi.fn(),
  readGuard: vi.fn(),
  writeGuard: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));
vi.mock("@/lib/admin-bed-allocation", () => ({
  getEffectiveBedAllocationSettings: mocks.getSettings,
  updateBedAllocationSettings: mocks.updateSettings,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationRead: mocks.readGuard,
  requireBedAllocationWrite: mocks.writeGuard,
  bedAllocationErrorResponse: () =>
    Response.json({ error: "Bed allocation request failed" }, { status: 500 }),
}));

import {
  GET,
  PUT,
} from "@/app/api/admin/bed-allocation/settings/route";

const session = { user: { id: "admin-1" } };
const settings = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: ["BOOKING_COHESION"],
};

describe("bed-allocation settings route lodge validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readGuard.mockResolvedValue({ ok: true, session });
    mocks.writeGuard.mockResolvedValue({ ok: true, session });
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });
    mocks.getSettings.mockResolvedValue(settings);
    mocks.updateSettings.mockResolvedValue(settings);
    mocks.createAuditLog.mockResolvedValue({});
  });

  it.each([null, { id: "lodge-1", active: false }])(
    "rejects an unknown or inactive lodge on GET",
    async (lodge) => {
      mocks.lodgeFindUnique.mockResolvedValue(lodge);

      const response = await GET(
        new Request(
          "http://localhost/api/admin/bed-allocation/settings?lodgeId=lodge-1",
        ),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Lodge not found or not active",
      });
      expect(mocks.getSettings).not.toHaveBeenCalled();
    },
  );

  it("loads settings only after resolving the active lodge", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/settings?lodgeId=lodge-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.lodgeFindUnique).toHaveBeenCalledWith({
      where: { id: "lodge-1" },
      select: { id: true, active: true },
    });
    expect(mocks.getSettings).toHaveBeenCalledWith(undefined, "lodge-1");
  });

  it("rejects an inactive lodge on PUT before writing or auditing", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: false });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lodgeId: "lodge-1",
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("preserves an explicitly empty priority order for an active lodge", async () => {
    mocks.updateSettings.mockResolvedValue({
      autoAllocationEnabled: false,
      allocationPriorityOrder: [],
    });

    const response = await PUT(
      new Request("http://localhost/api/admin/bed-allocation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lodgeId: "lodge-1",
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      lodgeId: "lodge-1",
      updatedByMemberId: "admin-1",
      autoAllocationEnabled: false,
      allocationPriorityOrder: [],
    });
  });
});
