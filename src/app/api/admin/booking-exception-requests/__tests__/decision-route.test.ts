import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  // Typed with a rest signature so the `vi.mock` factories below can forward
  // their arguments through with a spread.
  logAudit: vi.fn<(...args: unknown[]) => void>(),
  getClientIp: vi.fn<(...args: unknown[]) => string>(() => "1.2.3.4"),
  approve: vi.fn(),
  resolveTerminal: vi.fn(),
  buildHooks: vi.fn(),
  resolveNewBookingParams: vi.fn(),
  bcrFindFirst: vi.fn(),
  nbFindUnique: vi.fn(),
  // Rest-typed like every other model stub here, so the `(...a) => mock(...a)`
  // forwarding below typechecks under `tsconfig.test.json`.
  fgmFindMany: vi.fn(async (...args: unknown[]) => {
    void args;
    return [];
  }),
  memberFindMany: vi.fn(async (...args: unknown[]) => {
    void args;
    return [];
  }),
  // #2562 review: the refusal notice. Mocked because a real send would reach the
  // mailer, and asserted because before this the member was told nothing at all.
  sendRefused: vi.fn(async (...args: unknown[]) => {
    void args;
  }),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  logAudit: (...a: unknown[]) => mocks.logAudit(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendBookingPolicyExceptionRefusedEmail: (...a: unknown[]) =>
    mocks.sendRefused(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: { findFirst: (...a: unknown[]) => mocks.bcrFindFirst(...a) },
    newBookingPolicyExceptionRequest: {
      findUnique: (...a: unknown[]) => mocks.nbFindUnique(...a),
    },
    // #2526: GET describes the proposed party, including whether each member
    // guest is beyond the requester's family, which reads the family boundary.
    familyGroupMember: { findMany: (...a: unknown[]) => mocks.fgmFindMany(...a) },
    member: { findMany: (...a: unknown[]) => mocks.memberFindMany(...a) },
  },
}));
// Keep the real stores/parsers; swap only the two engine entry points.
vi.mock("@/lib/booking-exception-execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-execution")>();
  return {
    ...actual,
    approveAndExecutePolicyExceptionRequest: (...a: unknown[]) => mocks.approve(...a),
    resolvePolicyExceptionRequestTerminal: (...a: unknown[]) =>
      mocks.resolveTerminal(...a),
  };
});
vi.mock("@/lib/booking-exception-approval", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-exception-approval")>();
  return {
    ...actual,
    buildPolicyExceptionApprovalHooks: (...a: unknown[]) => mocks.buildHooks(...a),
    resolveNewBookingExecutionParams: (...a: unknown[]) =>
      mocks.resolveNewBookingParams(...a),
  };
});

import { GET, PATCH } from "@/app/api/admin/booking-exception-requests/[id]/route";
import { POLICY_DRIFT_MESSAGE } from "@/lib/booking-exception-execution";
import {
  computeProposalHash,
  freezePolicyExceptionEvidence,
  type ModificationProposalSnapshot,
} from "@/lib/booking-exception-requests";
import type { MinimumStayPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import { SameOwnerCoverageOverrideRequiredError } from "@/lib/adult-member-hosting-same-owner";

const LODGE = "lodge-a";

const SNAPSHOT: ModificationProposalSnapshot = {
  kind: "MODIFICATION",
  lodgeId: LODGE,
  bookingId: "bk-1",
  base: {
    checkIn: "2026-07-01",
    checkOut: "2026-07-03",
    guests: [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-1",
        nights: ["2026-07-01", "2026-07-02"],
      },
    ],
  },
  proposed: {
    checkIn: "2026-07-01",
    checkOut: "2026-07-02",
    guests: [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m-1",
        nights: ["2026-07-01"],
      },
    ],
  },
};

