import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loggerError: vi.fn(),
  prisma: {
    booking: {
      findMany: vi.fn(),
    },
    xeroObjectLink: {
      findMany: vi.fn(),
    },
    xeroSyncOperation: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { GET as searchBookings } from "@/app/api/admin/bookings/search/route";

describe("Admin booking search route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
    mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue([]);
  });

  it("requires a minimum 2-character query", async () => {
    const response = await searchBookings(
      new NextRequest("http://localhost/api/admin/bookings/search?q=a")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Search query must be at least 2 characters",
    });
    expect(mocks.prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("searches bookings by booking reference number", async () => {
    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "cmnn0xljabc123",
        status: "PAID",
        checkIn: new Date("2026-05-01"),
        checkOut: new Date("2026-05-03"),
        updatedAt: new Date("2026-04-27T10:00:00.000Z"),
        member: {
          firstName: "Alice",
          lastName: "Example",
          email: "alice@example.com",
        },
        payment: {
          id: "payment-123",
          xeroInvoiceId: null,
        },
        _count: {
          guests: 2,
        },
      },
    ]);

    const response = await searchBookings(
      new NextRequest(
        "http://localhost/api/admin/bookings/search?q=Booking%20CMNN0XLJ&limit=8"
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { not: "DRAFT" },
          OR: expect.arrayContaining([
            { id: { startsWith: "cmnn0xlj" } },
          ]),
        }),
        take: 8,
      })
    );

    await expect(response.json()).resolves.toEqual({
      bookings: [
        {
          id: "cmnn0xljabc123",
          memberName: "Alice Example",
          memberEmail: "alice@example.com",
          checkIn: "2026-05-01",
          checkOut: "2026-05-03",
          status: "PAID",
          guestCount: 2,
          paymentId: "payment-123",
          xeroInvoiceId: null,
          canForceSyncInvoice: true,
          forceSyncInvoiceReason: null,
        },
      ],
    });
  });

  it("searches bookings by booking ID or member identity and returns invoice-sync hints", async () => {
    mocks.prisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-123",
        status: "PAID",
        checkIn: new Date("2026-05-01"),
        checkOut: new Date("2026-05-03"),
        updatedAt: new Date("2026-04-27T10:00:00.000Z"),
        member: {
          firstName: "Alice",
          lastName: "Example",
          email: "alice@example.com",
        },
        payment: {
          id: "payment-123",
          xeroInvoiceId: null,
        },
        _count: {
          guests: 2,
        },
      },
      {
        id: "booking-456",
        status: "CANCELLED",
        checkIn: new Date("2026-06-10"),
        checkOut: new Date("2026-06-12"),
        updatedAt: new Date("2026-04-26T10:00:00.000Z"),
        member: {
          firstName: "Bob",
          lastName: "Example",
          email: "bob@example.com",
        },
        payment: null,
        _count: {
          guests: 1,
        },
      },
      {
        id: "booking-789",
        status: "PAID",
        checkIn: new Date("2026-07-04"),
        checkOut: new Date("2026-07-05"),
        updatedAt: new Date("2026-04-25T10:00:00.000Z"),
        member: {
          firstName: "Cara",
          lastName: "Example",
          email: "cara@example.com",
        },
        payment: {
          id: "payment-789",
          xeroInvoiceId: "inv-789",
        },
        _count: {
          guests: 3,
        },
      },
      {
        id: "booking-999",
        status: "PAID",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-02"),
        updatedAt: new Date("2026-04-24T10:00:00.000Z"),
        member: {
          firstName: "Drew",
          lastName: "Example",
          email: "drew@example.com",
        },
        payment: {
          id: "payment-999",
          xeroInvoiceId: null,
        },
        _count: {
          guests: 4,
        },
      },
      {
        id: "booking-222",
        status: "PAID",
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-03"),
        updatedAt: new Date("2026-04-23T10:00:00.000Z"),
        member: {
          firstName: "Eden",
          lastName: "Example",
          email: "eden@example.com",
        },
        payment: {
          id: "payment-222",
          xeroInvoiceId: null,
        },
        _count: {
          guests: 5,
        },
      },
    ]);
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([
      { localId: "payment-999" },
    ]);
    mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue([
      { localId: "payment-222" },
    ]);

    const response = await searchBookings(
      new NextRequest("http://localhost/api/admin/bookings/search?q=alice&limit=8")
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(mocks.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: "DRAFT" },
          OR: [
            { id: { startsWith: "alice" } },
            {
              member: {
                is: {
                  OR: [
                    { firstName: { contains: "alice", mode: "insensitive" } },
                    { lastName: { contains: "alice", mode: "insensitive" } },
                    { email: { contains: "alice", mode: "insensitive" } },
                  ],
                },
              },
            },
          ],
        },
        take: 8,
      })
    );

    expect(body.bookings).toEqual([
      {
        id: "booking-123",
        memberName: "Alice Example",
        memberEmail: "alice@example.com",
        checkIn: "2026-05-01",
        checkOut: "2026-05-03",
        status: "PAID",
        guestCount: 2,
        paymentId: "payment-123",
        xeroInvoiceId: null,
        canForceSyncInvoice: true,
        forceSyncInvoiceReason: null,
      },
      {
        id: "booking-456",
        memberName: "Bob Example",
        memberEmail: "bob@example.com",
        checkIn: "2026-06-10",
        checkOut: "2026-06-12",
        status: "CANCELLED",
        guestCount: 1,
        paymentId: null,
        xeroInvoiceId: null,
        canForceSyncInvoice: false,
        forceSyncInvoiceReason:
          "Only paid bookings can be force-synced to Xero invoices.",
      },
      {
        id: "booking-789",
        memberName: "Cara Example",
        memberEmail: "cara@example.com",
        checkIn: "2026-07-04",
        checkOut: "2026-07-05",
        status: "PAID",
        guestCount: 3,
        paymentId: "payment-789",
        xeroInvoiceId: "inv-789",
        canForceSyncInvoice: false,
        forceSyncInvoiceReason: "This booking is already linked to a Xero invoice.",
      },
      {
        id: "booking-999",
        memberName: "Drew Example",
        memberEmail: "drew@example.com",
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        status: "PAID",
        guestCount: 4,
        paymentId: "payment-999",
        xeroInvoiceId: null,
        canForceSyncInvoice: false,
        forceSyncInvoiceReason: "This booking is already linked to a Xero invoice.",
      },
      {
        id: "booking-222",
        memberName: "Eden Example",
        memberEmail: "eden@example.com",
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        status: "PAID",
        guestCount: 5,
        paymentId: "payment-222",
        xeroInvoiceId: null,
        canForceSyncInvoice: false,
        forceSyncInvoiceReason: "This booking invoice is already queued for background processing.",
      },
    ]);
  });
});
