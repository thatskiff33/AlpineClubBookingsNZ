import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockAuth = vi.fn()
const mockBookingFindMany = vi.fn()
const mockChoreAssignmentFindMany = vi.fn()
const mockChoreAssignmentDeleteMany = vi.fn()
const mockChoreAssignmentCreateMany = vi.fn()
const mockChoreTemplateFindMany = vi.fn()
const mockChoreAssignmentGroupBy = vi.fn()
const mockTransaction = vi.fn()
const mockAllocateChores = vi.fn()
const mockTxExecuteRaw = vi.fn()
const mockLodgeFindFirst = vi.fn()

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}))
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null)
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: async (options?: { forbiddenResponse?: () => Response }) => {
    const session = await mockAuth()
    if (!session?.user?.id) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      }
    }
    if (session.user.role !== "ADMIN") {
      return {
        ok: false,
        response:
          options?.forbiddenResponse?.() ??
          new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      }
    }
    const inactiveResponse = await mockRequireActiveSessionUser(session.user.id)
    if (inactiveResponse) return { ok: false, response: inactiveResponse }
    return { ok: true, session }
  },
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    booking: {
      findMany: mockBookingFindMany,
    },
    choreAssignment: {
      findMany: vi.fn(),
    },
    lodge: {
      findFirst: mockLodgeFindFirst,
    },
    $transaction: (callback: (tx: unknown) => unknown) => mockTransaction(callback),
  },
}))

vi.mock("@/lib/chore-allocator", () => ({
  allocateChores: (...args: unknown[]) => mockAllocateChores(...args),
}))

vi.mock("@/lib/email", () => ({
  sendChoreRosterEmail: vi.fn(),
}))

vi.mock("@/lib/guest-chore-token", () => ({
  createGuestChoreToken: vi.fn(),
}))

vi.mock("@/lib/member-utils", () => ({
  getEffectiveEmail: vi.fn(),
}))

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe("PUT /api/admin/roster/[date] regenerate action", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } })
    mockLodgeFindFirst.mockResolvedValue({ id: "default-lodge" })

    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: mockTxExecuteRaw,
        booking: { findMany: mockBookingFindMany },
        choreAssignment: {
          findMany: mockChoreAssignmentFindMany,
          deleteMany: mockChoreAssignmentDeleteMany,
          createMany: mockChoreAssignmentCreateMany,
          groupBy: mockChoreAssignmentGroupBy,
        },
        choreTemplate: {
          findMany: mockChoreTemplateFindMany,
        },
      })
    )
  })

  it("returns 400 for invalid roster actions before mutating assignments", async () => {
    const { PUT } = await import("@/app/api/admin/roster/[date]/route")
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "unknown" }),
      headers: { "Content-Type": "application/json" },
    })

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.code).toBe("ROSTER_INPUT_INVALID")
    expect(body.error).toContain("Review the roster and try again")
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("returns 409 when confirmed assignments exist without overwrite acknowledgement", async () => {
    mockChoreAssignmentFindMany.mockResolvedValueOnce([{ status: "CONFIRMED" }])

    const { PUT } = await import("@/app/api/admin/roster/[date]/route")
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "regenerate" }),
      headers: { "Content-Type": "application/json" },
    })

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("ROSTER_REGENERATE_CONFLICT")
    expect(body.error).toContain("Confirm the overwrite warning")
    expect(mockBookingFindMany).not.toHaveBeenCalled()
    expect(mockChoreAssignmentDeleteMany).not.toHaveBeenCalled()
    expect(mockChoreAssignmentCreateMany).not.toHaveBeenCalled()
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(3)
  })

  it("replaces confirmed assignments with fresh suggested ones after acknowledgement", async () => {
    mockChoreAssignmentFindMany
      .mockResolvedValueOnce([{ status: "CONFIRMED" }])
      .mockResolvedValueOnce([])
    mockBookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        // #3369: the roster query loads BOTH halves of the owner for its
        // "Booking for …" group label, so a row it returns always carries both.
        memberId: "member-1",
        member: { firstName: "Ana", lastName: "Reid" },
        organisation: null,
        guests: [
          {
            id: "guest-1",
            firstName: "Alex",
            lastName: "Smith",
            ageTier: "ADULT",
          },
        ],
      },
    ])
    mockChoreTemplateFindMany.mockResolvedValue([
      {
        id: "chore-1",
        name: "Kitchen",
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 1,
        isEssential: true,
        ageRestriction: "NONE",
        minAge: 0,
        sortOrder: 1,
        timeOfDay: "MORNING",
        frequencyMode: "DAILY",
        frequencyDays: null,
        frequencyDaysOfWeek: [],
      },
    ])
    mockChoreAssignmentGroupBy.mockResolvedValue([])
    mockAllocateChores.mockReturnValue([
      {
        choreTemplateId: "chore-1",
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
      },
    ])

    const { PUT } = await import("@/app/api/admin/roster/[date]/route")
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({
        action: "regenerate",
        overwriteConfirmed: true,
        includeNonEssential: true,
      }),
      headers: { "Content-Type": "application/json" },
    })

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockChoreAssignmentDeleteMany).toHaveBeenCalledWith({
      where: {
        date: new Date("2026-04-10T00:00:00.000Z"),
        booking: { lodgeId: "default-lodge" },
        choreTemplate: { lodgeId: "default-lodge" },
      },
    })
    expect(mockChoreAssignmentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          choreTemplateId: "chore-1",
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          status: "SUGGESTED",
        }),
      ],
    })
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(3)
  })
})

