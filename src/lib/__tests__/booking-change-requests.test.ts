import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
  bookingChangeRequestFindMany: vi.fn(),
  bookingChangeRequestCount: vi.fn(),
  bookingChangeRequestFindUnique: vi.fn(),
  bookingChangeRequestUpdateMany: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAdminBookingChangeRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    // #1982: default lodge capacity is a self-healed DB override.
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
      findMany: (...args: unknown[]) => mocks.bookingChangeRequestFindMany(...args),
      count: (...args: unknown[]) => mocks.bookingChangeRequestCount(...args),
      findUnique: (...args: unknown[]) => mocks.bookingChangeRequestFindUnique(...args),
      updateMany: (...args: unknown[]) => mocks.bookingChangeRequestUpdateMany(...args),
    },
    bookingModification: {
      findUnique: (...args: unknown[]) => mocks.bookingModificationFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  getClientIp: (...args: unknown[]) => mocks.getClientIp(...args),
  rateLimiters: {
    bookingChangeRequest: {
      id: "booking-change-request",
      limit: 5,
      windowSeconds: 24 * 60 * 60,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminBookingChangeRequestAlert(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  GET as getMemberBookingChangeRequests,
  POST as postBookingChangeRequest,
} from "@/app/api/bookings/[id]/change-requests/route";
import { GET as getAdminBookingChangeRequests } from "@/app/api/admin/booking-change-requests/route";
import { PATCH as patchAdminBookingChangeRequest } from "@/app/api/admin/booking-change-requests/[id]/route";

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "COMPLETED",
    checkIn: new Date("2026-05-23T00:00:00.000Z"),
    checkOut: new Date("2026-05-27T00:00:00.000Z"),
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: new Date("2026-05-23T00:00:00.000Z"),
        stayEnd: new Date("2026-05-27T00:00:00.000Z"),
      },
    ],
    member: {
      id: "member-1",
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
    },
    payment: {
      id: "payment-1",
      amountCents: 12000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_123",
      xeroInvoiceId: "xero-inv-1",
      xeroInvoiceNumber: "INV-001",
    },
    ...overrides,
  };
}

