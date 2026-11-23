import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { expectDefaultInvalidJsonAnswer } from "./helpers/invalid-json-body";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/booking-delete", () => ({
  deleteBooking: vi.fn(),
}));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { DELETE } from "@/app/api/bookings/[id]/route";
import { auth } from "@/lib/auth";
import { deleteBooking } from "@/lib/booking-delete";

const mockedAuth = vi.mocked(auth);
const mockedDeleteBooking = vi.mocked(deleteBooking);

function makeDeleteRequest(body?: BodyInit) {
  return new NextRequest("http://localhost/api/bookings/booking-1", {
    method: "DELETE",
    body,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

describe("DELETE /api/bookings/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    mockedDeleteBooking.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        mode: "hard-delete",
        bookingId: "booking-1",
        message: "Draft booking deleted",
      },
    });
  });

  it("deletes a booking without requiring a request body", async () => {
    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockedDeleteBooking).toHaveBeenCalledWith({
      bookingId: "booking-1",
      actor: {
        memberId: "member-1",
        role: "USER",
        ipAddress: "127.0.0.1",
      },
      reason: undefined,
    });
  });

  it("rejects invalid JSON without deleting", async () => {
    const response = await DELETE(makeDeleteRequest("{"), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    // #5407 item 28: read through the shared optional reader, so the answer is
    // the shared default, byte for byte.
    await expectDefaultInvalidJsonAnswer(response);
    expect(mockedDeleteBooking).not.toHaveBeenCalled();
  });

  it("refuses a JSON null body with the schema 400 and deletes nothing (#5407)", async () => {
    // Only an absent body means "delete without a reason"; null is a wrong shape.
    const response = await DELETE(makeDeleteRequest("null"), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid input" });
    expect(mockedDeleteBooking).not.toHaveBeenCalled();
  });

  it("deletes without a reason for an empty or whitespace-only JSON body (#5407)", async () => {
    for (const body of ["", " \n"]) {
      mockedDeleteBooking.mockClear();
      const response = await DELETE(makeDeleteRequest(body), {
        params: Promise.resolve({ id: "booking-1" }),
      });

      expect(response.status).toBe(200);
      expect(mockedDeleteBooking).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1", reason: undefined }),
      );
    }
  });

  it("validates the optional deletion reason", async () => {
    const response = await DELETE(
      makeDeleteRequest(JSON.stringify({ reason: "" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid input",
      details: {
        fieldErrors: {
          reason: expect.any(Array),
        },
      },
    });
    expect(mockedDeleteBooking).not.toHaveBeenCalled();
  });

  it("returns blocker details from unsafe cancelled delete attempts", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    } as any);
    mockedDeleteBooking.mockResolvedValueOnce({
      status: 409,
      error:
        "Cancelled booking cannot be deleted because financial or Xero history exists",
      blockers: [
        { code: "payment_record", label: "Payment record exists", count: 1 },
      ],
    });

    const response = await DELETE(
      makeDeleteRequest(JSON.stringify({ reason: "Duplicate booking" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Cancelled booking cannot be deleted because financial or Xero history exists",
      blockers: [
        { code: "payment_record", label: "Payment record exists", count: 1 },
      ],
    });
  });
});
