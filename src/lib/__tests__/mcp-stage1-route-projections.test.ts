/**
 * ALP-718 (`INV-MCP-006`): every route an AI app action reaches filters what
 * a connection is sent, including stage 1's (ALP-653) availability and lodge
 * list. Each is held to its action's contract (`expectActionContract`): the
 * connection gets exactly the `returns` fields, the browser's answer is
 * unchanged.
 *
 * Each fixture carries a field the action's shape does not name, in a place
 * the route passes through, so the test fails if the route stops projecting.
 * The cancel and cancel preview answers are pinned in
 * `cancel-mcp-connection.test.ts`, the draft create answer in
 * `issue7-8-draft-subscription.test.ts`.
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
    const lodge = { id: "lodge-1", name: "Main lodge", travelNote: "Chains in winter" };
    // A column the route's select leaves out today; the connection never sees it either way.
    const row = { ...lodge, internalNote: "Spare key under the mat" };
    h.prisma.lodge.findMany.mockResolvedValue([row]);
    h.getEligibleLodgeIdsForMember.mockResolvedValue({ allLodges: true });
    const { connection, browser } = await expectActionContract({ actionId: "list_lodges", handler: getLodges });
    expect(connection).toEqual({ lodges: [lodge] });
    expect(browser).toEqual({ lodges: [row] });
  });
});

describe("get_availability", () => {
  it("answers with each night's occupied beds, its season and the lodge's capacity", async () => {
    h.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
    h.isMemberEligibleToBookLodge.mockResolvedValue(true);
    // The route copies each occupancy entry as it comes, so an entry that is
    // not a bed count reaches the website; the shape keeps only plain values.
    const stray = { occupiedBeds: 3, guestNames: ["A. Member"] };
    h.getMonthAvailability.mockResolvedValue(
      new Map<string, unknown>([
        ["2026-07-03", 12],
        ["2026-07-04", stray],
      ]),
    );
    h.getLodgeCapacity.mockResolvedValue(30);
    h.prisma.season.findMany.mockResolvedValue([
      {
        id: "season-1",
        name: "Winter",
        type: "PEAK",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-02T00:00:00.000Z"),
        notes: "Committee pricing note",
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
    expect(browser).toEqual({ ...(connection as object), availability: { "2026-07-03": 12, "2026-07-04": stray } });
    expect(JSON.stringify(connection)).not.toMatch(/season-1|Committee pricing note|A\. Member/);
    expect(h.isMemberEligibleToBookLodge).toHaveBeenCalledWith(h.prisma, "officer-1", "lodge-1");
  });
});
