import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindMany: vi.fn(),
  assignmentFindMany: vi.fn(),
  assignmentDeleteMany: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentCreateMany: vi.fn(),
  directAssignmentFindMany: vi.fn(),
  assignmentGroupBy: vi.fn(),
  templateFindMany: vi.fn(),
  sendRosterEmail: vi.fn(),
  shouldSendRoster: vi.fn(),
  createChoreToken: vi.fn(),
  effectiveEmail: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => mocks.transaction(callback),
    choreAssignment: { findMany: mocks.directAssignmentFindMany },
  },
}))
vi.mock("@/lib/email", () => ({ sendChoreRosterEmail: mocks.sendRosterEmail, shouldSendChoreRoster: mocks.shouldSendRoster }))
vi.mock("@/lib/guest-chore-token", () => ({ createGuestChoreToken: mocks.createChoreToken }))
vi.mock("@/lib/member-utils", () => ({ getEffectiveEmail: mocks.effectiveEmail }))
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import type { RosterActionInput } from "@/lib/admin-lodge-schemas/hut-leaders"
import {
  createRosterRevision,
  getAdminRosterForDate,
  updateAdminRosterForDate,
} from "@/lib/admin-roster-service"

const DATE = new Date("2026-08-10T00:00:00.000Z")
const CURRENT = {
  id: "assignment-1",
  choreTemplateId: "kitchen",
  bookingId: "booking-1",
  bookingGuestId: "guest-1",
  status: "CONFIRMED" as const,
  completedAt: null,
  completedVia: null,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
}

function eligibleBooking(id: string, guestId: string, owner: string) {
  return {
    id,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    checkIn: DATE,
    checkOut: new Date("2026-08-11T00:00:00.000Z"),
    member: { firstName: owner, lastName: "Booker" },
    guests: [{
      id: guestId,
      bookingId: id,
      firstName: guestId,
      lastName: "Guest",
      ageTier: "ADULT",
      stayStart: DATE,
      stayEnd: new Date("2026-08-11T00:00:00.000Z"),
      nights: [{ stayDate: DATE }],
      member: { ageTier: "ADULT", dateOfBirth: new Date("1980-01-01T00:00:00.000Z") },
    }],
  }
}