const MIN_STAY: MinimumStayPolicyExceptionViolation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "pol-1",
  policyVersion: 1,
  policyName: "Weekend minimum stay",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: LODGE },
  affectedNights: ["2026-07-01"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Two-night minimum on weekends.",
  triggerDay: "2026-07-01",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [6],
  },
};

const HOSTING: AdultMemberHostingPolicyExceptionViolation = {
  reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
  policyId: "host-1",
  policyVersion: 3,
  policyName: "Adult member must host",
  resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: LODGE },
  affectedNights: ["2026-07-01"],
  exceptionEligible: true,
  capacityMode: "NO_HOLD",
  message: "An adult member must be present.",
  requirements: {
    kind: "ADULT_MEMBER_HOSTING",
    requiredAdultMemberParticipantsPerGuestNight: 1,
    uncoveredNonMemberGuestNights: 1,
    uncovered: [{ night: "2026-07-01", guestRef: "g-1", guestName: "Bob Smith" }],
    qualifyingHostsByNight: [{ night: "2026-07-01", memberIds: [] }],
  },
};

function modificationRow(
  violations: Array<MinimumStayPolicyExceptionViolation | AdultMemberHostingPolicyExceptionViolation> = [
    MIN_STAY,
  ],
) {
  return {
    id: "req-1",
    status: "REQUESTED",
    version: 3,
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    reviewedAt: null,
    reviewedBy: null,
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    memberMessage: "Please allow the one-night stay.",
    adminNotes: null,
    // #2562: the private half of the decision. Present on the row the admin detail
    // read returns, and on no member-facing surface.
    internalNotes: null,
    proposalSnapshot: SNAPSHOT,
    proposalHash: computeProposalHash(SNAPSHOT),
    frozenEvidence: freezePolicyExceptionEvidence(violations),
    aggregateCapacityMode: "HOLD",
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    booking: {
      id: "bk-1",
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      status: "PAID",
      finalPriceCents: 12000,
      lodgeId: LODGE,
      member: {
        id: "m-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
    },
  };
}

/**
 * A NEW-booking request row, for the half of the refusal path that has no booking
 * at all (#2562 review). Deliberately minimal: the reject branch reads the
 * requester, the frozen snapshot's proposed nights and the lodge, and nothing else.
 */
function newBookingRow() {
  const snapshot = {
    kind: "NEW_BOOKING" as const,
    lodgeId: LODGE,
    proposed: {
      checkIn: "2026-08-14",
      checkOut: "2026-08-15",
      guests: [
        {
          firstName: "Ada",
          lastName: "Lovelace",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m-1",
          nights: ["2026-08-14"],
        },
      ],
    },
  };
  return {
    id: "req-1",
    status: "REQUESTED",
    version: 2,
    lodgeId: LODGE,
    requestedByMemberId: "m-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    reviewedAt: null,
    reviewedBy: null,
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    memberMessage: "Driving up after work on the Friday.",
    adminNotes: null,
    internalNotes: null,
    proposalSnapshot: snapshot,
    proposalHash: computeProposalHash(snapshot),
    frozenEvidence: freezePolicyExceptionEvidence([MIN_STAY]),
    aggregateCapacityMode: "NO_HOLD",
    conflictCount: 0,
    lastConflictAt: null,
    lastConflictReason: null,
    supersededByRequestId: null,
    createdBookingId: null,
    lodge: { id: LODGE, name: "Example Lodge" },
  };
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "req-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "officer-1" } },
  });
  mocks.bcrFindFirst.mockResolvedValue(modificationRow());
  mocks.nbFindUnique.mockResolvedValue(null);
  mocks.buildHooks.mockReturnValue({
    hooks: {},
    outcome: { createdBookingId: null, hostingDecisionRecorded: false },
  });
  mocks.approve.mockResolvedValue({ outcome: "executed", requestId: "req-1" });
  mocks.resolveTerminal.mockResolvedValue({ claimed: true, released: 2 });
});

