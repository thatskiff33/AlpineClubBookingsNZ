import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadInvoiceBlockers: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
  },
}));

// #2392: the unpaid-invoice half is exercised in its own suite; here it is
// stubbed so these tests stay about the booking half and the merge.
vi.mock("@/lib/membership-cancellation-invoice-blockers", () => ({
  loadMembershipCancellationInvoiceBlockersByMemberId: mocks.loadInvoiceBlockers,
}));

import {
  loadMembershipCancellationBlockersByMemberId,
  type MembershipCancellationBlockerClient,
} from "@/lib/membership-cancellation-blockers";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadInvoiceBlockers.mockImplementation(
    async (memberIds: readonly string[]) =>
      new Map(memberIds.map((memberId) => [memberId, []])),
  );
});

describe("membership cancellation blockers", () => {
  it("loads future owned bookings and guest appearances by member", async () => {
    const bookingFindMany = vi.fn().mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        status: "PAID",
      },
    ]);
    const bookingGuestFindMany = vi.fn().mockResolvedValue([
      {
        id: "guest-1",
        memberId: "member-1",
        stayStart: new Date("2099-02-01T00:00:00.000Z"),
        stayEnd: new Date("2099-02-02T00:00:00.000Z"),
        booking: {
          id: "booking-2",
          status: "CONFIRMED",
          checkIn: new Date("2099-02-01T00:00:00.000Z"),
          checkOut: new Date("2099-02-02T00:00:00.000Z"),
        },
      },
      {
        id: "unlinked-guest",
        memberId: null,
        stayStart: new Date("2099-03-01T00:00:00.000Z"),
        stayEnd: new Date("2099-03-02T00:00:00.000Z"),
        booking: {
          id: "booking-3",
          status: "PAID",
          checkIn: new Date("2099-03-01T00:00:00.000Z"),
          checkOut: new Date("2099-03-02T00:00:00.000Z"),
        },
      },
    ]);
    const db = {
      booking: { findMany: bookingFindMany },
      bookingGuest: { findMany: bookingGuestFindMany },
    } as unknown as MembershipCancellationBlockerClient;

    const blockers = await loadMembershipCancellationBlockersByMemberId(
      ["member-1", "member-1", "member-2"],
      db,
    );

    expect(bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberId: { in: ["member-1", "member-2"] },
        }),
      }),
    );
    expect(blockers.get("member-1")).toEqual([
      {
        type: "owned_booking",
        bookingId: "booking-1",
        bookingStatus: "PAID",
        checkIn: "2099-01-01T00:00:00.000Z",
        checkOut: "2099-01-03T00:00:00.000Z",
      },
      {
        type: "guest_appearance",
        bookingId: "booking-2",
        bookingStatus: "CONFIRMED",
        checkIn: "2099-02-01T00:00:00.000Z",
        checkOut: "2099-02-02T00:00:00.000Z",
        guestAppearanceId: "guest-1",
      },
    ]);
    expect(blockers.get("member-2")).toEqual([]);
  });

  it("merges unpaid Xero invoices in after the booking blockers", async () => {
    const db = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "booking-1",
            memberId: "member-1",
            checkIn: new Date("2099-01-01T00:00:00.000Z"),
            checkOut: new Date("2099-01-03T00:00:00.000Z"),
            status: "PAID",
          },
        ]),
      },
      bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as MembershipCancellationBlockerClient;
    mocks.loadInvoiceBlockers.mockResolvedValue(
      new Map([
        [
          "member-1",
          [
            {
              type: "unpaid_invoice",
              invoiceId: "inv-1",
              invoiceNumber: "INV-0042",
              invoiceStatus: "AUTHORISED",
              direction: "receivable",
              amountDueCents: 12050,
              amountDueTenThousandths: 1205000,
              currency: "NZD",
              dueDate: "2026-06-30",
              xeroUrl: null,
            },
          ],
        ],
      ]),
    );

    const blockers = await loadMembershipCancellationBlockersByMemberId(
      ["member-1"],
      db,
    );

    expect(blockers.get("member-1")?.map((blocker) => blocker.type)).toEqual([
      "owned_booking",
      "unpaid_invoice",
    ]);
  });

  it("passes the caller's fresh-check choice through to the invoice loader", async () => {
    const db = {
      booking: { findMany: vi.fn().mockResolvedValue([]) },
      bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as MembershipCancellationBlockerClient;

    await loadMembershipCancellationBlockersByMemberId(["member-1"], db, {
      freshInvoiceCheck: true,
    });

    expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(["member-1"], {
      fresh: true,
    });
  });

  it("skips ONLY the Xero half when the caller declines it (#2402)", async () => {
    // The review queue rendering for a view-only admin. The booking half costs
    // two local reads and stays; the metered Xero call is the only thing
    // withheld, and a caller can withhold nothing else.
    const db = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "booking-1",
            memberId: "member-1",
            checkIn: new Date("2099-01-01T00:00:00.000Z"),
            checkOut: new Date("2099-01-03T00:00:00.000Z"),
            status: "PAID",
          },
        ]),
      },
      bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as MembershipCancellationBlockerClient;

    const blockers = await loadMembershipCancellationBlockersByMemberId(
      ["member-1"],
      db,
      { invoiceCheck: "skip" },
    );

    expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
    expect(blockers.get("member-1")?.map((blocker) => blocker.type)).toEqual([
      "owned_booking",
    ]);
  });

  it("runs the Xero half by default, so a caller cannot skip it by omission", async () => {
    // Fail-closed: the option defaults to "run", because a forgotten option must
    // produce the full check rather than a quietly partial one.
    const db = {
      booking: { findMany: vi.fn().mockResolvedValue([]) },
      bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as MembershipCancellationBlockerClient;

    await loadMembershipCancellationBlockersByMemberId(["member-1"], db, {});

    expect(mocks.loadInvoiceBlockers).toHaveBeenCalled();
  });

  it("asks Xero nothing when there are no members to check", async () => {
    const db = {
      booking: { findMany: vi.fn() },
      bookingGuest: { findMany: vi.fn() },
    } as unknown as MembershipCancellationBlockerClient;

    const blockers = await loadMembershipCancellationBlockersByMemberId([], db);

    expect(blockers.size).toBe(0);
    expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
  });
});
