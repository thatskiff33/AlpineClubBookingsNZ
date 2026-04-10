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

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mockBookingFindMany,
    },
    choreAssignment: {
      findMany: vi.fn(),
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
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } })

    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: mockTxExecuteRaw,
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
    expect(body.error).toContain("Confirm overwrite")
    expect(mockBookingFindMany).not.toHaveBeenCalled()
    expect(mockChoreAssignmentDeleteMany).not.toHaveBeenCalled()
    expect(mockChoreAssignmentCreateMany).not.toHaveBeenCalled()
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1)
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
      where: { date: new Date("2026-04-10T00:00:00.000Z") },
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
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1)
  })
})