describe("GET /api/admin/booking-exception-requests/[id]", () => {
  it("returns the frozen evidence and the exact proposal an approval would execute", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("MODIFICATION");
    expect(body.version).toBe(3);
    expect(body.proposal.kind).toBe("MODIFICATION");
    expect(body.evidence.reasonCodes).toEqual(["MINIMUM_STAY"]);
    expect(body.memberMessage).toContain("one-night stay");
  });

  it("404s an id that is in neither table", async () => {
    mocks.bcrFindFirst.mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("is refused for an admin without booking access", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH — approve", () => {
  it("refuses an approval that was not explicitly confirmed", async () => {
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/confirm/i);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires a written reason before overriding adult-member hosting (D-R4)", async () => {
    mocks.bcrFindFirst.mockResolvedValue(modificationRow([MIN_STAY, HOSTING]));
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/written reason/i);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("executes, and hands the engine the officer's expectedVersion", async () => {
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: true },
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        adminNotes: "One-off, agreed at committee.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "req-1", status: "APPROVED" });
    expect(mocks.approve.mock.calls[0][0]).toMatchObject({
      requestId: "req-1",
      expectedVersion: 3,
      actorMemberId: "officer-1",
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.approve",
        outcome: "success",
      }),
    );
  });

  it("keeps the request pending and returns exact safe coverage details on the first same-owner refusal", async () => {
    mocks.approve.mockRejectedValue(
      new SameOwnerCoverageOverrideRequiredError([
        {
          bookingId: "bk-dependent",
          reference: "BK-DEPENDENT",
          lodgeName: "Example Lodge",
          nights: ["2026-07-01", "2026-07-02"],
        },
      ]),
    );

    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: "REQUESTED",
      keptPending: true,
      requiresOverrideReason: true,
      strandedStateKey: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
      strandedBookings: [
        {
          bookingId: "bk-dependent",
          reference: "BK-DEPENDENT",
          lodgeName: "Example Lodge",
          nights: ["2026-07-01", "2026-07-02"],
        },
      ],
    });
    expect(mocks.logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.approve",
        outcome: "success",
      }),
    );
  });

  it("rejects an unacknowledged or short same-owner override before execution", async () => {
    for (const hostingCoverageOverride of [
      {
        acknowledged: false,
        reason: "Long enough reason",
        strandedStateKey: `v1:${"a".repeat(64)}`,
      },
      {
        acknowledged: true,
        reason: "too short",
        strandedStateKey: `v1:${"a".repeat(64)}`,
      },
      {
        acknowledged: true,
        reason: "Long enough reason",
      },
      {
        acknowledged: true,
        reason: "Long enough reason",
        strandedStateKey: `v1:${"a".repeat(64)}`,
        unreviewedAuthority: true,
      },
    ]) {
      const res = await PATCH(
        patchRequest({
          action: "approve",
          source: "MODIFICATION",
          expectedVersion: 3,
          confirm: true,
          hostingCoverageOverride,
        }),
        { params },
      );
      expect(res.status).toBe(400);
    }
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("passes an authorized officer's private same-owner override separately from adminNotes", async () => {
    const hostingCoverageOverride = {
      acknowledged: true,
      reason: "Confirmed alternate supervision plan.",
      strandedStateKey: `v1:${"a".repeat(64)}`,
    };
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        adminNotes: "Member-facing exception explanation.",
        hostingCoverageOverride,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(mocks.buildHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        adminNotes: "Member-facing exception explanation.",
        hostingCoverageOverride,
      }),
    );
  });

  it("reports a NO_HOLD capacity conflict as STILL PENDING — never as approved", async () => {
    mocks.approve.mockResolvedValue({
      outcome: "keptPendingCapacity",
      message: "The lodge no longer has room for this booking.",
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBe(true);
    expect(body.error).toMatch(/no longer has room/);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.kept-pending",
        outcome: "failure",
      }),
    );
  });

  it("turns a thrown execution capacity refusal into the same still-pending answer", async () => {
    const { PolicyExceptionExecutionCapacityError } = await import(
      "@/lib/booking-exception-approval"
    );
    mocks.approve.mockRejectedValue(
      new PolicyExceptionExecutionCapacityError(["2026-07-01"]),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBe(true);
  });

  it("reports a post-commit failure as APPROVED with followUpFailed, never as pending", async () => {
    // #2526 review. The engine's post-commit phase runs after the transaction has
    // already committed, so a provider or audit failure there cannot mean the
    // approval did not happen. Reporting "still pending" made the officer retry
    // into a 409 that blamed a third party, or create the booking again by hand.
    mocks.approve.mockResolvedValue({
      outcome: "executed",
      requestId: "req-1",
      followUpFailed: true,
    });
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: "bk-9", hostingDecisionRecorded: false },
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("APPROVED");
    expect(body.keptPending).toBeUndefined();
    expect(body.followUpFailed).toBe(true);
    // The approve audit row is still written, and records the follow-up failure.
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-policy-exception-request.approve",
        outcome: "success",
        metadata: expect.objectContaining({ followUpFailed: true }),
      }),
    );
  });

  it("asks the officer for the refund choice instead of calling it kept-pending", async () => {
    // #2526 review. The archetypal minimum-stay exception is "let me shorten my
    // stay", which reduces a paid booking's price and makes the canonical service
    // demand a card/credit choice. Rendering that as "the request is still
    // pending" named no action and the screen offered none, so the request was
    // permanently un-approvable and could only be refused.
    const { BookingModificationSettlementMethodRequiredError } = await import(
      "@/lib/booking-modify-settlement"
    );
    mocks.approve.mockRejectedValue(
      new BookingModificationSettlementMethodRequiredError(),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.needsSettlementMethod).toBe(true);
    // NOT kept-pending: nothing is waiting on capacity or on anybody else.
    expect(body.keptPending).toBeUndefined();
    expect(body.error).toMatch(/card or to account credit/i);
  });

  it("passes the officer's settlement choice through to the executor", async () => {
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: false },
    });
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        settlementMethod: "credit",
      }),
      { params },
    );
    expect(mocks.buildHooks.mock.calls[0][0]).toMatchObject({
      settlementMethod: "credit",
    });
  });

  it("hands the member's own message to the hooks for the supervision review", async () => {
    // The officer never decides adult supervision (#2526 review), so the reason
    // recorded against it has to be the MEMBER's.
    mocks.buildHooks.mockReturnValue({
      hooks: {},
      outcome: { createdBookingId: null, hostingDecisionRecorded: false },
    });
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(mocks.buildHooks.mock.calls[0][0].memberMessage).toContain(
      "one-night stay",
    );
  });

  it("refuses a guest-authorisation failure with its own status, not as kept-pending", async () => {
    const { BookingGuestValidationError } = await import("@/lib/booking-guests");
    mocks.approve.mockRejectedValue(
      new BookingGuestValidationError("Invalid guest member reference", 403, {
        code: "GUEST_MEMBER_NOT_ALLOWED",
      }),
    );
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.keptPending).toBeUndefined();
    expect(body.code).toBe("GUEST_MEMBER_NOT_ALLOWED");
  });

  it("409s a lost claim (the queue was stale)", async () => {
    mocks.approve.mockResolvedValue({ outcome: "claimLost" });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/reload the queue/i);
  });

  it("403s when the fresh-DB reauthorization refuses mid-flight", async () => {
    mocks.approve.mockResolvedValue({ outcome: "notAuthorized" });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("surfaces policy drift with the rules that moved", async () => {
    mocks.approve.mockResolvedValue({
      outcome: "policyDrift",
      // The real constant, so this stops naming a sentence the engine no longer
      // sends (#3089).
      message: POLICY_DRIFT_MESSAGE,
      changedReviewed: [{ reasonCode: "MINIMUM_STAY", policyId: "pol-1" }],
      newViolations: [],
    });
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("REQUESTED");
    expect(body.changedReviewed).toHaveLength(1);
  });

  it("404s when the body's source does not match the table the id lives in", async () => {
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(res.status).toBe(404);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("requires bookings EDIT access, not merely view", async () => {
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
      }),
      { params },
    );
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
  });
});