function template(id: string, sortOrder = 1) {
  return {
    id,
    name: id,
    description: null,
    recommendedPeopleMin: 1,
    recommendedPeopleMax: 2,
    isEssential: true,
    ageRestriction: "ANY" as const,
    conditionalNote: null,
    minAge: 0,
    sortOrder,
    timeOfDay: "ANYTIME" as const,
    frequencyMode: "DAILY" as const,
    frequencyDays: null,
    frequencyDaysOfWeek: [],
    active: true,
    lodgeId: "lodge-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }
}

function tx() {
  return {
    $executeRaw: mocks.executeRaw,
    booking: { findMany: mocks.bookingFindMany },
    choreAssignment: {
      findMany: mocks.assignmentFindMany,
      deleteMany: mocks.assignmentDeleteMany,
      updateMany: mocks.assignmentUpdateMany,
      create: mocks.assignmentCreate,
      createMany: mocks.assignmentCreateMany,
      groupBy: mocks.assignmentGroupBy,
    },
    choreTemplate: { findMany: mocks.templateFindMany },
  }
}

function save(assignments: Array<{
  rowKey: string
  assignmentId?: string
  choreTemplateId: string
  bookingGuestId: string
}>, options?: { revision?: string; acknowledge?: boolean }) {
  return updateAdminRosterForDate({
    date: DATE,
    dateString: "2026-08-10",
    lodgeId: "lodge-1",
    data: {
      action: "save",
      baseRevision: options?.revision ?? createRosterRevision([CURRENT]),
      acknowledgeCompletedReset: options?.acknowledge ?? false,
      assignments,
    },
  })
}

describe("admin whole-roster save", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (callback: (client: unknown) => unknown) => callback(tx()))
    mocks.bookingFindMany.mockResolvedValue([
      eligibleBooking("booking-1", "guest-1", "One"),
      eligibleBooking("booking-2", "guest-2", "Two"),
    ])
    mocks.assignmentGroupBy.mockResolvedValue([])
    mocks.templateFindMany.mockImplementation(async (args: { select?: unknown }) =>
      args.select ? [{ id: "kitchen" }, { id: "wood" }] : [template("kitchen"), template("wood", 2)],
    )
    mocks.assignmentCreate.mockResolvedValue({ id: "assignment-new" })
    mocks.assignmentCreateMany.mockResolvedValue({ count: 0 })
    mocks.directAssignmentFindMany.mockResolvedValue([])
    mocks.assignmentFindMany.mockImplementation(async (args: { select?: Record<string, unknown>; where?: { date?: unknown }; include?: unknown }) => {
      if (args.select && "choreTemplate" in args.select) {
        return [{ ...CURRENT, status: "SUGGESTED", choreTemplate: { active: true } }]
      }
      if (args.select) return [CURRENT]
      if (args.where?.date && typeof args.where.date === "object" && "gte" in (args.where.date as object)) return []
      return [{
        ...CURRENT,
        bookingId: "booking-2",
        bookingGuestId: "guest-2",
        status: "SUGGESTED",
        choreTemplate: template("kitchen"),
        bookingGuest: { firstName: "guest-2", lastName: "Guest", ageTier: "ADULT", member: { ageTier: "ADULT" } },
      }]
    })
  })

  it("reassigns across bookings by writing both foreign keys and demotes confirmed state", async () => {
    const result = await save([{ rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-2" }])
    expect(result.init).toBeUndefined()
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        bookingGuestId: "guest-2",
        bookingId: "booking-2",
        status: "SUGGESTED",
        completedAt: null,
        completedVia: null,
      }),
    }))
    expect((result.body as { assignments: Array<{ bookingId: string }> }).assignments[0].bookingId).toBe("booking-2")
  })

  it("applies remove and add in the same locked transaction while multiple assignments remain valid", async () => {
    await save([
      { rowKey: "new-1", choreTemplateId: "kitchen", bookingGuestId: "guest-2" },
      { rowKey: "new-2", choreTemplateId: "wood", bookingGuestId: "guest-2" },
    ])
    // Global booking tier, immutable-lodge tier, then roster-date tier.
    expect(mocks.executeRaw).toHaveBeenCalledTimes(3)
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["assignment-1"] } }),
    }))
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(2)
    expect(mocks.assignmentCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ bookingId: "booking-2", bookingGuestId: "guest-2" }),
    }))
  })

  it("requires completed-reset acknowledgement and clears completion only after an acknowledged save", async () => {
    const completed = { ...CURRENT, status: "COMPLETED" as const, completedAt: new Date(), completedVia: "KIOSK" }
    mocks.assignmentFindMany.mockResolvedValueOnce([completed])
    const refused = await save([
      { rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-1" },
    ], { revision: createRosterRevision([completed]) })
    expect(refused.init?.status).toBe(409)
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()

    mocks.assignmentFindMany.mockResolvedValueOnce([completed])
    await save([
      { rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-1" },
    ], { revision: createRosterRevision([completed]), acknowledge: true })
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUGGESTED", completedAt: null, completedVia: null }),
    }))
  })

  it("rejects a stale revision under the lock with zero assignment writes", async () => {
    const result = await save([], { revision: "stale" })
    expect(result.init?.status).toBe(409)
    expect(result.body).toMatchObject({ code: "ROSTER_STALE" })
    expect(mocks.executeRaw).toHaveBeenCalledTimes(3)
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["unknown assignment", [{ rowKey: "bad", assignmentId: "other", choreTemplateId: "kitchen", bookingGuestId: "guest-1" }], "ROSTER_ASSIGNMENT_INVALID"],
    ["inactive or cross-lodge template", [{ rowKey: "bad", choreTemplateId: "other", bookingGuestId: "guest-1" }], "ROSTER_TEMPLATE_INVALID"],
    ["ineligible guest", [{ rowKey: "bad", choreTemplateId: "kitchen", bookingGuestId: "other" }], "ROSTER_GUEST_INELIGIBLE"],
  ])("rejects %s before any mutation", async (_label, assignments, code) => {
    const result = await save(assignments)
    expect(result.init?.status).toBe(400)
    expect(result.body).toMatchObject({ code })
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it("uses one authoritative eligibility query for lodge, date, operational status, consent and review state", async () => {
    await save([{ rowKey: "new", choreTemplateId: "kitchen", bookingGuestId: "guest-1" }])
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: expect.any(Array) },
        checkIn: { lte: DATE },
        // #2622: checkout-INCLUSIVE. A booking whose last night was yesterday
        // still has people in the lodge this morning.
        checkOut: { gte: DATE },
        lodgeId: "lodge-1",
        OR: [
          { requiresAdminReview: false },
          { adminReviewStatus: "APPROVED" },
        ],
        guests: { some: expect.objectContaining({
          OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }],
        }) },
      }),
    }))
  })

  it("scopes GET snapshot assignment reads through both booking and chore template lodge relations", async () => {
    await getAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      regenerate: false,
      lodgeId: "lodge-1",
    })
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: DATE, booking: { lodgeId: "lodge-1" }, choreTemplate: { lodgeId: "lodge-1" } },
      include: expect.any(Object),
    }))
    expect(mocks.assignmentGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        booking: { lodgeId: "lodge-1" },
        choreTemplate: { lodgeId: "lodge-1" },
      }),
    }))
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        date: { gte: expect.any(Date), lt: DATE },
        bookingGuestId: { in: expect.any(Array) },
        booking: { lodgeId: "lodge-1" },
        choreTemplate: { lodgeId: "lodge-1" },
      }),
    }))
  })

  it("scopes regenerate reads and deletion through both booking and chore template lodge relations", async () => {
    await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "regenerate", overwriteConfirmed: true },
    })
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: DATE, booking: { lodgeId: "lodge-1" }, choreTemplate: { lodgeId: "lodge-1" } },
      select: { status: true },
    }))
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith({
      where: { date: DATE, booking: { lodgeId: "lodge-1" }, choreTemplate: { lodgeId: "lodge-1" } },
    })
  })

  it("scopes confirm through both booking and chore template lodge relations", async () => {
    const result = await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "confirm" },
    })
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith({
      where: {
        date: DATE,
        booking: { lodgeId: "lodge-1" },
        choreTemplate: { lodgeId: "lodge-1" },
        status: "SUGGESTED",
      },
      data: { status: "CONFIRMED" },
    })
    expect(result.init).toBeUndefined()
  })

  it.each([
    ["guest", () => mocks.bookingFindMany.mockResolvedValueOnce([]), "ROSTER_CONFIRM_GUEST_INELIGIBLE"],
    ["template", () => mocks.assignmentFindMany.mockResolvedValueOnce([
      { ...CURRENT, status: "SUGGESTED", choreTemplate: { active: false } },
    ]), "ROSTER_CONFIRM_TEMPLATE_INVALID"],
  ])("rejects Confirm atomically when a %s becomes ineligible", async (_kind, arrange, code) => {
    arrange()
    const result = await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "confirm" },
    })
    expect(result).toMatchObject({ init: { status: 409 }, body: { code } })
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
  })

  it.each([
    ["operational-day envelope", (args: any) =>
      args.where?.checkIn?.lte?.getTime?.() === DATE.getTime() &&
      args.where?.checkOut?.gte?.getTime?.() === DATE.getTime()],
    ["lodge", (args: any) => args.where?.lodgeId === "lodge-1"],
    ["operational status", (args: any) =>
      Array.isArray(args.where?.status?.in) && !args.where.status.in.includes("CANCELLED")],
    ["resolved review", (args: any) =>
      args.where?.OR?.some?.((entry: any) => entry.requiresAdminReview === false) &&
      args.where.OR.some((entry: any) => entry.adminReviewStatus === "APPROVED")],
    ["member consent", (args: any) => {
      const gate = args.include?.guests?.where?.OR
      return Array.isArray(gate) && gate.some((entry) => entry.consentStatus === "CONFIRMED") &&
        gate.some((entry) => entry.consentStatus === null)
    }],
  ])("Confirm applies the authoritative %s predicate before any promotion", async (_label, predicatePresent) => {
    const candidate = eligibleBooking("booking-1", "guest-1", "One")
    mocks.bookingFindMany.mockImplementationOnce(async (args: unknown) =>
      predicatePresent(args) ? [] : [candidate],
    )
    const result = await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "confirm" },
    })
    expect(result).toMatchObject({ init: { status: 409 }, body: { code: "ROSTER_CONFIRM_GUEST_INELIGIBLE" } })
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
  })

  it("scopes save reads and writes through both booking and chore template lodge relations", async () => {
    await save([{ rowKey: "assignment-1", assignmentId: "assignment-1", choreTemplateId: "kitchen", bookingGuestId: "guest-2" }])
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: DATE, booking: { lodgeId: "lodge-1" }, choreTemplate: { lodgeId: "lodge-1" } },
      select: expect.any(Object),
    }))
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "assignment-1",
        date: DATE,
        booking: { lodgeId: "lodge-1" },
        choreTemplate: { lodgeId: "lodge-1" },
      },
    }))
  })

  it("scopes roster email selection through both booking and chore template lodge relations", async () => {
    await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "email" },
    })
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: DATE, booking: { lodgeId: "lodge-1" }, choreTemplate: { lodgeId: "lodge-1" } },
    }))
  })

  it.each([
    ["guest", () => mocks.bookingFindMany.mockResolvedValueOnce([]), "ROSTER_EMAIL_GUEST_INELIGIBLE"],
    ["template", () => mocks.assignmentFindMany.mockResolvedValueOnce([{
      ...CURRENT,
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      choreTemplate: { ...template("kitchen"), active: false },
      bookingGuest: { id: "guest-2", firstName: "Two", lastName: "Guest", member: null },
    }]), "ROSTER_EMAIL_TEMPLATE_INVALID"],
  ])("rejects email fan-out before tokens or providers when a %s becomes ineligible", async (_kind, arrange, code) => {
    arrange()
    const result = await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data: { action: "email" },
    })
    expect(result).toMatchObject({ init: { status: 409 }, body: { code } })
    expect(mocks.createChoreToken).not.toHaveBeenCalled()
    expect(mocks.sendRosterEmail).not.toHaveBeenCalled()
  })

  it.each([
    ["save", "ROSTER_SERVICE_UNAVAILABLE", "Roster not saved because the service could not be reached. Your draft is still here; try Save again."],
    ["regenerate", "ROSTER_REGENERATE_FAILED", "Roster was not regenerated because the service is unavailable. Nothing was changed; try again."],
    ["confirm", "ROSTER_CONFIRM_FAILED", "Roster was not confirmed because the service is unavailable. Nothing was changed; try again."],
    ["email", "ROSTER_EMAIL_FAILED", "Roster emails were not sent because the service is unavailable. Nothing was changed; try again."],
  ] as const)("returns stable actionable %s failure codes without leaking exceptions", async (action, code, error) => {
    mocks.transaction.mockRejectedValueOnce(new Error(action === "email" ? "secret provider detail" : "secret database detail"))
    const data: RosterActionInput = action === "save"
      ? { action, baseRevision: "revision", acknowledgeCompletedReset: false, assignments: [] }
      : { action }
    const result = await updateAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      lodgeId: "lodge-1",
      data,
    })
    expect(result.init?.status).toBe(500)
    expect(result.body).toEqual({ code, error })
    expect(JSON.stringify(result.body)).not.toContain("secret")
  })

  it.each([
    ["wrong date", (args: any) => Boolean(
      args.where?.checkIn?.lte?.getTime?.() === DATE.getTime() &&
      args.where?.checkOut?.gte?.getTime?.() === DATE.getTime() &&
      args.include?.guests?.where?.stayStart?.lte?.getTime?.() === DATE.getTime() &&
      args.include?.guests?.where?.stayEnd?.gte?.getTime?.() === DATE.getTime()
    )],
    ["wrong lodge", (args: any) => args.where?.lodgeId === "lodge-1"],
    ["non-operational booking status", (args: any) =>
      Array.isArray(args.where?.status?.in) && !args.where.status.in.includes("CANCELLED")],
    ["unresolved review", (args: any) =>
      args.where?.OR?.some?.((entry: any) => entry.requiresAdminReview === false) &&
      args.where.OR.some((entry: any) => entry.adminReviewStatus === "APPROVED")],
    ["pending member consent", (args: any) => {
      const bookingGate = args.where?.guests?.some?.OR
      const includedGate = args.include?.guests?.where?.OR
      return [bookingGate, includedGate].every((gate) =>
        Array.isArray(gate) && gate.some((entry) => entry.consentStatus === "CONFIRMED") &&
        gate.some((entry) => entry.consentStatus === null)
      )
    }],
  ])("rejects a guest excluded by the %s eligibility predicate with zero writes", async (_label, predicatePresent) => {
    const candidate = eligibleBooking("booking-bad", "guest-bad", "Bad")
    mocks.bookingFindMany.mockImplementationOnce(async (args: unknown) =>
      predicatePresent(args) ? [] : [candidate],
    )
    const result = await save([{ rowKey: "bad", choreTemplateId: "kitchen", bookingGuestId: "guest-bad" }])
    expect(result).toMatchObject({ init: { status: 400 }, body: { code: "ROSTER_GUEST_INELIGIBLE" } })
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it("rejects a guest whose sparse night rows leave the roster date a gap day with zero writes", async () => {
    // #2622: a true gap is a day adjacent to NO booked night. The 8th is two
    // days before the roster date, so the guest is neither here on the evening
    // of the 10th nor here on its morning.
    const candidate = eligibleBooking("booking-gap", "guest-gap", "Gap")
    candidate.guests[0].nights = [{ stayDate: new Date("2026-08-08T00:00:00.000Z") }]
    mocks.bookingFindMany.mockResolvedValueOnce([candidate])
    const result = await save([{ rowKey: "gap", choreTemplateId: "kitchen", bookingGuestId: "guest-gap" }])
    expect(result).toMatchObject({ init: { status: 400 }, body: { code: "ROSTER_GUEST_INELIGIBLE" } })
    expect(mocks.assignmentDeleteMany).not.toHaveBeenCalled()
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assignmentCreate).not.toHaveBeenCalled()
  })

  it("MUTATION PROBE: keeps a guest whose last night was yesterday on the roster", async () => {
    // The exact case #2622 exists for. Reverting the eligibility rule to the
    // half-open night model makes this save 400 instead of succeeding.
    const candidate = eligibleBooking("booking-out", "guest-out", "Out")
    candidate.guests[0].nights = [{ stayDate: new Date("2026-08-09T00:00:00.000Z") }]
    candidate.guests[0].stayEnd = DATE
    candidate.checkOut = DATE
    mocks.bookingFindMany.mockResolvedValueOnce([candidate])
    const result = await save([{ rowKey: "out", choreTemplateId: "kitchen", bookingGuestId: "guest-out" }])
    expect(result).not.toMatchObject({ body: { code: "ROSTER_GUEST_INELIGIBLE" } })
    expect(mocks.assignmentCreate).toHaveBeenCalled()
  })

  it("groups by booking and applies D-R2 known-DOB then unknown-name order without exposing DOB", async () => {
    const stayEnd = new Date("2026-08-11T00:00:00.000Z")
    const guest = (id: string, firstName: string, lastName: string, dateOfBirth: Date | null) => ({
      id,
      bookingId: "booking-1",
      firstName,
      lastName,
      ageTier: "ADULT",
      stayStart: DATE,
      stayEnd,
      nights: [{ stayDate: DATE }],
      member: { ageTier: "ADULT", dateOfBirth },
    })
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        checkIn: DATE,
        checkOut: stayEnd,
        member: { firstName: "Aroha", lastName: "Bell" },
        guests: [
          // Alphabetical means the displayed first-name-first form, not a
          // surname sort: Alex Bell stays before Zoe Able.
          guest("unknown-z", "Zoe", "Able", null),
          guest("young", "Mika", "Bell", new Date("2012-01-01T00:00:00.000Z")),
          guest("equal-z", "Zoe", "Dale", new Date("2000-01-01T00:00:00.000Z")),
          guest("unknown-a", "Alex", "Bell", null),
          guest("equal-a", "Alex", "Dale", new Date("2000-01-01T00:00:00.000Z")),
          guest("same-z", "Same", "Name", new Date("2000-01-01T00:00:00.000Z")),
          guest("same-a", "Same", "Name", new Date("2000-01-01T00:00:00.000Z")),
          guest("old", "Aroha", "Bell", new Date("1975-01-01T00:00:00.000Z")),
        ],
      },
      eligibleBooking("booking-2", "other", "Taylor"),
    ])

    const result = await getAdminRosterForDate({
      date: DATE,
      dateString: "2026-08-10",
      regenerate: false,
      lodgeId: "lodge-1",
    })
    const guests = (result.body as { guests: Array<Record<string, unknown>> }).guests
    expect(guests.map((entry) => entry.id)).toEqual([
      "old",
      "equal-a",
      "same-a",
      "same-z",
      "equal-z",
      "young",
      "unknown-a",
      "unknown-z",
      "other",
    ])
    expect(guests.slice(0, 8).map((entry) => entry.bookingGroupLabel)).toEqual([
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
      "Booking for Aroha Bell",
    ])
    expect(guests.every((entry) => !("dateOfBirth" in entry))).toBe(true)
  })
})
