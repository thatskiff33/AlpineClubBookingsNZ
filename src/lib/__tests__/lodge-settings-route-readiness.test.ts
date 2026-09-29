/**
 * #3407: `GET /api/admin/lodge-settings?lodgeId=` says whether the lodge can
 * take a booking at all, from the one resolver every booking path reads. The
 * lodge setup wizard reads it before it may call a lodge ready — with Bed
 * Allocation on, the configured figure alone cannot answer that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  lodgeFindUnique: vi.fn(),
  getLodgeCapacityStatus: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mocks.lodgeFindUnique } },
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadLodgeSettings: vi.fn(async () => ({
    capacity: null,
    hutLeaderLookaheadDays: 14,
    schoolGroupSoftCap: 25,
  })),
  updateLodgeSettings: vi.fn(),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  CLUB_CONFIG_LODGE_CAPACITY: 20,
  getLodgeCapacityStatus: mocks.getLodgeCapacityStatus,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
}));

import { GET } from "@/app/api/admin/lodge-settings/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.lodgeFindUnique.mockResolvedValue({ active: true });
});

function get(query: string) {
  return GET(new Request(`http://localhost/api/admin/lodge-settings${query}`));
}

describe("GET /api/admin/lodge-settings — setUpForBookings (#3407)", () => {
  it.each([
    ["unconfigured_lodge", 0, false],
    ["configured_beds", 12, true],
    ["capacity_override", 18, true],
    ["capped_beds", 30, true],
  ])("reports %s as set up = %s", async (source, capacity, expected) => {
    mocks.getLodgeCapacityStatus.mockResolvedValue({ capacity, source });

    const body = await (await get("?lodgeId=lodge-2")).json();

    expect(mocks.getLodgeCapacityStatus).toHaveBeenCalledWith("lodge-2");
    expect(body.setUpForBookings).toBe(expected);
  });

  it("omits it on the legacy read that names no lodge", async () => {
    const body = await (await get("")).json();
    expect(body).not.toHaveProperty("setUpForBookings");
    expect(mocks.getLodgeCapacityStatus).not.toHaveBeenCalled();
  });
});
