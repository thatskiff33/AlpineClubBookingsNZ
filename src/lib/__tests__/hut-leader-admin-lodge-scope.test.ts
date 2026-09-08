import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  hutLeaderFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  getUnassigned: vi.fn(),
  getOccupancy: vi.fn(),
}))

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, member: { id: "admin-1" } })),
}))
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: vi.fn(async (_db: unknown, lodgeId?: string | null) =>
    lodgeId === "lodge-a" || lodgeId === "lodge-b" ? lodgeId : null,
  ),
  lodgeNullTolerantScope: (lodgeId: string) => ({ lodgeId }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hutLeaderAssignment: { findMany: mocks.hutLeaderFindMany },
    member: { findUnique: mocks.memberFindUnique },
    bookingGuest: { findMany: mocks.bookingGuestFindMany },
    booking: { findMany: mocks.bookingFindMany },
  },
}))
vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: mocks.getUnassigned,
}))
vi.mock("@/lib/admin-occupancy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-occupancy")),
  getAdminOccupancyMonth: mocks.getOccupancy,
}))

import { GET as listAssignments, POST as createAssignment } from "@/app/api/admin/hut-leaders/route"
import { GET as listEligible } from "@/app/api/admin/hut-leaders/eligible-members/route"
import { GET as listUnassigned } from "@/app/api/admin/hut-leaders/unassigned-dates/route"
import { GET as listOccupancy } from "@/app/api/admin/occupancy/route"

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost${path}`, init)
}

function assignment(lodgeId: string) {
  return {
    id: `assignment-${lodgeId}`,
    memberId: `member-${lodgeId}`,
    member: { firstName: lodgeId, lastName: "Leader", email: `${lodgeId}@example.test` },
    startDate: new Date("2026-08-10T00:00:00.000Z"),
    endDate: new Date("2026-08-11T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    lodgeId,
    lodge: { id: lodgeId, name: lodgeId === "lodge-b" ? "Lodge B" : "Lodge A" },
    bedId: null,
    bed: null,
  }
}

describe("hut-leader admin workspace has one strict lodge scope (#2701, #2887)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hutLeaderFindMany.mockImplementation(async (args: { where?: { lodgeId?: string } }) =>
      args.where?.lodgeId ? [assignment(args.where.lodgeId)] : [],
    )
    mocks.bookingGuestFindMany.mockResolvedValue([])
    mocks.bookingFindMany.mockResolvedValue([])
    mocks.getUnassigned.mockImplementation(async ({ scope }: { scope: { lodgeId: string } }) => [
      { date: scope.lodgeId === "lodge-b" ? "2026-08-20" : "2026-08-10", bookingCount: 1, guestCount: 2 },
    ])
    mocks.getOccupancy.mockImplementation(async ({ lodgeId }: { lodgeId: string }) => ({
      month: "2026-08",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      nights: [{ date: lodgeId === "lodge-b" ? "2026-08-20" : "2026-08-10", guestCount: 2, bookings: [] }],
      bookings: [],
    }))
  })

  it("refuses every read and the create before downstream work when lodgeId is missing", async () => {
    const responses = await Promise.all([
      listAssignments(request("/api/admin/hut-leaders")),
      listEligible(request("/api/admin/hut-leaders/eligible-members?startDate=2026-08-10&endDate=2026-08-11")),
      listUnassigned(request("/api/admin/hut-leaders/unassigned-dates")),
      listOccupancy(request("/api/admin/occupancy?month=2026-08")),
      createAssignment(request("/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: "member-1", startDate: "2026-08-10", endDate: "2026-08-11" }),
      })),
    ])

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400])
    expect(mocks.hutLeaderFindMany).not.toHaveBeenCalled()
    expect(mocks.bookingGuestFindMany).not.toHaveBeenCalled()
    expect(mocks.bookingFindMany).not.toHaveBeenCalled()
    expect(mocks.getUnassigned).not.toHaveBeenCalled()
    expect(mocks.getOccupancy).not.toHaveBeenCalled()
    expect(mocks.memberFindUnique).not.toHaveBeenCalled()
  })

  it("returns Lodge B assignments, coverage and occupancy without Lodge A data", async () => {
    const [assignmentsResponse, unassignedResponse, occupancyResponse] = await Promise.all([
      listAssignments(request("/api/admin/hut-leaders?lodgeId=lodge-b")),
      listUnassigned(request("/api/admin/hut-leaders/unassigned-dates?lodgeId=lodge-b")),
      listOccupancy(request("/api/admin/occupancy?month=2026-08&lodgeId=lodge-b")),
    ])

    const assignmentsBody = await assignmentsResponse.json()
    const unassignedBody = await unassignedResponse.json()
    const occupancyBody = await occupancyResponse.json()
    expect(assignmentsBody.assignments).toHaveLength(1)
    expect(assignmentsBody.assignments[0]).toMatchObject({ lodgeId: "lodge-b", lodgeName: "Lodge B" })
    expect(JSON.stringify(assignmentsBody)).not.toContain("lodge-a")
    expect(unassignedBody.unassignedDates[0].date).toBe("2026-08-20")
    expect(occupancyBody.nights[0].date).toBe("2026-08-20")
    expect(mocks.getUnassigned).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "lodge", lodgeId: "lodge-b" },
    }))
    expect(mocks.getOccupancy).toHaveBeenCalledWith(expect.objectContaining({ lodgeId: "lodge-b" }))
  })

  it("scopes eligible guests, booking owners and existing coverage to Lodge B", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([
      {
        memberId: "member-b",
        stayStart: new Date("2026-08-10T00:00:00.000Z"),
        stayEnd: new Date("2026-08-12T00:00:00.000Z"),
        member: {
          id: "member-b",
          firstName: "Briar",
          lastName: "Beech",
          email: "b@example.test",
          active: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        booking: {
          checkIn: new Date("2026-08-10T00:00:00.000Z"),
          checkOut: new Date("2026-08-12T00:00:00.000Z"),
        },
      },
    ])
    mocks.hutLeaderFindMany.mockResolvedValue([])

    const response = await listEligible(request(
      "/api/admin/hut-leaders/eligible-members?startDate=2026-08-10&endDate=2026-08-11&lodgeId=lodge-b",
    ))
    const body = await response.json()

    expect(body.members.map((member: { id: string }) => member.id)).toEqual(["member-b"])
    expect(mocks.bookingGuestFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ booking: expect.objectContaining({ lodgeId: "lodge-b" }) }),
    }))
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lodgeId: "lodge-b" }),
    }))
    expect(mocks.hutLeaderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lodgeId: "lodge-b" }),
    }))
  })

  it("suggests only explicit sparse guest nights, not their envelope gap", async () => {
    mocks.bookingGuestFindMany.mockResolvedValue([{
      memberId: "member-b",
      stayStart: new Date("2026-08-10T00:00:00.000Z"),
      stayEnd: new Date("2026-08-13T00:00:00.000Z"),
      nights: [
        { stayDate: new Date("2026-08-10T00:00:00.000Z") },
        { stayDate: new Date("2026-08-12T00:00:00.000Z") },
      ],
      member: {
        id: "member-b",
        firstName: "Briar",
        lastName: "Beech",
        email: "b@example.test",
        active: true,
        hutLeaderEligible: true,
        hutLeaderEligibleAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      booking: {
        checkIn: new Date("2026-08-10T00:00:00.000Z"),
        checkOut: new Date("2026-08-13T00:00:00.000Z"),
      },
    }])
    mocks.hutLeaderFindMany.mockResolvedValue([])

    const response = await listEligible(request(
      "/api/admin/hut-leaders/eligible-members?startDate=2026-08-10&endDate=2026-08-12&lodgeId=lodge-b",
    ))
    const body = await response.json()

    expect(body.members[0]).toMatchObject({
      bookingCheckIn: "2026-08-10",
      bookingCheckOut: "2026-08-13",
      suggestedStartDate: "2026-08-10",
      suggestedEndDate: "2026-08-10",
      uncoveredNightCount: 2,
      fullyCovered: false,
    })
    expect(mocks.bookingGuestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          nights: { select: { stayDate: true } },
        }),
      }),
    )
  })
})