describe("booking change requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    mocks.checkRateLimit.mockReturnValue({
      success: true,
      limit: 5,
      remaining: 4,
      resetAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
    mocks.bookingChangeRequestCreate.mockResolvedValue({
      id: "request-1",
      bookingId: "booking-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      requestedChanges: {},
      reason: "Weather closed the road.",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.sendAdminBookingChangeRequestAlert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an admin-reviewed request for a locked in-progress checkout change", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.bookingChangeRequestCreate).toHaveBeenCalledWith(
      // #2562 review: the create also carries the member-readable manifest as its
      // `select`, so the 201 body cannot name the officer's private note. Matched
      // loosely here and pinned exactly in its own case below.
      expect.objectContaining({
      data: expect.objectContaining({
        bookingId: "booking-1",
        requestedByMemberId: "member-1",
        reason: "Weather closed the road.",
        requestedChanges: expect.objectContaining({
          requested: expect.objectContaining({
            checkOut: "2026-05-24",
            summary: "check-out to 2026-05-24",
          }),
          lockedPeriod: expect.objectContaining({
            today: "2026-05-24",
            editableFrom: "2026-05-25",
            touchesLockedPeriod: true,
          }),
          payment: expect.objectContaining({
            xeroInvoiceId: "xero-inv-1",
            amountCents: 12000,
          }),
        }),
      }),
      }),
    );
    expect(mocks.sendAdminBookingChangeRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        requestId: "request-1",
        requestedSummary: "check-out to 2026-05-24",
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-change-request.create",
        entityId: "request-1",
        subjectMemberId: "member-1",
        ipAddress: "127.0.0.1",
      })
    );
  });

  it("refuses a change request against the member's own DRAFT (#2266 LOW-7)", async () => {
    // A draft is directly member-editable, so a change-request queue entry for
    // one is pure noise for admins — the route refuses it outright even for a
    // request shape that would otherwise touch the locked period.
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ status: "DRAFT" }));

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/edited directly/i);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminBookingChangeRequestAlert).not.toHaveBeenCalled();
  });

  it("rejects request submissions for changes that remain self-service eligible", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-26",
          reason: "Leaving one day early.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rejects booking change requests when the booking has no editable future nights", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        checkIn: new Date("2026-05-20T00:00:00.000Z"),
        checkOut: new Date("2026-05-22T00:00:00.000Z"),
      })
    );

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestedEffectiveDate: "2026-05-24",
          reason: "Late correction.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rejects removal requests for guests outside the booking", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          removeGuestIds: ["guest-missing"],
          requestedEffectiveDate: "2026-05-24",
          reason: "Wrong guest.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rate limits repeated booking change request submissions by member", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkRateLimit.mockReturnValue({
      success: false,
      limit: 5,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-change-request" }),
      "member-1"
    );
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("lists pending requests for admins", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([
      {
        id: "request-1",
        booking: { checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      },
      {
        id: "request-2",
        booking: { checkOut: new Date("2026-05-20T00:00:00.000Z"), status: "COMPLETED" },
      },
    ]);
    mocks.bookingChangeRequestCount.mockResolvedValue(1);

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests?status=REQUESTED"
    );
    const response = await getAdminBookingChangeRequests(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    // #3750: the panel is told which approvals EXECUTE (a finished stay) from
    // the same `isFinishedStay` the decision route asks.
    expect(body.data.map((row: { executesOnApproval: boolean }) => row.executesOnApproval)).toEqual([
      false,
      true,
    ]);
    expect(mocks.bookingChangeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // #2524: the legacy locked-period queue now also filters kind, so
        // POLICY_EXCEPTION rows (decided via #2525) never appear here.
        where: { kind: "LOCKED_PERIOD", status: "REQUESTED" },
        take: 25,
      })
    );
  });

  it("excludes POLICY_EXCEPTION rows from the legacy locked-period list AND its count (#2524)", async () => {
    // Both the page query and its total must be scoped to LOCKED_PERIOD so a
    // POLICY_EXCEPTION row can never leak into this legacy queue (which would
    // inflate the REQUESTED count and 409 on a legacy Approve). status=ALL
    // exercises the branch that previously used an unscoped `{}` where.
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([
      {
        id: "locked-1",
        booking: { checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      },
    ]);
    mocks.bookingChangeRequestCount.mockResolvedValue(1);

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests?status=ALL"
    );
    const response = await getAdminBookingChangeRequests(request);
    await response.json();

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: "LOCKED_PERIOD" }),
      })
    );
    expect(mocks.bookingChangeRequestCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ kind: "LOCKED_PERIOD" }),
    });
  });

  it("marks a requested change approved with audit context", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "APPROVED",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          status: "APPROVED",
          execute: false,
          adminNotes: "Handled manually through the booking edit flow.",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // #2524: the locked-period queue claim now also filters kind, so it can
        // never transition a POLICY_EXCEPTION request (which #2525 owns).
        where: { id: "request-1", status: "REQUESTED", kind: "LOCKED_PERIOD" },
        data: expect.objectContaining({
          status: "APPROVED",
          adminNotes: "Handled manually through the booking edit flow.",
          reviewedByMemberId: "admin-1",
          linkedModificationId: null,
        }),
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-change-request.approve",
        subjectMemberId: "member-1",
      })
    );
  });

  it("approves and links the executed booking modification when its id is provided", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "APPROVED",
        linkedModificationId: "mod-7",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      id: "mod-7",
      bookingId: "booking-1",
    });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          execute: false,
          adminNotes: "Edit applied via /modify",
          linkedModificationId: "mod-7",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          linkedModificationId: "mod-7",
        }),
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedModificationId: "mod-7" }),
      })
    );
  });

  it("rejects approval when the linked booking modification does not belong to the booking", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique.mockResolvedValueOnce({
      id: "request-1",
      status: "REQUESTED",
      booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      id: "mod-9",
      bookingId: "another-booking",
    });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          execute: false,
          adminNotes: "x",
          linkedModificationId: "mod-9",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * #2562 review — the locked-period half of this table gets the note split too.
   *
   * The lane declared the officer-note audience rule TABLE-WIDE in the schema and
   * in DOMAIN_INVARIANTS, but only rewrote the policy-exception surface. This route
   * writes the SAME member-visible `adminNotes` column from a panel whose box was
   * headed just "Admin notes", and it had no field for the private note the lane
   * created — so the remedy did not reach the surface whose label most invited the
   * mistake. These assertions pin both halves of the fix at the route: the private
   * note is stored, and the audit row records only that one exists.
   */
  it("stores the officer's private note beside the member-facing one (#2562)", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        kind: "LOCKED_PERIOD",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REJECTED",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          adminNotes: "Those nights are already committed, sorry.",
          internalNotes: "Third ask this month, do not encourage.",
        }),
      },
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminNotes: "Those nights are already committed, sorry.",
          internalNotes: "Third ask this month, do not encourage.",
        }),
      }),
    );
    // The audit trail records EXISTENCE, never the text: it is read by more
    // surfaces than this queue, and the copy would be private in one place only.
    const audit = mocks.logAudit.mock.calls.at(-1)?.[0] as {
      details?: unknown;
      metadata?: Record<string, unknown>;
    };
    expect(audit.metadata?.internalNoteRecorded).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("do not encourage");
  });

  it("records no internal note when the officer left none (#2562)", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        kind: "LOCKED_PERIOD",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REJECTED",
        booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          adminNotes: "Those nights are already committed, sorry.",
        }),
      },
    );

    await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ internalNotes: null }),
      }),
    );
    const audit = mocks.logAudit.mock.calls.at(-1)?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(audit.metadata?.internalNoteRecorded).toBe(false);
  });

  it("rejects approval when the linked booking modification does not exist", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique.mockResolvedValueOnce({
      id: "request-1",
      status: "REQUESTED",
      booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          execute: false,
          adminNotes: "x",
          linkedModificationId: "mod-missing",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to review a POLICY_EXCEPTION request through the locked-period queue (#2524)", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.bookingChangeRequestFindUnique.mockResolvedValueOnce({
      id: "request-1",
      status: "REQUESTED",
      kind: "POLICY_EXCEPTION",
      booking: { id: "booking-1", memberId: "member-1", checkOut: new Date("2026-05-27T00:00:00.000Z"), status: "PAID" },
    });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        body: JSON.stringify({ status: "APPROVED" }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(409);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects rejection that includes a linked modification id", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          adminNotes: "x",
          linkedModificationId: "mod-7",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("returns a member's booking change requests for their booking", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ memberId: "member-1" });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([{ id: "request-1" }]);

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests"
    );
    const response = await getMemberBookingChangeRequests(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([{ id: "request-1" }]);
    expect(mocks.bookingChangeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "booking-1" },
        take: 50,
      })
    );
  });

  /**
   * #2562 — the officer's PRIVATE note must not travel on this route.
   *
   * The read is authorised for the booking's OWNER as well as an officer, and it
   * returns every change request on the booking with no `kind` filter, so
   * POLICY_EXCEPTION rows come back here too. It used to read with `include:`,
   * which returns every scalar column on the model — including `internalNotes`
   * once #2562 added it. These two cases pin the projection rather than the
   * absence of a leak in one fixture: the first proves the query names its
   * columns and never asks for the note, the second proves the route does not
   * pass a note through even if a stale mock (or a future raw query) hands it one.
   */
  it("never asks the database for the officer's internal note", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ memberId: "member-1" });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([]);

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests"
    );
    await getMemberBookingChangeRequests(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    const args = mocks.bookingChangeRequestFindMany.mock.calls[0][0] as {
      select?: Record<string, unknown>;
      include?: unknown;
    };
    // An explicit projection, not `include:` — the shape that cannot leak the
    // NEXT column either.
    expect(args.include).toBeUndefined();
    expect(args.select).toBeDefined();
    expect(args.select).not.toHaveProperty("internalNotes");
    expect(args.select).not.toHaveProperty("openStateKey");
    // The member-facing explanation is still readable; the split is only safe
    // while a refused member can read why.
    expect(args.select).toHaveProperty("adminNotes", true);
    expect(args.select).toHaveProperty("requestedBy");
    expect(args.select).toHaveProperty("reviewedBy");
  });

  it("does not serialise an internal note even if one reaches the route", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ memberId: "member-1" });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([
      {
        id: "request-1",
        kind: "POLICY_EXCEPTION",
        adminNotes: "Not that weekend, sorry.",
        internalNotes: "Chases every officer until somebody says yes.",
      },
    ]);

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests"
    );
    const response = await getMemberBookingChangeRequests(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(raw).toContain("Not that weekend, sorry.");
    expect(raw).not.toContain("internalNotes");
    expect(raw).not.toContain("Chases every officer");
  });

  /**
   * #2562 review — the POST on this route returns a row to the member too.
   *
   * The GET was projected and pinned; the create was not. `prisma.create` with no
   * `select` returns every scalar column, and line ~473 hands that row straight
   * back as the 201 body, so the member's browser received `"internalNotes": null`.
   * Nothing leaked TODAY, because a row this new cannot carry a note yet — but the
   * lane's own written boundary ("names its columns explicitly and omits
   * internalNotes") was false for this handler, and neither the manifest census nor
   * the two GET cases watched it. These two pin the query and the serialisation
   * separately, so the next edit that returns a row which is NOT brand new (an
   * upsert so a member can resubmit into their open request, a re-read after
   * `linkedModificationId` is set, a shared helper reused here) fails here.
   */
  it("creates through the member-readable manifest, never every column", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      },
    );
    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(201);
    const args = mocks.bookingChangeRequestCreate.mock.calls[0][0] as {
      select?: Record<string, unknown>;
      include?: unknown;
    };
    expect(args.include).toBeUndefined();
    expect(args.select).toBeDefined();
    expect(args.select).not.toHaveProperty("internalNotes");
    expect(args.select).not.toHaveProperty("openStateKey");
    // The member-facing explanation stays readable, exactly as on the GET.
    expect(args.select).toHaveProperty("adminNotes", true);
  });

  it("does not serialise an internal note out of the create either", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    // A stale mock standing in for a future raw query, an `include:` regression or
    // a shared helper: the row reaching the handler carries the private note, and
    // the whitelist re-projection is what stops it reaching the wire.
    mocks.bookingChangeRequestCreate.mockResolvedValue({
      id: "request-1",
      bookingId: "booking-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      requestedChanges: {},
      reason: "Weather closed the road.",
      adminNotes: "We will look at this on Monday.",
      internalNotes: "Third ask this month, do not encourage.",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      },
    );
    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const raw = await response.text();

    expect(response.status).toBe(201);
    expect(raw).toContain("We will look at this on Monday.");
    expect(raw).not.toContain("internalNotes");
    expect(raw).not.toContain("do not encourage");
  });
});
