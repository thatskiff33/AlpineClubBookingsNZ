import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  createNew: vi.fn(),
  cancelNew: vi.fn(),
  nbFindMany: vi.fn(),
  bcrFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: { bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...a: unknown[]) => mocks.sendAlert(...a),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    newBookingPolicyExceptionRequest: {
      findMany: (...a: unknown[]) => mocks.nbFindMany(...a),
    },
    // #2562: the member's own read now merges BOTH request tables, so the double
    // has to offer both delegates.
    bookingChangeRequest: {
      findMany: (...a: unknown[]) => mocks.bcrFindMany(...a),
    },
  },
}));
// Keep the REAL error classes (so the http mapper's instanceof checks work), but
// swap the two service functions the routes call for mocks.
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-exception-request-service");
  return {
    ...actual,
    createNewBookingExceptionRequest: (...a: unknown[]) => mocks.createNew(...a),
    cancelNewBookingExceptionRequest: (...a: unknown[]) => mocks.cancelNew(...a),
  };
});

import { POST, GET } from "@/app/api/bookings/exception-requests/route";
import { PATCH } from "@/app/api/bookings/exception-requests/[id]/route";
import {
  NoEligiblePolicyExceptionError,
  OpenExceptionRequestConflictError,
} from "@/lib/booking-exception-request-service";

const CREATED = {
  id: "req-1",
  status: "REQUESTED",
  proposalHash: "a".repeat(64),
  reasonCodes: ["MINIMUM_STAY"],
  aggregateCapacityMode: "HOLD",
};

function postReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/exception-requests", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_BODY = {
  checkIn: "2026-07-04",
  checkOut: "2026-07-05",
  guests: [{ firstName: "Ada", lastName: "Lovelace", ageTier: "ADULT", isMember: true, memberId: "m1" }],
  memberMessage: "please allow this stay",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1", email: "a@x.nz", name: "Ada Lovelace", role: "member" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() + 1000 });
  mocks.getClientIp.mockReturnValue("0.0.0.0");
  mocks.getDefaultLodgeId.mockResolvedValue("lodge_1");
  mocks.createNew.mockResolvedValue(CREATED);
  mocks.sendAlert.mockResolvedValue(undefined);
});