describe("PATCH — reject", () => {
  it("refuses a refusal with no reason for the member", async () => {
    const res = await PATCH(
      patchRequest({ action: "reject", source: "MODIFICATION", expectedVersion: 3 }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });

  it("refuses and reports the reservation nights released", async () => {
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "The lodge is full that weekend every year.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "REJECTED",
      releasedReservationNights: 2,
    });
    expect(mocks.resolveTerminal.mock.calls[0][0]).toMatchObject({
      to: "REJECTED",
      expectedVersion: 3,
      actorMemberId: "officer-1",
    });
  });

  it("409s a refusal whose guarded claim was lost", async () => {
    mocks.resolveTerminal.mockResolvedValue({ claimed: false, released: 0 });
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "No longer relevant.",
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});

/**
 * #2562 — the officer-note split.
 *
 * `adminNotes` is the member-facing decision explanation and always was; the new
 * `internalNotes` column is the private half. Three properties are load-bearing and
 * all three are pinned here: the two travel to separate columns, an internal note
 * can never stand in for the member-facing reason a refusal requires, and the audit
 * log records that a private note EXISTS without copying its text.
 */
describe("PATCH — the officer-note split", () => {
  it("carries both notes to the terminal claim, in their own fields", async () => {
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "That weekend is always full, sorry.",
        internalNotes: "Third time this season; have a word at the AGM.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(mocks.resolveTerminal.mock.calls[0][0]).toMatchObject({
      adminNotes: "That weekend is always full, sorry.",
      internalNotes: "Third time this season; have a word at the AGM.",
    });
  });

  it("refuses a refusal that has ONLY an internal note", async () => {
    // The member would be left with a bare "not approved" and something written
    // about them they cannot see. The gate reads `adminNotes` for exactly that
    // reason, and says so.
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        internalNotes: "Not worth the argument.",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a substitute/i);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });

  it("records only THAT an internal note exists in the refusal audit, never its text", async () => {
    await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "Not this weekend.",
        internalNotes: "Chases every officer until somebody says yes.",
      }),
      { params },
    );
    const entry = mocks.logAudit.mock.calls[0][0] as {
      details?: unknown;
      metadata?: Record<string, unknown>;
    };
    expect(entry.metadata?.internalNoteRecorded).toBe(true);
    // The audit log is read by more surfaces than the officer queue, so the private
    // text must not be duplicated into it.
    expect(JSON.stringify(entry)).not.toContain("Chases every officer");
    expect(entry.details).toBe("Not this weekend.");
  });

  it("hands both notes to the approval hooks, and audits only the flag", async () => {
    await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        adminNotes: "Allowed this once.",
        internalNotes: "Watch the pattern next season.",
      }),
      { params },
    );
    expect(mocks.buildHooks.mock.calls[0][0]).toMatchObject({
      adminNotes: "Allowed this once.",
      internalNotes: "Watch the pattern next season.",
    });
    const entry = mocks.logAudit.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(entry.metadata?.internalNoteRecorded).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("Watch the pattern");
  });

  it("does not satisfy the hosting-override reason rule with an internal note", async () => {
    mocks.bcrFindFirst.mockResolvedValue(modificationRow([HOSTING]));
    const res = await PATCH(
      patchRequest({
        action: "approve",
        source: "MODIFICATION",
        expectedVersion: 3,
        confirm: true,
        internalNotes: "Fine, they are sensible people.",
      }),
      { params },
    );
    // D-R4 wants an attributable reason ON THE RECORD the member also reads.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/member-facing explanation/i);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("exposes both notes on the admin detail read, which is admin-guarded", async () => {
    mocks.bcrFindFirst.mockResolvedValue({
      ...modificationRow(),
      adminNotes: "Allowed this once.",
      internalNotes: "Watch the pattern next season.",
    });
    const res = await GET(
      new NextRequest("http://localhost/api/admin/booking-exception-requests/req-1"),
      { params },
    );
    const body = await res.json();
    expect(body.adminNotes).toBe("Allowed this once.");
    expect(body.internalNotes).toBe("Watch the pattern next season.");
  });

  it("refuses an internal note longer than the column allows", async () => {
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "No.",
        internalNotes: "x".repeat(2001),
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mocks.resolveTerminal).not.toHaveBeenCalled();
  });
});

