import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockBookingFindMany = vi.fn();
const mockTxChoreAssignmentFindMany = vi.fn();
const mockChoreAssignmentFindMany = vi.fn();
const mockChoreTemplateFindMany = vi.fn();
const mockTransaction = vi.fn();
const mockTxExecuteRaw = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mockBookingFindMany,
    },
    choreAssignment: {
      findMany: mockChoreAssignmentFindMany,
    },
    choreTemplate: {
      findMany: mockChoreTemplateFindMany,
    },
    $transaction: (callback: (tx: unknown) => unknown) => mockTransaction(callback),
  },
}));

vi.mock("@/lib/chore-allocator", () => ({
  allocateChores: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendChoreRosterEmail: vi.fn(),
}));

vi.mock("@/lib/guest-chore-token", () => ({
  createGuestChoreToken: vi.fn(),
}));

vi.mock("@/lib/member-utils", () => ({
  getEffectiveEmail: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("GET /api/admin/roster/[date] age tier display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: mockTxExecuteRaw,
        choreAssignment: {
          findMany: mockTxChoreAssignmentFindMany,
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
      })
    );
  });

  it("prefers the linked member age tier over the booking guest snapshot", async () => {
    mockBookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
        guests: [
          {
            id: "guest-1",
            firstName: "Malia",
            lastName: "Hartley-Smith",
            ageTier: "CHILD",
            member: { ageTier: "YOUTH" },
          },
        ],
      },
    ]);
    mockTxChoreAssignmentFindMany.mockResolvedValue([
      {
        id: "assignment-1",
        choreTemplateId: "chore-1",
        choreTemplate: {
          id: "chore-1",
          name: "Kitchen",
          description: null,
          sortOrder: 1,
        },
        bookingGuestId: "guest-1",
        bookingGuest: {
          firstName: "Malia",
          lastName: "Hartley-Smith",
          ageTier: "CHILD",
          member: { ageTier: "YOUTH" },
        },
        bookingId: "booking-1",
        status: "CONFIRMED",
      },
    ]);
    mockChoreTemplateFindMany.mockResolvedValue([
      {
        id: "chore-1",
        name: "Kitchen",
        description: null,
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 1,
        isEssential: true,
        ageRestriction: "ANY",
        conditionalNote: null,
        minAge: 0,
        sortOrder: 1,
        active: true,
      },
    ]);
    mockChoreAssignmentFindMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/roster/[date]/route");
    const req = new NextRequest("http://localhost/api/admin/roster/2026-07-10");

    const res = await GET(req, { params: Promise.resolve({ date: "2026-07-10" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.guests[0].ageTier).toBe("YOUTH");
    expect(data.assignments[0].guestAgeTier).toBe("YOUTH");
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1);
  });
});
