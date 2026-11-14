import { beforeEach, describe, expect, it, vi } from "vitest";

const { applyMock, moduleEnabledMock, previewMock, requireAdminMock } =
  vi.hoisted(() => ({
    applyMock: vi.fn(),
    moduleEnabledMock: vi.fn(),
    previewMock: vi.fn(),
    requireAdminMock: vi.fn(),
  }));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: (...args: unknown[]) => moduleEnabledMock(...args),
}));
vi.mock("@/lib/bed-allocation-admin-contract", () => ({
  BedAllocationAdminError: class BedAllocationAdminError extends Error {},
}));
vi.mock("@/lib/bed-allocation-settings", () => ({
  BedAllocationSettingsValidationError: class BedAllocationSettingsValidationError extends Error {},
}));
vi.mock("@/lib/bed-allocation-removal", () => ({
  BED_ALLOCATION_REMOVAL_CATEGORIES: [
    "AUTO_DRAFT",
    "MANUAL_DRAFT",
    "APPROVED",
  ],
  MAX_BED_ALLOCATION_REMOVAL_WINDOW_NIGHTS: 31,
  BedAllocationRemovalError: class BedAllocationRemovalError extends Error {
    status: number;
    refreshedPreview?: unknown;
    constructor(message: string, status = 400, refreshedPreview?: unknown) {
      super(message);
      this.status = status;
      this.refreshedPreview = refreshedPreview;
    }
  },
  previewBedAllocationRemoval: (...args: unknown[]) => previewMock(...args),
  applyBedAllocationRemoval: (...args: unknown[]) => applyMock(...args),
}));

const allocationScope = {
  type: "ALLOCATION",
  allocationId: "alloc-1",
  bookingId: "booking-1",
  bookingGuestId: "guest-1",
  lodgeId: "lodge-1",
  stayDate: "2026-08-01",
};

function request(method: "POST" | "PUT", body: unknown) {
  return import(
    "@/app/api/admin/bed-allocation/allocations/removal/route"
  ).then(({ POST, PUT }) =>
    (method === "POST" ? POST : PUT)(
      new Request(
        "http://localhost/api/admin/bed-allocation/allocations/removal",
        {
          method,
          headers: { "content-type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
    ),
  );
}

describe("reviewed bed-allocation removal route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAdminMock.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    moduleEnabledMock.mockResolvedValue(true);
    previewMock.mockResolvedValue({ digest: "v1:preview" });
    applyMock.mockResolvedValue({ removedRowCount: 1 });
  });

  it("enforces bookings:view for preview and bookings:edit for apply", async () => {
    expect(
      (await request("POST", {
        scope: allocationScope,
        categories: ["AUTO_DRAFT"],
      })).status,
    ).toBe(200);
    expect(requireAdminMock).toHaveBeenNthCalledWith(1, {
      permission: { area: "bookings", level: "view" },
    });

    expect(
      (await request("PUT", {
        scope: allocationScope,
        categories: ["AUTO_DRAFT"],
        previewDigest: `v1:${"a".repeat(64)}`,
      })).status,
    ).toBe(200);
    expect(requireAdminMock).toHaveBeenNthCalledWith(2, {
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("returns the direct permission denial before invoking either service", async () => {
    requireAdminMock.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    expect(
      (await request("POST", {
        scope: allocationScope,
        categories: ["AUTO_DRAFT"],
      })).status,
    ).toBe(403);
    expect(previewMock).not.toHaveBeenCalled();

    requireAdminMock.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    expect(
      (await request("PUT", {
        scope: allocationScope,
        categories: ["AUTO_DRAFT"],
        previewDigest: `v1:${"a".repeat(64)}`,
      })).status,
    ).toBe(403);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown top-level field", { scope: allocationScope, categories: ["AUTO_DRAFT"], removeAll: true }],
    ["legacy allocation id list", { scope: allocationScope, categories: ["AUTO_DRAFT"], allocationIds: ["alloc-1"] }],
    ["mixed window and anchor fields", { scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-08-01", to: "2026-08-02", allocationId: "alloc-1" }, categories: ["AUTO_DRAFT"] }],
    ["unknown anchor field", { scope: { ...allocationScope, roomId: "room-1" }, categories: ["AUTO_DRAFT"] }],
    ["empty categories", { scope: allocationScope, categories: [] }],
    ["duplicate categories", { scope: allocationScope, categories: ["AUTO_DRAFT", "AUTO_DRAFT"] }],
    ["unknown category", { scope: allocationScope, categories: ["EVERYTHING"] }],
    ["invalid calendar date", { scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-02-30", to: "2026-03-02" }, categories: ["AUTO_DRAFT"] }],
    ["stayDate day that does not exist", { scope: { ...allocationScope, stayDate: "2026-02-30" }, categories: ["AUTO_DRAFT"] }],
    ["reversed window", { scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-08-03", to: "2026-08-01" }, categories: ["AUTO_DRAFT"] }],
    ["oversized window", { scope: { type: "WINDOW", lodgeId: "lodge-1", from: "2026-08-01", to: "2026-09-02" }, categories: ["AUTO_DRAFT"] }],
  ])("rejects %s at the preview DTO boundary", async (_label, body) => {
    expect((await request("POST", body)).status).toBe(400);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it.each(["v1:not-hex", `v2:${"a".repeat(64)}`, "", "a".repeat(64)])(
    "rejects malformed apply digest %s",
    async (previewDigest) => {
      expect(
        (await request("PUT", {
          scope: allocationScope,
          categories: ["AUTO_DRAFT"],
          previewDigest,
        })).status,
      ).toBe(400);
      expect(applyMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown apply field", async () => {
    expect(
      (await request("PUT", {
        scope: allocationScope,
        categories: ["AUTO_DRAFT"],
        previewDigest: `v1:${"a".repeat(64)}`,
        skipPreviewCheck: true,
      })).status,
    ).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before either service", async () => {
    expect((await request("POST", "{not json")).status).toBe(400);
    expect(previewMock).not.toHaveBeenCalled();
  });
});
