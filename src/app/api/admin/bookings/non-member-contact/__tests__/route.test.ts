import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockCreate = vi.fn();
const mockReuse = vi.fn();
const mockSuggest = vi.fn();
// Keep the REAL create schema + NonMemberContactError (the route builds a zod
// union with the schema and does `instanceof NonMemberContactError`); override
// only the three service functions.
vi.mock("@/lib/non-member-contact", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/non-member-contact");
  return {
    ...actual,
    createNonMemberContact: (...a: unknown[]) => mockCreate(...a),
    reuseNonMemberContact: (...a: unknown[]) => mockReuse(...a),
    suggestNonMemberContacts: (...a: unknown[]) => mockSuggest(...a),
  };
});
// Light stubs so importing the real service module (for its schema/error) is
// cheap and side-effect free.
vi.mock("@/lib/booking-request", () => ({
  MAPPABLE_CONTACT_ROLES: ["NON_MEMBER", "SCHOOL"],
  BookingRequestError: class BookingRequestError extends Error {
    status = 400;
  },
  assertMappableOwnerContact: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { member: {}, $transaction: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { GET, POST } from "@/app/api/admin/bookings/non-member-contact/route";
import { NonMemberContactError } from "@/lib/non-member-contact";

function okGuard(userId = "officer1") {
  return { ok: true as const, session: { user: { id: userId } } };
}
function forbiddenGuard() {
  return {
    ok: false as const,
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/bookings/non-member-contact", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/bookings/non-member-contact (#1935)", () => {
  it("gates the endpoint on bookings:edit", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockCreate.mockResolvedValue({ id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@example.com", isPlaceholderEmail: false });

    await POST(postReq({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" }));

    expect(mockRequireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "edit" } });
  });

  it("403s a caller without bookings:edit (view-only / membership-only)", async () => {
    mockRequireAdmin.mockResolvedValue(forbiddenGuard());
    const res = await POST(postReq({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" }));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a new non-member owner (201, reused:false) with the acting admin", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard("officer1"));
    mockCreate.mockResolvedValue({ id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@example.com", isPlaceholderEmail: false });

    const res = await POST(postReq({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reused).toBe(false);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ actorMemberId: "officer1", firstName: "Jane" }));
  });

  it("reuses an explicitly picked existing contact (200, reused:true)", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockReuse.mockResolvedValue({ id: "c9", firstName: "Org", lastName: "Contact", email: "org@example.com", isPlaceholderEmail: false });

    const res = await POST(postReq({ useExistingContactId: "c9" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reused).toBe(true);
    expect(mockReuse).toHaveBeenCalledWith("c9");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload (missing names) with 400", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    const res = await POST(postReq({ email: "jane@example.com" }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a login-capable email collision to its structured error", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockCreate.mockRejectedValue(
      new NonMemberContactError("pick them in the member search", 409, "LOGIN_MEMBER_EXISTS"),
    );

    const res = await POST(postReq({ firstName: "Jane", lastName: "Doe", email: "jane@example.com" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LOGIN_MEMBER_EXISTS");
  });
});

describe("GET /api/admin/bookings/non-member-contact (#1935)", () => {
  it("gates suggestions on bookings:edit and returns matches", async () => {
    mockRequireAdmin.mockResolvedValue(okGuard());
    mockSuggest.mockResolvedValue([{ id: "s1", firstName: "Rita", lastName: "Repeat", email: "rita@example.com", isPlaceholderEmail: false, role: "NON_MEMBER", phoneNumber: null, bookingCount: 2 }]);

    const req = new NextRequest("http://localhost/api/admin/bookings/non-member-contact?email=rita@example.com");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockRequireAdmin).toHaveBeenCalledWith({ permission: { area: "bookings", level: "edit" } });
    const body = await res.json();
    expect(body.contacts).toHaveLength(1);
  });

  it("403s suggestions without bookings:edit", async () => {
    mockRequireAdmin.mockResolvedValue(forbiddenGuard());
    const req = new NextRequest("http://localhost/api/admin/bookings/non-member-contact?email=rita@example.com");
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(mockSuggest).not.toHaveBeenCalled();
  });
});