/**
 * #2562 review — a refusal that notifies the member nowhere.
 *
 * The reject branch recorded `adminNotes` (mandatory, precisely so the member can
 * act on it), wrote the audit row and released the held beds, then told the member
 * nothing: no email, and there is no in-app notification centre in this app. Their
 * only signal was a badge on My Bookings they would have to go looking for, so the
 * realistic next act was the telephone call the whole workflow exists to remove, or
 * a duplicate request raised days later in ignorance.
 */
describe("PATCH — reject notifies the member", () => {
  it("emails the requester the officer's member-facing explanation", async () => {
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "The lodge is full that weekend every year.",
        internalNotes: "Third ask this month, do not encourage.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(mocks.sendRefused).toHaveBeenCalledTimes(1);
    const sent = mocks.sendRefused.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      email: "ada@example.com",
      recipientMemberId: "m-1",
      firstName: "Ada",
      source: "MODIFICATION",
      adminNotes: "The lodge is full that weekend every year.",
      lodgeId: LODGE,
    });
    // A refused CHANGE belongs to its booking, so the per-booking "No emails"
    // switch can still withhold it.
    expect(sent.bookingContext).toEqual({ bookingId: "bk-1" });
    // The PROPOSED nights, which are what the member asked about.
    expect((sent.checkIn as Date).toISOString().slice(0, 10)).toBe("2026-07-01");
    expect((sent.checkOut as Date).toISOString().slice(0, 10)).toBe("2026-07-02");
    // The private note reaches no member surface, and an email is one.
    expect(JSON.stringify(sent)).not.toContain("do not encourage");
  });

  it("sends nothing when the guarded claim was lost", async () => {
    // No refusal was recorded, so there is nothing to tell anybody about.
    mocks.resolveTerminal.mockResolvedValue({ claimed: false, released: 0 });
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "No longer relevant.",
      }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(mocks.sendRefused).not.toHaveBeenCalled();
  });

  it("still reports the refusal when the notice itself fails", async () => {
    // The refusal is already committed by the time the notice runs, so a mail
    // failure must never be reported to the officer as a failed decision.
    mocks.sendRefused.mockRejectedValueOnce(new Error("SES is down"));
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "MODIFICATION",
        expectedVersion: 3,
        adminNotes: "No room.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "REJECTED" });
  });

  it("passes no booking context for a refused NEW-booking request", async () => {
    // There is no booking to silence and none to link, so the sender is told so
    // explicitly rather than being handed a booking id that does not exist.
    mocks.bcrFindFirst.mockResolvedValue(null);
    mocks.nbFindUnique.mockResolvedValue(newBookingRow());
    const res = await PATCH(
      patchRequest({
        action: "reject",
        source: "NEW_BOOKING",
        expectedVersion: 2,
        adminNotes: "Not that weekend, sorry.",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const sent = mocks.sendRefused.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.bookingContext).toBe("none");
    expect(sent).toMatchObject({ source: "NEW_BOOKING", lodgeId: LODGE });
  });
});