// --- D-12 (#2307): the admin chore roster choke point -----------------------
//
// Owner decision D-12: a member guest whose consent is still PENDING holds a bed
// (D-4) but is not operationally present. `getGuestsForDate` in
// admin-roster-service.ts is the single query behind THREE things — chore
// allocation, the roster email fan-out, and GuestChoreToken minting — so one
// exclusion there keeps a pending guest out of all three at once. That is why
// the assertion below is on what reaches `allocateChores`: it is the choke point,
// and if the wrong list reaches it the wrong people get chores, emails and
// tokens.
describe("PUT /api/admin/roster/[date] excludes unconsented member guests (D-12, #2307)", () => {
  const PRESENT_OR = [{ consentStatus: null }, { consentStatus: "CONFIRMED" }]

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } })
    mockLodgeFindFirst.mockResolvedValue({ id: "default-lodge" })
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: mockTxExecuteRaw,
        booking: { findMany: mockBookingFindMany },
        choreAssignment: {
          findMany: mockChoreAssignmentFindMany,
          deleteMany: mockChoreAssignmentDeleteMany,
          createMany: mockChoreAssignmentCreateMany,
          groupBy: mockChoreAssignmentGroupBy,
        },
        choreTemplate: {
          findMany: mockChoreTemplateFindMany,
        },
      })
    )
  })

  it("allocates chores to the consented guests only, and never the PENDING one", async () => {
    mockChoreAssignmentFindMany.mockResolvedValue([])
    // Filters the guest list the way Prisma would, from the `where` the service
    // actually sent — a mock that ignored it would pass with the filter deleted.
    mockBookingFindMany.mockImplementation(async (args: any) => {
      const where = args.include.guests.where as
        | { OR?: Array<{ consentStatus: string | null }> }
        | undefined
      const guests = [
        { id: "guest-ordinary", firstName: "Nula", lastName: "Ordinary", ageTier: "ADULT", consentStatus: null },
        { id: "guest-agreed", firstName: "Connie", lastName: "Agreed", ageTier: "ADULT", consentStatus: "CONFIRMED" },
        { id: "guest-awaiting", firstName: "Penny", lastName: "Awaiting", ageTier: "ADULT", consentStatus: "PENDING" },
      ]
      return [
        {
          id: "booking-1",
          checkIn: new Date("2026-04-10T00:00:00.000Z"),
          checkOut: new Date("2026-04-11T00:00:00.000Z"),
          // #3369: the roster query loads BOTH halves of the owner for its
          // "Booking for …" group label, so a row it returns always carries both.
          memberId: "member-1",
          member: { firstName: "Ana", lastName: "Reid" },
          organisation: null,
          guests: where?.OR
            ? guests.filter((guest) =>
                where.OR!.some((branch) => branch.consentStatus === guest.consentStatus)
              )
            : guests,
        },
      ]
    })
    mockChoreTemplateFindMany.mockResolvedValue([])
    mockChoreAssignmentGroupBy.mockResolvedValue([])
    mockAllocateChores.mockReturnValue([])

    const { PUT } = await import("@/app/api/admin/roster/[date]/route")
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "regenerate" }),
      headers: { "Content-Type": "application/json" },
    })
    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) })

    expect(res.status).toBe(200)

    // BOTH sites: the booking match and the guest include.
    const args = mockBookingFindMany.mock.calls[0][0]
    expect(args.where.guests.some.OR).toEqual(PRESENT_OR)
    expect(args.include.guests.where.OR).toEqual(PRESENT_OR)

    // And the choke point itself — the list the allocator, the email fan-out and
    // the token minter all work from.
    const allocatedGuests = mockAllocateChores.mock.calls[0][1] as Array<{ id: string }>
    expect(allocatedGuests.map((guest) => guest.id)).toEqual([
      "guest-agreed",
      "guest-ordinary",
    ])
  })
})
