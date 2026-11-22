/**
 * ALP-718 (`INV-MCP-006`): every route an AI app action reaches filters what
 * a connection is sent, including stage 1's (ALP-653) availability and lodge
 * list. Each is held to its action's contract (`expectActionContract`): the
 * connection gets exactly the `returns` fields, the browser's answer is
 * unchanged.
 *
 * The cancel, cancel preview and draft create answers are pinned in
 * `cancel-mcp-connection.test.ts` and the shapes' complete types.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    lodge: { findMany: vi.fn(), findUnique: vi.fn() },
    season: { findMany: vi.fn() },
  },
  getEligibleLodgeIdsForMember: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  getMonthAvailability: vi.fn(),
  getLodgeCapacity: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { bookingQuery: { id: "booking-query" } },
}));
vi.mock("@/lib/lodge-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-access")),
  getEligibleLodgeIdsForMember: h.getEligibleLodgeIdsForMember,
  isMemberEligibleToBookLodge: h.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: h.getMonthAvailability,
  getLodgeCapacity: h.getLodgeCapacity,
}));

import { GET as getAvailability } from "@/app/api/availability/route";
import { GET as getLodges } from "@/app/api/lodges/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
});

describe("list_lodges", () => {
  it("answers with each bookable lodge's id, name and travel note", async () => {
    const lodges = [{ id: "lodge-1", name: "Main lodge", travelNote: "Chains in winter" }];
    h.prisma.lodge.findMany.mockResolvedValue(lodges);
    h.getEligibleLodgeIdsForMember.mockResolvedValue({ allLodges: true });
    const { connection, browser } = await expectActionContract({ actionId: "list_lodges", handler: getLodges });
    expect(connection).toEqual({ lodges });
    expect(browser).toEqual({ lodges });
  });
});

describe("get_availability", () => {
  it("answers with each night's occupied beds, its season and the lodge's capacity", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
    h.isMemberEligibleToBookLodge.mockResolvedValue(true);
    h.getMonthAvailability.mockResolvedValue(new Map([["2026-07-03", 12]]));
    h.getLodgeCapacity.mockResolvedValue(30);
    h.prisma.season.findMany.mockResolvedValue([
      {
        name: "Winter",
        type: "PEAK",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-02T00:00:00.000Z"),
      },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "get_availability",
      handler: getAvailability,
      args: { year: 2026, month: 6, lodgeId: "lodge-1" },
    });
    expect(connection).toEqual({
      availability: { "2026-07-03": 12 },
      seasons: { "2026-07-01": { name: "Winter", type: "PEAK" }, "2026-07-02": { name: "Winter", type: "PEAK" } },
      lodgeCapacity: 30,
    });
    expect(browser).toEqual(connection);
    expect(h.isMemberEligibleToBookLodge).toHaveBeenCalledWith(h.prisma, "officer-1", "lodge-1");
  });
});
