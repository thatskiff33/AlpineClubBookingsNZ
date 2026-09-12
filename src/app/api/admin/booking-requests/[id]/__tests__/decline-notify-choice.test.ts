import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level threading for the per-decline requester-email choice (#1791,
// mirroring #1769a / #1705): an admin-only route (`requireAdmin`) accepts an
// optional `notifyMember` boolean — absent = notify (default), false =
// suppress, non-boolean = 400 — and threads it into `declineBookingRequest`.
// There is no extra actor gate and therefore no 403 case: `requireAdmin`
// already restricts the route to admins.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  declineBookingRequest: vi.fn(),
  serializeBookingRequestForAdmin: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/booking-request", () => {
  // The route uses `err instanceof BookingRequestError`; a minimal class keeps
  // the import resolvable. Success-path tests never hit the catch branch.
  class BookingRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class BookingRequestDeclineCommittedError extends BookingRequestError {
    holdReleasePending: boolean;
    holdReleaseStatusUnconfirmed: boolean;
    override cause: unknown;
    constructor(input: {
      message: string;
      status: number;
      holdReleasePending: boolean;
      holdReleaseStatusUnconfirmed: boolean;
      cause?: unknown;
    }) {
      super(input.message, input.status);
      this.holdReleasePending = input.holdReleasePending;
      this.holdReleaseStatusUnconfirmed = input.holdReleaseStatusUnconfirmed;
      this.cause = input.cause;
    }
  }
  return {
    BookingRequestError,
    BookingRequestDeclineCommittedError,
    declineBookingRequest: h.declineBookingRequest,
    serializeBookingRequestForAdmin: h.serializeBookingRequestForAdmin,
  };
});
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));

import { POST } from "@/app/api/admin/booking-requests/[id]/decline/route";
import { BookingRequestDeclineCommittedError } from "@/lib/booking-request";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

function req(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/booking-requests/req-1/decline",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const params = Promise.resolve({ id: "req-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.declineBookingRequest.mockResolvedValue({ id: "req-1", status: "DECLINED" });
  h.serializeBookingRequestForAdmin.mockReturnValue({
    id: "req-1",
    status: "DECLINED",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/booking-requests/[id]/decline notify choice (#1791)", () => {
  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await POST(req({ reason: "Fully booked" }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0].notifyMember).toBeUndefined();
  });

  it("threads notifyMember: false to the service", async () => {
    const res = await POST(req({ notifyMember: false }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0]).toMatchObject({
      notifyMember: false,
    });
  });

  it("threads notifyMember: true to the service", async () => {
    const res = await POST(req({ notifyMember: true }), { params });

    expect(res.status).toBe(200);
    expect(h.declineBookingRequest).toHaveBeenCalledTimes(1);
    expect(h.declineBookingRequest.mock.calls[0][0]).toMatchObject({
      notifyMember: true,
    });
  });

  it("rejects a non-boolean notifyMember with 400 and never calls the service", async () => {
    const res = await POST(req({ notifyMember: "false" }), { params });

    expect(res.status).toBe(400);
    expect(h.declineBookingRequest).not.toHaveBeenCalled();
  });

  it("reports the committed decline and pending hold release on participant contention", async () => {
    h.declineBookingRequest.mockRejectedValue(
      new BookingRequestDeclineCommittedError({
        message: "Capacity hold release must be retried.",
        status: 409,
        holdReleasePending: true,
        holdReleaseStatusUnconfirmed: false,
        cause: new HostingCoverageParticipantRetryError(),
      }),
    );

    const response = await POST(req({ reason: "Fully booked" }), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      requestDeclined: true,
      holdReleasePending: true,
      holdReleaseStatusUnconfirmed: false,
    });
  });

  it("reports an ordinary post-decline failure without exposing private details", async () => {
    h.declineBookingRequest.mockRejectedValue(
      new BookingRequestDeclineCommittedError({
        message:
          "The request was declined, but its capacity hold status could not be confirmed. Open the held booking and check its status before retrying.",
        status: 500,
        holdReleasePending: false,
        holdReleaseStatusUnconfirmed: true,
        cause: new Error("private database detail"),
      }),
    );

    const response = await POST(req({ reason: "Fully booked" }), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "The request was declined, but its capacity hold status could not be confirmed. Open the held booking and check its status before retrying.",
      requestDeclined: true,
      holdReleasePending: false,
      holdReleaseStatusUnconfirmed: true,
    });
  });
});