describe("POST /api/bookings/exception-requests", () => {
  it("creates a request (201), audits, and fires the officer alert", async () => {
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("notify-post-commit-never-throws: a rejected alert still returns 201", async () => {
    mocks.sendAlert.mockRejectedValue(new Error("smtp down"));
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    // Let the swallowed rejection settle; the route must not have awaited it.
    await Promise.resolve();
  });

  it("maps NoEligiblePolicyExceptionError to 400 and does not notify", async () => {
    mocks.createNew.mockRejectedValue(new NoEligiblePolicyExceptionError());
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("maps the one-open-request conflict to 409", async () => {
    mocks.createNew.mockRejectedValue(new OpenExceptionRequestConflictError());
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mocks.createNew).not.toHaveBeenCalled();
  });

  it("rejects check-out on/before check-in with 400", async () => {
    const res = await POST(postReq({ ...VALID_BODY, checkOut: "2026-07-04" }));
    expect(res.status).toBe(400);
    expect(mocks.createNew).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/bookings/exception-requests/[id] (member cancel)", () => {
  function patchReq() {
    return new NextRequest("http://localhost/api/bookings/exception-requests/req-1", {
      method: "PATCH",
      body: JSON.stringify({ action: "cancel" }),
      headers: { "content-type": "application/json" },
    });
  }

  it("cancels an open request (200) and audits", async () => {
    mocks.cancelNew.mockResolvedValue(true);
    const res = await PATCH(patchReq(), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(200);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
  });

  it("lost-claim-no-side-effect: a claim that lands nothing is 409 and never audits", async () => {
    mocks.cancelNew.mockResolvedValue(false);
    const res = await PATCH(patchReq(), { params: Promise.resolve({ id: "req-1" }) });
    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

describe("GET /api/bookings/exception-requests (member's own list)", () => {
  /** A new-booking row as the read's own select shapes it. */
  function newBookingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "nb-1",
      status: "REQUESTED",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      reviewedAt: null,
      proposalSnapshot: {
        kind: "NEW_BOOKING",
        lodgeId: "lodge-1",
        proposed: {
          checkIn: "2026-07-03",
          checkOut: "2026-07-04",
          guests: [
            {
              firstName: "Sam",
              lastName: "Skier",
              ageTier: "ADULT",
              isMember: true,
              nights: ["2026-07-03"],
            },
          ],
        },
      },
      frozenEvidence: {
        violations: [
          {
            reasonCode: "MINIMUM_STAY",
            message: "Two nights are required.",
            affectedNights: ["2026-07-03"],
          },
        ],
      },
      memberMessage: "Driving up after work.",
      adminNotes: null,
      lastConflictReason: null,
      lastConflictAt: null,
      createdBookingId: null,
      supersededByRequestId: null,
      ...overrides,
    };
  }

  /** A POLICY_EXCEPTION modification row, with its reservation-night count. */
  function modificationRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "mod-1",
      status: "REQUESTED",
      createdAt: new Date("2026-07-02T00:00:00Z"),
      reviewedAt: null,
      bookingId: "booking-1",
      proposalSnapshot: {
        kind: "MODIFICATION",
        lodgeId: "lodge-1",
        bookingId: "booking-1",
        base: { checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [] },
        proposed: { checkIn: "2026-08-01", checkOut: "2026-08-02", guests: [] },
      },
      frozenEvidence: { violations: [] },
      memberMessage: "Have to leave a night early.",
      adminNotes: null,
      lastConflictReason: null,
      lastConflictAt: null,
      supersededByRequestId: null,
      _count: { reservationNights: 2 },
      ...overrides,
    };
  }

  beforeEach(() => {
    mocks.nbFindMany.mockResolvedValue([]);
    mocks.bcrFindMany.mockResolvedValue([]);
  });

  it("returns the member's own requests from BOTH tables, newest first", async () => {
    mocks.nbFindMany.mockResolvedValue([newBookingRow()]);
    mocks.bcrFindMany.mockResolvedValue([modificationRow()]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    // mod-1 was created a day later, so it sorts first across the two tables.
    expect(body.map((item: { id: string }) => item.id)).toEqual(["mod-1", "nb-1"]);
    expect(mocks.nbFindMany.mock.calls[0][0].where).toMatchObject({
      requestedByMemberId: "m1",
    });
    // Scoped to the requester AND to POLICY_EXCEPTION, so a locked-period change
    // request sharing the table can never surface here.
    expect(mocks.bcrFindMany.mock.calls[0][0].where).toMatchObject({
      requestedByMemberId: "m1",
      kind: "POLICY_EXCEPTION",
    });
  });

  it("never selects the officer's internal note, on either table", async () => {
    await GET();
    for (const call of [
      mocks.nbFindMany.mock.calls[0][0],
      mocks.bcrFindMany.mock.calls[0][0],
    ]) {
      expect(call.select).toBeDefined();
      // The column is not read at all, so there is nothing in memory for a later
      // mapper edit to leak (#2562).
      expect(Object.keys(call.select)).not.toContain("internalNotes");
      // The member-facing explanation IS read: a refusal the member cannot read
      // is a refusal they cannot act on.
      expect(call.select.adminNotes).toBe(true);
    }
  });

  it("never emits an internalNotes field, even if a row carries one", async () => {
    // A row shaped as if the column had been selected by mistake. The DTO is a
    // strict allowlist, so it still cannot reach the wire.
    mocks.nbFindMany.mockResolvedValue([
      newBookingRow({
        adminNotes: "We can allow it this once.",
        internalNotes: "This member asks every single season.",
      }),
    ]);
    const res = await GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("every single season");
    expect(body[0]).not.toHaveProperty("internalNotes");
    expect(body[0].decisionExplanation).toBe("We can allow it this once.");
  });

  it("reports capacity from the reservation ledger, not the policy's intent", async () => {
    mocks.nbFindMany.mockResolvedValue([newBookingRow()]);
    mocks.bcrFindMany.mockResolvedValue([
      modificationRow({ _count: { reservationNights: 0 } }),
    ]);
    const res = await GET();
    const body = (await res.json()) as Array<{ id: string; capacityHeld: boolean }>;
    // A new-booking request holds nothing, ever; a modification that reserved no
    // night (a pure shrink) holds nothing either.
    expect(body.find((item) => item.id === "nb-1")?.capacityHeld).toBe(false);
    expect(body.find((item) => item.id === "mod-1")?.capacityHeld).toBe(false);

    mocks.bcrFindMany.mockResolvedValue([
      modificationRow({ _count: { reservationNights: 3 } }),
    ]);
    const held = (await (await GET()).json()) as Array<{
      id: string;
      capacityHeld: boolean;
    }>;
    expect(held.find((item) => item.id === "mod-1")?.capacityHeld).toBe(true);
  });

  it("reads a REQUESTED row with a recorded conflict as a capacity wait, not as undecided", async () => {
    mocks.bcrFindMany.mockResolvedValue([
      modificationRow({
        lastConflictReason: "The lodge is full on 1 August.",
        lastConflictAt: new Date("2026-07-05T00:00:00Z"),
      }),
    ]);
    const body = (await (await GET()).json()) as Array<{
      status: string;
      canWithdraw: boolean;
    }>;
    expect(body[0].status).toBe("pending-capacity-conflict");
    // Still OPEN, so both lifecycle actions stay available.
    expect(body[0].canWithdraw).toBe(true);
  });

  it("offers neither withdraw nor replace once a request is terminal", async () => {
    mocks.bcrFindMany.mockResolvedValue([
      modificationRow({ status: "REJECTED", adminNotes: "Not this weekend." }),
    ]);
    const body = (await (await GET()).json()) as Array<{
      status: string;
      canWithdraw: boolean;
      canReplace: boolean;
      decisionExplanation: string | null;
    }>;
    expect(body[0].status).toBe("refused");
    expect(body[0].canWithdraw).toBe(false);
    expect(body[0].canReplace).toBe(false);
    expect(body[0].decisionExplanation).toBe("Not this weekend.");
  });
});
