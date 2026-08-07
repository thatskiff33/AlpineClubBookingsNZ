import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
  #2621 — the expected arrival time's two writers recorded nothing.

  WHY THAT MATTERED RATHER THAN BEING UNTIDY. Since #1313 option A2 a Booking
  Officer may set or clear the time on ANY member's booking, so the field has two
  possible authors and, before this, no way to tell them apart — or to answer "who
  changed this" at all. The clear is the worse of the two, because it destroys the
  previous value and left nothing behind that said one had existed.

  Both rows are asserted here for CONTENT, not merely presence: the subject is the
  booking's owner rather than whoever pressed the button, `onBehalf` distinguishes
  the two authorities, and the clear carries the value it destroyed. A test that
  only counted calls would pass on a row that named the wrong member.
*/

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mocks.requireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
      update: (...args: unknown[]) => mocks.bookingUpdate(...args),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  PUT as putArrivalTime,
  DELETE as deleteArrivalTime,
} from "@/app/api/bookings/[id]/arrival-time/route";

const BOOKING_ID = "booking-1";
const OWNER_ID = "owner-1";
const OFFICER_ID = "officer-1";

const OWNER_SESSION = {
  user: { id: OWNER_ID, role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const OFFICER_SESSION = {
  user: {
    id: OFFICER_ID,
    role: "MEMBER",
    accessRoles: [{ role: "ADMIN_BOOKINGS" }],
  },
};

/** Far enough ahead that the "check-in has passed" guard never fires. */
const FUTURE_CHECK_IN = new Date("2099-06-01T00:00:00.000Z");

function bookingRow(expectedArrivalTime: string | null = null) {
  return {
    memberId: OWNER_ID,
    checkIn: FUTURE_CHECK_IN,
    status: "CONFIRMED",
    expectedArrivalTime,
  };
}

function putRequest(expectedArrivalTime: string) {
  return new NextRequest("http://localhost/api/bookings/booking-1/arrival-time", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedArrivalTime }),
  });
}

function deleteRequest() {
  return new NextRequest("http://localhost/api/bookings/booking-1/arrival-time", {
    method: "DELETE",
  });
}

const params = Promise.resolve({ id: BOOKING_ID });

describe("expected arrival time writers record what they did (#2621)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("records the owner's own set, naming the owner as subject and not on-behalf", async () => {
    mocks.auth.mockResolvedValue(OWNER_SESSION);
    mocks.bookingFindUnique.mockResolvedValue(bookingRow(null));
    mocks.bookingUpdate.mockResolvedValue({
      id: BOOKING_ID,
      expectedArrivalTime: "17:30",
    });

    const response = await putArrivalTime(putRequest("17:30"), { params });

    expect(response.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      action: "booking.expected_arrival_time.set",
      memberId: OWNER_ID,
      subjectMemberId: OWNER_ID,
      entityType: "Booking",
      entityId: BOOKING_ID,
      category: "booking",
      outcome: "success",
      metadata: { expectedArrivalTime: "17:30", onBehalf: false },
    });
  });

  it("marks an officer's set on someone else's booking as on-behalf", async () => {
    mocks.auth.mockResolvedValue(OFFICER_SESSION);
    mocks.bookingFindUnique.mockResolvedValue(bookingRow(null));
    mocks.bookingUpdate.mockResolvedValue({
      id: BOOKING_ID,
      expectedArrivalTime: "09:00",
    });

    const response = await putArrivalTime(putRequest("09:00"), { params });

    expect(response.status).toBe(200);
    // The distinction the widening in #1313 created: same row, different author.
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      memberId: OFFICER_ID,
      subjectMemberId: OWNER_ID,
      metadata: { onBehalf: true },
    });
  });

  it("records the value a clear destroyed, because nothing else holds it", async () => {
    mocks.auth.mockResolvedValue(OWNER_SESSION);
    mocks.bookingFindUnique.mockResolvedValue(bookingRow("18:00"));
    mocks.bookingUpdate.mockResolvedValue({
      id: BOOKING_ID,
      expectedArrivalTime: null,
    });

    const response = await deleteArrivalTime(deleteRequest(), { params });

    expect(response.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({
      action: "booking.expected_arrival_time.cleared",
      subjectMemberId: OWNER_ID,
      category: "booking",
      metadata: { clearedExpectedArrivalTime: "18:00", onBehalf: false },
    });
  });

  it("writes no audit row when the value is refused", async () => {
    mocks.auth.mockResolvedValue(OWNER_SESSION);
    mocks.bookingFindUnique.mockResolvedValue(bookingRow(null));

    // `17:20` is the defect this issue also fixes: the old `[0-5]0` pattern
    // accepted it while its own message said "30-minute increments".
    const response = await putArrivalTime(putRequest("17:20"), { params });

    expect(response.status).toBe(400);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("writes no audit row when the caller is refused", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "intruder-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    mocks.bookingFindUnique.mockResolvedValue(bookingRow("18:00"));

    const response = await deleteArrivalTime(deleteRequest(), { params });

    expect(response.status).toBe(403);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("accepts the canonical half-hour set and refuses every off-step minute", async () => {
    mocks.auth.mockResolvedValue(OWNER_SESSION);

    for (const accepted of ["00:00", "06:30", "17:00", "23:00"]) {
      vi.clearAllMocks();
      mocks.requireActiveSessionUser.mockResolvedValue(null);
      mocks.auth.mockResolvedValue(OWNER_SESSION);
      mocks.bookingFindUnique.mockResolvedValue(bookingRow(null));
      mocks.bookingUpdate.mockResolvedValue({
        id: BOOKING_ID,
        expectedArrivalTime: accepted,
      });
      const ok = await putArrivalTime(putRequest(accepted), { params });
      expect(ok.status, `${accepted} should be accepted`).toBe(200);
    }

    for (const refused of ["17:10", "17:20", "17:40", "17:50", "17:15", "24:00"]) {
      vi.clearAllMocks();
      mocks.requireActiveSessionUser.mockResolvedValue(null);
      mocks.auth.mockResolvedValue(OWNER_SESSION);
      mocks.bookingFindUnique.mockResolvedValue(bookingRow(null));
      const bad = await putArrivalTime(putRequest(refused), { params });
      expect(bad.status, `${refused} should be refused`).toBe(400);
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    }
  });
});
