import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/admin/bed-allocation/allocations/range (#2251).
 *
 * The real route handler and the real requireBedAllocationWrite guard run;
 * assignBedRange is mocked at the lib seam so the route's own contracts can be
 * driven directly: strict input validation, 400-vs-409 on a refusal, the
 * explicit night list passed straight through, and Prisma write-conflict codes
 * mapped to something an admin can act on rather than a generic 500.
 *
 * The single BED_ALLOCATION_RANGE_SET audit entry is deliberately NOT this
 * route's job any more (#2251 review A4): it is written inside assignBedRange's
 * own transaction, and is covered in admin-bed-allocation-range.test.ts.
 */
const {
  mockRequireAdmin,
  mockModuleEnabled,
  mockAssignBedRange,
  mockCreateAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockModuleEnabled: vi.fn(),
  mockAssignBedRange: vi.fn(),
  mockCreateAuditLog: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: () => mockModuleEnabled(),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));
vi.mock("@/lib/bed-allocation-range-assign", async () => {
  const actual = (await vi.importActual("@/lib/bed-allocation-range-assign")) as typeof import("@/lib/bed-allocation-range-assign");
  return {
    ...actual,
    assignBedRange: (...args: unknown[]) => mockAssignBedRange(...args),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

import { Prisma } from "@prisma/client";

function buildResult(
  overrides: Partial<{
    applied: boolean;
    partialByConsent: boolean;
    writtenNights: string[];
    freeNights: string[];
    refusals: Array<Record<string, unknown>>;
  }> = {},
) {
  return {
    applied: overrides.applied ?? true,
    partialByConsent: overrides.partialByConsent ?? false,
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Range Guest",
    bedId: "bed-1",
    bedName: "Bed One",
    roomName: "Room One",
    fromDate: "2026-06-01",
    toDate: "2026-06-04",
    requestedNights: ["2026-06-01", "2026-06-02", "2026-06-03"],
    freeNights: overrides.freeNights ?? [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ],
    writtenNights: overrides.writtenNights ?? [
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ],
    refusals: overrides.refusals ?? [],
    promotedPartners: [],
  };
}

function post(body: unknown) {
  return import(
    "@/app/api/admin/bed-allocation/allocations/range/route"
  ).then(({ POST }) =>
    POST(
      new Request(
        "http://localhost/api/admin/bed-allocation/allocations/range",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body:
            typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
    ),
  );
}

const validBody = {
  bookingGuestId: "guest-1",
  bedId: "bed-1",
  from: "2026-06-01",
  to: "2026-06-04",
};

describe("POST /api/admin/bed-allocation/allocations/range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockModuleEnabled.mockResolvedValue(true);
    mockCreateAuditLog.mockResolvedValue(undefined);
  });

  it("answers with the written range on success and audits nothing itself", async () => {
    mockAssignBedRange.mockResolvedValue(buildResult());

    const response = await post(validBody);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { applied: true, writtenNights: ["2026-06-01", "2026-06-02", "2026-06-03"] },
    });

    expect(mockAssignBedRange).toHaveBeenCalledWith(
      expect.objectContaining({ approvedByMemberId: "admin-1" }),
    );
    // The audit row belongs to the lib's transaction, so rows and record commit
    // together. A second entry written here would double-count the operation.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("answers 409 with the same refusal report when the range is blocked", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        applied: false,
        writtenNights: [],
        freeNights: ["2026-06-01", "2026-06-02"],
        refusals: [
          {
            stayDate: "2026-06-03",
            category: "BED_TAKEN",
            occupiedBy: {
              guestName: "Other Guest",
              memberName: "Other Member",
              bookingId: "booking-other",
              holdsCapacity: false,
            },
          },
        ],
      }),
    );

    const response = await post(validBody);
    // A pure clash is a conflict, not a bad request.
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.result.applied).toBe(false);
    expect(body.result.refusals).toHaveLength(1);
    expect(body.result.freeNights).toEqual(["2026-06-01", "2026-06-02"]);
    // The occupying guest is named to the admin who asked — this is the only
    // place those names appear; the audit row records counts and ids only.
    expect(body.result.refusals[0].occupiedBy.guestName).toBe("Other Guest");
  });

  it("answers 400 when a night is refused because the guest is not booked", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        applied: false,
        writtenNights: [],
        freeNights: ["2026-06-01"],
        refusals: [{ stayDate: "2026-06-03", category: "GUEST_NOT_BOOKED" }],
      }),
    );

    const response = await post(validBody);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("not booked");
    // Same report body whichever status the refusal carries.
    expect(body.result.refusals[0].category).toBe("GUEST_NOT_BOOKED");
  });

  it("passes the admin's explicit night list through untouched", async () => {
    mockAssignBedRange.mockResolvedValue(
      buildResult({
        partialByConsent: true,
        writtenNights: ["2026-06-01", "2026-06-02"],
        refusals: [{ stayDate: "2026-06-03", category: "BED_TAKEN" }],
      }),
    );

    const response = await post({
      ...validBody,
      nights: ["2026-06-01", "2026-06-02"],
    });
    expect(response.status).toBe(200);
    expect(mockAssignBedRange).toHaveBeenCalledWith(
      expect.objectContaining({
        nights: ["2026-06-01", "2026-06-02"],
        approvedByMemberId: "admin-1",
      }),
    );
  });

  it("rejects unknown keys, malformed JSON and non-date ranges without touching the lib", async () => {
    const strict = await post({ ...validBody, lodgeId: "lodge-1" });
    expect(strict.status).toBe(400);

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);

    // A shape check, not just "non-empty": "9999999-01-01" used to reach the lib.
    const badDate = await post({ ...validBody, to: "9999999-01-01" });
    expect(badDate.status).toBe(400);

    // Same for the explicit night list, which is bounded to the assign cap.
    const badNight = await post({ ...validBody, nights: ["not-a-date"] });
    expect(badNight.status).toBe(400);

    const emptyNights = await post({ ...validBody, nights: [] });
    expect(emptyNights.status).toBe(400);

    expect(mockAssignBedRange).not.toHaveBeenCalled();
  });

  /*
   * Prisma codes that mean "nothing was written, something collided" must not
   * fall through to a generic 500 — the admin can act on both of these (#2251
   * review A3).
   */
  it("maps a write conflict (P2034) to a 409 that says nothing was written", async () => {
    mockAssignBedRange.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "test",
      }),
    );

    const response = await post(validBody);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("Nothing was written");
  });

  it("maps a transaction timeout (P2028) to a 503 that says to try a shorter range", async () => {
    mockAssignBedRange.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("transaction timed out", {
        code: "P2028",
        clientVersion: "test",
      }),
    );

    const response = await post(validBody);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("shorter date range");
  });

  it("404s when the bed allocation module is off", async () => {
    mockModuleEnabled.mockResolvedValue(false);

    const response = await post(validBody);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mockAssignBedRange).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before any work happens", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });

    const response = await post(validBody);
    expect(response.status).toBe(403);
    expect(mockAssignBedRange).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
