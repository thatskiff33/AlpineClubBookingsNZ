import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWrite: vi.fn(),
  parseJsonBody: vi.fn(),
  parseDateRange: vi.fn(),
  runAuto: vi.fn(),
  lodgeFindUnique: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationWrite: mocks.requireWrite,
  bedAllocationErrorResponse: () =>
    Response.json({ error: "Bed allocation request failed" }, { status: 500 }),
}));
// The real limits stay: the route's request schema reads them (ALP-719).
vi.mock("@/lib/bed-allocation-date-range", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bed-allocation-date-range")),
  parseBedAllocationDateRange: mocks.parseDateRange,
}));
vi.mock("@/lib/bed-allocation-auto-allocate", () => ({
  runAutoBedAllocation: mocks.runAuto,
}));
vi.mock("@/lib/api-json", () => ({
  parseJsonRequestBody: mocks.parseJsonBody,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

import { POST } from "@/app/api/admin/bed-allocation/auto-allocate/route";

const range = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-02T00:00:00.000Z"),
  fromDate: "2026-08-01",
  toDate: "2026-08-02",
};

function request() {
  return new Request("http://localhost/api/admin/bed-allocation/auto-allocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lodgeId: "lodge-1" }),
  });
}

describe("bed-allocation auto-allocate route lodge scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWrite.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.parseJsonBody.mockResolvedValue({
      ok: true,
      body: { lodgeId: "lodge-1" },
    });
    mocks.parseDateRange.mockReturnValue(range);
    mocks.runAuto.mockResolvedValue({ count: 2 });
  });

  it.each([null, { id: "lodge-1", active: false }])(
    "rejects an unknown or inactive lodge before starting allocation or auditing",
    async (lodge) => {
      mocks.lodgeFindUnique.mockResolvedValue(lodge);

      const response = await POST(request());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Lodge not found or not active",
      });
      expect(mocks.lodgeFindUnique).toHaveBeenCalledWith({
        where: { id: "lodge-1" },
        select: { id: true, active: true },
      });
      expect(mocks.parseDateRange).not.toHaveBeenCalled();
      expect(mocks.runAuto).not.toHaveBeenCalled();
      expect(mocks.logAudit).not.toHaveBeenCalled();
    },
  );

  it("runs and audits only after resolving the selected active lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ createdCount: 2 });
    expect(mocks.runAuto).toHaveBeenCalledWith({
      range,
      lodgeId: "lodge-1",
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_AUTO_RUN",
        memberId: "admin-1",
        metadata: { range, createdCount: 2 },
      }),
    );
  });
});
