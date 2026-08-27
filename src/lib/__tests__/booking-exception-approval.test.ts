import { beforeEach, describe, expect, it, vi } from "vitest";

/** The shipped default: the memberGuests module off, consent required. */
const MEMBER_GUEST_POLICY = {
  wideningEnabled: false,
  approvalRequired: true,
  pendingHoldExpiryDays: 0,
} as const;

// The approval hooks compose the real capacity engine, the real canonical
// booking services and the real hosting reconciler. Each is mocked here so the
// tests assert the CONTRACT this module owes them — which arguments it passes,
// and what it does with each answer — rather than re-testing their internals.
const checkCapacityForGuestRanges = vi.fn();
vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    checkCapacityForGuestRanges(...args),
  acquireLodgeCapacityLock: vi.fn(async () => undefined),
}));

const createConfirmedBooking = vi.fn();
vi.mock("@/lib/booking-create", () => ({
  createConfirmedBooking: (...args: unknown[]) => createConfirmedBooking(...args),
}));

const modifyBookingBatch = vi.fn();
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: (...args: unknown[]) => modifyBookingBatch(...args),
}));

const recordAdultMemberHostingReviewDecision = vi.fn();
vi.mock("@/lib/adult-member-hosting-review", () => ({
  recordAdultMemberHostingReviewDecision: (...args: unknown[]) =>
    recordAdultMemberHostingReviewDecision(...args),
  evaluateProposedAdultMemberHosting: vi.fn(async () => null),
}));

// #2576 §7's third automatic resolution: "the incident should resolve automatically
// if ... a valid policy exception is approved". Mocked at the module boundary like
// every other collaborator here, because the real helper reads
// `tx.hostingCoverageIncident` and this suite's fake transaction carries only the
// delegates the approval itself needs — which is exactly how it caught the change.
const resolveHostingCoverageIncidents = vi.fn(async (...args: unknown[]) => {
  void args;
  return 1;
});
vi.mock("@/lib/adult-member-hosting-coverage-incidents", () => ({
  resolveHostingCoverageIncidents: (...args: unknown[]) =>
    resolveHostingCoverageIncidents(...args),
}));

const getNonMemberHoldPolicy = vi.fn();
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: (...args: unknown[]) => getNonMemberHoldPolicy(...args),
}));

// The new-booking executor now runs the member-guest authorisation pipeline
// (#2526 review), so each of its three steps is mocked to assert WHICH arguments
// it hands them and how it uses the answers.
const resolveLinkedBookingMembersWithBoundary = vi.fn(async () => ({
  members: new Map(),
  boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
}));
const assertLinkedBookingMembersCanBeBooked = vi.fn(async () => undefined);
const normalizeBookingGuestInputs = vi.fn(
  (guests: Array<Record<string, unknown>>) => guests,
);
vi.mock("@/lib/booking-guests", () => ({
  resolveLinkedBookingMembersWithBoundary: (...args: unknown[]) =>
    resolveLinkedBookingMembersWithBoundary(...(args as [])),
  assertLinkedBookingMembersCanBeBooked: (...args: unknown[]) =>
    assertLinkedBookingMembersCanBeBooked(...(args as [])),
  normalizeBookingGuestInputs: (...args: unknown[]) =>
    normalizeBookingGuestInputs(...(args as [Array<Record<string, unknown>>])),
}));

const planMemberGuestConsentWrites = vi.fn(
  (params: { guests: Array<Record<string, unknown>> }) => ({
    guests: params.guests,
    entriesByMemberId: new Map(),
  }),
);
const loadMemberGuestAddPolicy = vi.fn(async () => MEMBER_GUEST_POLICY);
vi.mock("@/lib/member-guest-add-policy", () => ({
  planMemberGuestConsentWrites: (...args: unknown[]) =>
    planMemberGuestConsentWrites(
      ...(args as [{ guests: Array<Record<string, unknown>> }]),
    ),
  loadMemberGuestAddPolicy: () => loadMemberGuestAddPolicy(),
  matchMemberGuestNotificationRows: vi.fn(() => []),
}));

const sendBookingPolicyExceptionApprovedEmail = vi.fn(async () => undefined);
vi.mock("@/lib/email", () => ({
  sendBookingPolicyExceptionApprovedEmail: (...args: unknown[]) =>
    sendBookingPolicyExceptionApprovedEmail(...(args as [])),
}));

const bookingFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: (...a: unknown[]) => bookingFindUnique(...a) } },
}));

import {
  buildPolicyExceptionApprovalHooks,
  buildOverrideReason,
  proposalGuestToCreateInput,
  reauthorizeBookingOfficerFromDb,
  resolveNewBookingExecutionParams,
  PolicyExceptionExecutionCapacityError,
  PolicyExceptionUnverifiedExecutionError,
} from "@/lib/booking-exception-approval";
import {
  computeProposalHash,
  formatPolicyExceptionRequestAge,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
} from "@/lib/booking-exception-requests";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";
import type { ConfirmedOverride } from "@/lib/booking-exception-execution";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

const LODGE = "lodge-a";
const OFFICER = "officer-1";

const LIVE_GUEST = {
  id: "g-1",
  firstName: "Ada",
  lastName: "Lovelace",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m-1",
  stayStart: new Date("2026-07-01T00:00:00.000Z"),
  stayEnd: new Date("2026-07-03T00:00:00.000Z"),
  // The stored explicit night set (#713). The replay reads it, so a fixture
  // without it would prove nothing about a sparse stay either way.
  nights: [
    { stayDate: new Date("2026-07-01T00:00:00.000Z") },
    { stayDate: new Date("2026-07-02T00:00:00.000Z") },
  ],
};

const DELTA = {
  addGuests: [
    {
      firstName: "Grace",
      lastName: "Hopper",
      ageTier: "ADULT",
      isMember: false,
      // A sparse explicit stay must survive the frozen-delta replay. Dropping
      // this widens the guest back to the whole booking envelope.
      nights: ["2026-07-02"],
    },
  ],
};

/** The MODIFICATION snapshot the member's request would have frozen. */
function frozenModificationSnapshot(): ModificationProposalSnapshot {
  const { base, proposed } = buildModificationProposalParties({
    bookingCheckIn: new Date("2026-07-01T00:00:00.000Z"),
    bookingCheckOut: new Date("2026-07-03T00:00:00.000Z"),
    liveGuests: [LIVE_GUEST],
    delta: DELTA,
  });
  return {
    kind: "MODIFICATION",
    lodgeId: LODGE,
    bookingId: "bk-1",
    base,
    proposed,
  };
}

const NEW_BOOKING_SNAPSHOT: NewBookingProposalSnapshot = {
  kind: "NEW_BOOKING",
  lodgeId: LODGE,
  proposed: {
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
};

function makeTx(over: Record<string, unknown> = {}) {
  return {
    member: { findUnique: vi.fn(async () => null) },
    booking: {
      findUnique: vi.fn(async () => ({
        checkIn: new Date("2026-07-01T00:00:00.000Z"),
        checkOut: new Date("2026-07-03T00:00:00.000Z"),
        guests: [LIVE_GUEST],
      })),
    },
    bookingChangeRequest: {
      findUnique: vi.fn(async () => ({
        requestedChanges: { source: "POLICY_EXCEPTION", delta: DELTA },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    newBookingPolicyExceptionRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    ...over,
  } as never;
}

/**
 * A `makeTx()` handle whose model stubs are readable as mocks. `makeTx` returns
 * `never` so the module under test accepts it as a Prisma transaction client;
 * this narrows it back for assertions on what the executor wrote.
 */
function txMocks(tx: unknown) {
  return tx as {
    bookingChangeRequest: { updateMany: { mock: { calls: never[][] } } };
    newBookingPolicyExceptionRequest: {
      updateMany: { mock: { calls: Array<[{ data: Record<string, unknown> }]> };
      };
    };
  };
}

function loadedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    status: "REQUESTED" as const,
    kind: "POLICY_EXCEPTION" as const,
    version: 1,
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    proposalHash: "hash",
    frozenEvidence: {},
    aggregateCapacityMode: "HOLD" as const,
    ...overrides,
  } as never;
}

const NO_OVERRIDE: ConfirmedOverride = { overridable: [], clearedReviewed: [] };
const MIN_STAY_OVERRIDE: ConfirmedOverride = {
  overridable: [{ reasonCode: "MINIMUM_STAY", policyId: "pol-1" }],
  clearedReviewed: [],
};
const HOSTING_OVERRIDE: ConfirmedOverride = {
  overridable: [
    { reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED", policyId: "host-1" },
  ],
  clearedReviewed: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  modifyBookingBatch.mockResolvedValue({ deferredPostCommit: vi.fn() });
  createConfirmedBooking.mockResolvedValue({
    type: "created",
    // The guest rows the create service wrote, which the post-commit consent /
    // family-add dispatch matches its plan against.
    booking: { id: "bk-new", guests: [{ id: "bg-1", memberId: "m-1" }] },
    bumpedBookingIds: [],
    isZeroDollarConfirmed: false,
    deferredPostCommit: vi.fn(),
  });
  // #2526: the member-guest authorisation pipeline's defaults — nothing beyond
  // the requester's family, so the ordinary path is unaffected.
  resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
  normalizeBookingGuestInputs.mockImplementation((guests) => guests);
  planMemberGuestConsentWrites.mockImplementation((params) => ({
    guests: params.guests,
    entriesByMemberId: new Map(),
  }));
  recordAdultMemberHostingReviewDecision.mockResolvedValue(true);
  getNonMemberHoldPolicy.mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "period",
  });
});

describe("request age", () => {
  const created = new Date("2026-08-01T00:00:00.000Z");

  it("reads as plain English, not a timestamp", () => {
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T00:00:30.000Z")),
    ).toBe("just now");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T00:40:00.000Z")),
    ).toBe("40 min ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-01T05:00:00.000Z")),
    ).toBe("5 hours ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-04T00:00:00.000Z")),
    ).toBe("3 days ago");
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-08-22T00:00:00.000Z")),
    ).toBe("3 weeks ago");
  });

  it("never shows a negative age when the clocks disagree", () => {
    expect(
      formatPolicyExceptionRequestAge(created, new Date("2026-07-31T23:00:00.000Z")),
    ).toBe("just now");
  });
});

describe("reauthorizeBookingOfficerFromDb", () => {
  function db(member: unknown) {
    return { member: { findUnique: vi.fn(async () => member) } } as never;
  }

  it("allows an active officer with bookings edit access", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(true);
  });

  it("refuses a deactivated account even though the session guard passed", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: false,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses an account mid password-reset remediation", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: true,
          accessRoles: [{ role: "ADMIN" }],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses an account whose booking access was revoked since the session was issued", async () => {
    await expect(
      reauthorizeBookingOfficerFromDb(
        db({
          active: true,
          canLogin: true,
          forcePasswordChange: false,
          accessRoles: [],
        }),
        OFFICER,
      ),
    ).resolves.toBe(false);
  });

  it("refuses a member row that no longer exists", async () => {
    await expect(reauthorizeBookingOfficerFromDb(db(null), OFFICER)).resolves.toBe(
      false,
    );
  });
});

describe("recheckCapacity — the #2525 handoff contract", () => {
  it("checks the FULL proposed party and EXCLUDES the live booking for a modification", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx();

    await expect(hooks.recheckCapacity(snapshot, tx)).resolves.toEqual({ ok: true });

    const [lodgeId, checkIn, checkOut, ranges, excludeBookingId] =
      checkCapacityForGuestRanges.mock.calls[0];
    expect(lodgeId).toBe(LODGE);
    // The FULL proposed party (both guests), not the delta.
    expect(ranges).toHaveLength(2);
    // Excluding the live booking is what makes the full-party check equivalent
    // to an incremental-headroom check — without it the live base is counted
    // twice and a legitimate approval is falsely kept pending.
    expect(excludeBookingId).toBe("bk-1");
    expect(checkIn.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(checkOut.toISOString().slice(0, 10)).toBe("2026-07-03");
  });

  it("excludes nothing for a new-booking proposal (there is no live booking)", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await hooks.recheckCapacity(NEW_BOOKING_SNAPSHOT, makeTx());
    expect(checkCapacityForGuestRanges.mock.calls[0][4]).toBeUndefined();
  });

  it("reports a shortfall as not-ok with the kept-pending message", async () => {
    checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const result = await hooks.recheckCapacity(NEW_BOOKING_SNAPSHOT, makeTx());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stays pending/i);
  });
});

describe("verifyLiveProposalIntegrity", () => {
  it("passes when the stored delta still replays to the reviewed proposal", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, makeTx()),
    ).resolves.toEqual({ intact: true });
  });

  it("FAILS when the live booking drifted since the request was made", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    // Somebody added a guest to the live booking after the request was frozen.
    const tx = makeTx({
      booking: {
        findUnique: vi.fn(async () => ({
          checkIn: new Date("2026-07-01T00:00:00.000Z"),
          checkOut: new Date("2026-07-03T00:00:00.000Z"),
          guests: [
            LIVE_GUEST,
            { ...LIVE_GUEST, id: "g-2", firstName: "Alan", lastName: "Turing" },
          ],
        })),
      },
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, tx),
    ).resolves.toEqual({ intact: false, reason: "drift" });
  });

  it("FAILS when the stored delta was tampered with", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({
      bookingChangeRequest: {
        findUnique: vi.fn(async () => ({
          requestedChanges: {
            delta: {
              addGuests: [
                {
                  firstName: "Grace",
                  lastName: "Hopper",
                  ageTier: "ADULT",
                  isMember: false,
                },
                {
                  firstName: "Smuggled",
                  lastName: "Guest",
                  ageTier: "ADULT",
                  isMember: false,
                },
              ],
            },
          },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, tx),
    ).resolves.toEqual({ intact: false, reason: "drift" });
  });

  it("FAILS when the request carries no replayable delta at all", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({
      bookingChangeRequest: {
        findUnique: vi.fn(async () => ({ requestedChanges: { requested: {} } })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    });
    // #2526 review: NOT reported as drift. A row that predates the replayable
    // delta format is unexecutable, but nothing about the booking moved, and
    // telling the officer it did sends them looking for an edit that never
    // happened.
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, tx),
    ).resolves.toEqual({ intact: false, reason: "unreplayable" });
  });

  it("FAILS when the live booking has vanished", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    const tx = makeTx({ booking: { findUnique: vi.fn(async () => null) } });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(snapshot, tx),
    ).resolves.toEqual({ intact: false, reason: "drift" });
  });

  it("passes a new-booking proposal through — it has no live base to drift", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.verifyLiveProposalIntegrity?.(NEW_BOOKING_SNAPSHOT, makeTx()),
    ).resolves.toEqual({ intact: true });
  });
});

describe("executeApprovedProposal — modification", () => {
  async function runExecution(
    override: ConfirmedOverride,
    contextOverrides: {
      hostingCoverageOverride?: {
        acknowledged: true;
        reason: string;
        strandedStateKey: string;
      };
    } = {},
  ) {
    const snapshot = frozenModificationSnapshot();
    const { hooks, outcome } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
      adminNotes: "Long-standing member, one-off.",
      ...contextOverrides,
    });
    const tx = makeTx();
    // The engine always runs the integrity hook first; it is what seeds the
    // verified delta the executor replays.
    await hooks.verifyLiveProposalIntegrity?.(snapshot, tx);
    const result = await hooks.executeApprovedProposal({
      tx,
      request: loadedRequest({ proposalHash: computeProposalHash(snapshot) }),
      snapshot,
      override,
    });
    return { result, outcome, tx };
  }

  it("runs the canonical service on the approval transaction with a HARD capacity refusal", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    const call = modifyBookingBatch.mock.calls[0][0];
    expect(call.bookingId).toBe("bk-1");
    // ADMIN is what applies the reviewed minimum-stay override.
    expect(call.actor).toEqual({ id: OFFICER, role: "ADMIN" });
    // The two capacity-widening switches are NEVER set by an approval.
    expect(call.input.confirmOverCapacity).toBeUndefined();
    expect(call.input.adminOverride).toBeUndefined();
    // It runs INSIDE the approval transaction — no mark-approved-then-call gap.
    expect(call.tx).toBeDefined();
  });

  it("replays exactly the verified delta", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    const { input } = modifyBookingBatch.mock.calls[0][0];
    expect(input.addGuests).toEqual([
      {
        firstName: "Grace",
        lastName: "Hopper",
        ageTier: "ADULT",
        isMember: false,
        stayStart: null,
        stayEnd: null,
        nights: ["2026-07-02"],
      },
    ]);
  });

  it("records the officer's hosting decision when that rule was overridden", async () => {
    const { outcome } = await runExecution(HOSTING_OVERRIDE);
    expect(recordAdultMemberHostingReviewDecision).toHaveBeenCalledTimes(1);
    const [bookingId, , decision] =
      recordAdultMemberHostingReviewDecision.mock.calls[0];
    expect(bookingId).toBe("bk-1");
    expect(decision.byMemberId).toBe(OFFICER);
    // D-R4: attributable, and it says which rule and which request.
    expect(decision.reason).toContain("ADULT_MEMBER_HOSTING_REQUIRED");
    expect(decision.reason).toContain("req-1");
    expect(outcome.hostingDecisionRecorded).toBe(true);
    expect(modifyBookingBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedExceptionAdultMemberHostingDecision: {
          byMemberId: OFFICER,
          reason: expect.stringContaining("ADULT_MEMBER_HOSTING_REQUIRED"),
        },
      }),
    );

    // #2576 §7. AND THE APPROVAL CLOSES THE INCIDENT, in this same transaction.
    // Without it the approval was undone on the next pass: the drain's reconciliation
    // tests only whether the hazard is GONE, and an approved exception AUTHORISES the
    // hazard rather than removing it — so an officer who had just decided these exact
    // uncovered nights, with a reason, had a `critical` incident re-affirmed against
    // their own decision, permanently, with no route or UI able to clear it.
    expect(resolveHostingCoverageIncidents).toHaveBeenCalledTimes(1);
    const resolution = resolveHostingCoverageIncidents.mock.calls[0]?.[0];
    expect(resolution).toMatchObject({
      bookingId: "bk-1",
      resolution: "EXCEPTION_APPROVED",
      actorMemberId: OFFICER,
    });
  });

  it("passes the private same-owner coverage override separately from member-facing notes", async () => {
    const hostingCoverageOverride = {
      acknowledged: true as const,
      reason: "Officer confirmed alternative supervision.",
      strandedStateKey: `v1:${"a".repeat(64)}`,
    };
    await runExecution(HOSTING_OVERRIDE, { hostingCoverageOverride });

    expect(modifyBookingBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        hostingCoverageOverride,
        approvedExceptionAdultMemberHostingDecision: expect.any(Object),
      }),
    );
  });

  it("does NOT touch the hosting review when that rule was not overridden", async () => {
    await runExecution(MIN_STAY_OVERRIDE);
    expect(recordAdultMemberHostingReviewDecision).not.toHaveBeenCalled();
    // Nor the incident: nothing was authorised, so there is nothing to close.
    expect(resolveHostingCoverageIncidents).not.toHaveBeenCalled();
  });

  it("refuses to execute without a verified delta (fails loudly, never silently)", async () => {
    const snapshot = frozenModificationSnapshot();
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest(),
        snapshot,
        override: NO_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionUnverifiedExecutionError);
    expect(modifyBookingBatch).not.toHaveBeenCalled();
  });
});

describe("executeApprovedProposal — new booking", () => {
  function hooksFor(adminNotes?: string) {
    return buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
      adminNotes,
      newBookingExecution: {
        status: "PAYMENT_PENDING" as never,
        shouldBePending: false,
        holdDays: 0,
        paymentMethod: "stripe",
        memberGuestPolicy: MEMBER_GUEST_POLICY,
      },
    });
  }

  it("creates the reviewed booking on the approval transaction, with capacity HARD", async () => {
    const { hooks, outcome } = hooksFor();
    const tx = makeTx();
    await hooks.executeApprovedProposal({
      tx,
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    const input = createConfirmedBooking.mock.calls[0][0];
    expect(input.effectiveMemberId).toBe("m-1");
    expect(input.lodgeId).toBe(LODGE);
    expect(input.sessionUserId).toBe(OFFICER);
    expect(input.isOnBehalf).toBe(true);
    expect(input.confirmOverCapacity).toBeUndefined();
    expect(input.waitlistIntent).toBeUndefined();
    expect(input.tx).toBeDefined();
    // The frozen night set survives the round-trip explicitly (#713).
    expect(input.guests[0].nights).toEqual(["2026-07-01", "2026-07-02"]);
    expect(outcome.createdBookingId).toBe("bk-new");
    // The executed booking is linked back onto the request row in the same tx.
    expect(
      txMocks(tx).newBookingPolicyExceptionRequest.updateMany.mock.calls[0][0]
        .data.createdBookingId,
    ).toBe("bk-new");
  });

  it("executes at the lodge the proposal FROZE, never the club's default", async () => {
    // The multi-lodge leak this guards is the one that costs a real oversell: an
    // exception raised at a second lodge executing at whichever lodge a missing
    // `lodgeId` falls back to (the club default). Both lodge-bearing steps of the
    // execution must follow the FROZEN lodge — the capacity recheck and the
    // canonical create — so both are asserted against a lodge that is NOT the
    // one every other case in this file uses. `e2e/multi-lodge/
    // policy-exception-second-lodge.spec.ts` is the same guarantee end to end.
    const SECOND_LODGE = "lodge-b";
    expect(SECOND_LODGE).not.toBe(LODGE);
    const snapshot = { ...NEW_BOOKING_SNAPSHOT, lodgeId: SECOND_LODGE };
    const { hooks } = hooksFor();
    const tx = makeTx();

    await expect(hooks.recheckCapacity(snapshot, tx)).resolves.toEqual({ ok: true });
    expect(checkCapacityForGuestRanges.mock.calls[0][0]).toBe(SECOND_LODGE);

    await hooks.executeApprovedProposal({
      tx,
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot,
      override: MIN_STAY_OVERRIDE,
    });
    expect(createConfirmedBooking.mock.calls[0][0].lodgeId).toBe(SECOND_LODGE);
  });

  it("runs the member-guest authorisation pipeline as the REQUESTING MEMBER", async () => {
    // #2526 review. `createConfirmedBooking` does NOT validate guest member links
    // — every other caller runs this sequence itself first. Skipping it let a
    // member name any active member's id in an exception request and have an
    // approval attach them: no beyond-family refusal, no consent row, no
    // profile/bookability gate, and the guest row keeping the REQUESTER's declared
    // age tier and membership (which also priced them at the member rate).
    const { hooks } = hooksFor();
    await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });

    // Resolved against the REQUESTER's family, with authorization ENFORCED — the
    // officer reviewed minimum stay, not the family boundary.
    const [, bookingMemberId, memberIds, options] =
      resolveLinkedBookingMembersWithBoundary.mock.calls[0] as unknown as [
        unknown,
        string,
        unknown[],
        { skipAuthorization: boolean; memberGuestWideningEnabled: boolean },
      ];
    expect(bookingMemberId).toBe("m-1");
    expect(memberIds).toEqual(["m-1"]);
    expect(options.skipAuthorization).toBe(false);
    expect(options.memberGuestWideningEnabled).toBe(false);

    // The D-8 profile/bookability gate runs, judged as the member, never as an
    // admin acting on behalf (which would return early and skip it).
    const [, , currentUserId, context] =
      assertLinkedBookingMembersCanBeBooked.mock.calls[0] as unknown as [
        unknown,
        unknown,
        string,
        { actorRole: string; onBehalfOfMemberId: string | null },
      ];
    expect(currentUserId).toBe("m-1");
    expect(context.actorRole).toBe("MEMBER");
    expect(context.onBehalfOfMemberId).toBeNull();

    // Consent is planned with the MEMBER as actor, so a beyond-family add opens a
    // PENDING consent request instead of being stamped consent-free by the admin.
    const consentArgs = planMemberGuestConsentWrites.mock
      .calls[0][0] as unknown as { actor: { kind: string } };
    expect(consentArgs.actor.kind).toBe("MEMBER");

    // The member record is authoritative for the guest's identity fields.
    expect(normalizeBookingGuestInputs).toHaveBeenCalledTimes(1);
  });

  it("rolls the approval back when the pipeline refuses a member guest", async () => {
    // With the memberGuests module off — the shipped default — a beyond-family
    // member id is refused, exactly as the member's own booking path refuses it.
    // The refusal has to abort the approval, not be swallowed.
    resolveLinkedBookingMembersWithBoundary.mockRejectedValueOnce(
      new Error("Invalid guest member reference"),
    );
    const { hooks, outcome } = hooksFor();
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest({ bookingId: null, kind: null }),
        snapshot: NEW_BOOKING_SNAPSHOT,
        override: MIN_STAY_OVERRIDE,
      }),
    ).rejects.toThrow(/Invalid guest member reference/);
    // Nothing was created, and nothing was recorded as executed.
    expect(createConfirmedBooking).not.toHaveBeenCalled();
    expect(outcome.createdBookingId).toBeNull();
  });

  it("executes as a reviewed member proposal, so the supervision review is not auto-approved", async () => {
    const { hooks } = hooksFor();
    await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    const input = createConfirmedBooking.mock.calls[0][0];
    expect(input.reviewedMemberProposal).toBe(true);
  });

  it("carries the member's own words as the review justification", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
      memberMessage: "  My sister is bringing her kids and I will be there.  ",
      newBookingExecution: {
        status: "PAYMENT_PENDING" as never,
        shouldBePending: false,
        holdDays: 0,
        paymentMethod: "stripe",
        memberGuestPolicy: MEMBER_GUEST_POLICY,
      },
    });
    await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    expect(
      createConfirmedBooking.mock.calls[0][0].memberReviewJustification,
    ).toBe("My sister is bringing her kids and I will be there.");
  });

  it("dispatches the consent and family-add notices after the commit, not inside it", async () => {
    // A consent row nobody is told about is a bed held for a member who was never
    // asked, which only the nightly sweep clears (#2526 review).
    // Typed as taking their one argument object, so the assertions below can read
    // it (a zero-arg `vi.fn` gives `.mock.calls[0]` the empty-tuple type).
    const sendMemberGuestAddNotifications = vi.fn(
      async (_args: Record<string, unknown>) => undefined,
    );
    const sendFamilyMemberBookingAddNotifications = vi.fn(
      async (_args: Record<string, unknown>) => undefined,
    );
    vi.doMock("@/lib/member-guest-consent-notifications", () => ({
      sendMemberGuestAddNotifications,
    }));
    vi.doMock("@/lib/family-booking-add-notifications", () => ({
      sendFamilyMemberBookingAddNotifications,
    }));

    const { hooks } = hooksFor();
    const executed = await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    // Nothing has been dispatched yet: the caller still owns the commit.
    expect(sendFamilyMemberBookingAddNotifications).not.toHaveBeenCalled();

    await executed.deferredPostCommit();
    // The created booking's member guest gets the family-add notice.
    expect(sendFamilyMemberBookingAddNotifications).toHaveBeenCalledTimes(1);
    const args = sendFamilyMemberBookingAddNotifications.mock
      .calls[0][0] as unknown as {
      bookingId: string;
      bookerMemberId: string;
      actorMemberId: string;
      addedMemberIds: string[];
    };
    expect(args.bookingId).toBe("bk-new");
    expect(args.bookerMemberId).toBe("m-1");
    expect(args.actorMemberId).toBe(OFFICER);
    expect(args.addedMemberIds).toEqual(["m-1"]);

    vi.doUnmock("@/lib/member-guest-consent-notifications");
    vi.doUnmock("@/lib/family-booking-add-notifications");
  });

  it("THROWS on capacityExceeded so the whole approval rolls back", async () => {
    createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: ["2026-07-01"],
    });
    const { hooks, outcome } = hooksFor();
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest({ bookingId: null, kind: null }),
        snapshot: NEW_BOOKING_SNAPSHOT,
        override: MIN_STAY_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionExecutionCapacityError);
    // Nothing was recorded as executed: the request must not look approved.
    expect(outcome.createdBookingId).toBeNull();
  });

  it("passes the hosting reason only when that rule was actually overridden", async () => {
    const { hooks } = hooksFor("Parents are staying in the next room.");
    await hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: HOSTING_OVERRIDE,
    });
    expect(createConfirmedBooking.mock.calls[0][0].adultMemberHostingReason).toContain(
      "Parents are staying in the next room.",
    );

    createConfirmedBooking.mockClear();
    const second = hooksFor("note");
    await second.hooks.executeApprovedProposal({
      tx: makeTx(),
      request: loadedRequest({ bookingId: null, kind: null }),
      snapshot: NEW_BOOKING_SNAPSHOT,
      override: MIN_STAY_OVERRIDE,
    });
    expect(
      createConfirmedBooking.mock.calls[0][0].adultMemberHostingReason,
    ).toBeUndefined();
  });

  it("refuses to execute without resolved execution parameters", async () => {
    const { hooks } = buildPolicyExceptionApprovalHooks({
      todayAtClub: FIXTURE_CLUB_DAY,
      requestId: "req-1",
      actorMemberId: OFFICER,
      ipAddress: "1.2.3.4",
    });
    await expect(
      hooks.executeApprovedProposal({
        tx: makeTx(),
        request: loadedRequest({ bookingId: null, kind: null }),
        snapshot: NEW_BOOKING_SNAPSHOT,
        override: NO_OVERRIDE,
      }),
    ).rejects.toBeInstanceOf(PolicyExceptionUnverifiedExecutionError);
    expect(createConfirmedBooking).not.toHaveBeenCalled();
  });
});

describe("proposalGuestToCreateInput", () => {
  it("keeps a non-contiguous stay intact and derives its envelope", () => {
    const guest = proposalGuestToCreateInput({
      firstName: "Ada",
      lastName: "Lovelace",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m-1",
      nights: ["2026-07-04", "2026-07-01"],
    });
    expect(guest.nights).toEqual(["2026-07-01", "2026-07-04"]);
    expect(guest.stayStart.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(guest.stayEnd.toISOString().slice(0, 10)).toBe("2026-07-05");
  });

  it("refuses a non-bookable age tier rather than coercing it", () => {
    expect(() =>
      proposalGuestToCreateInput({
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "NOT_A_TIER",
        isMember: true,
        memberId: null,
        nights: ["2026-07-01"],
      }),
    ).toThrow(/non-bookable age tier/);
  });

  it("refuses a guest who occupies no nights", () => {
    expect(() =>
      proposalGuestToCreateInput({
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: null,
        nights: [],
      }),
    ).toThrow(/no nights/);
  });
});

describe("resolveNewBookingExecutionParams", () => {
  it("uses the club's hold policy for a party with non-members", async () => {
    const snapshot: NewBookingProposalSnapshot = {
      ...NEW_BOOKING_SNAPSHOT,
      proposed: {
        ...NEW_BOOKING_SNAPSHOT.proposed,
        guests: [
          { ...NEW_BOOKING_SNAPSHOT.proposed.guests[0], isMember: false, memberId: null },
        ],
      },
    };
    const params = await resolveNewBookingExecutionParams(snapshot);
    expect(getNonMemberHoldPolicy).toHaveBeenCalled();
    expect(params.holdDays).toBe(7);
    expect(params.paymentMethod).toBe("stripe");
  });

  it("does not read the hold policy for an all-member party", async () => {
    const params = await resolveNewBookingExecutionParams(NEW_BOOKING_SNAPSHOT);
    expect(getNonMemberHoldPolicy).not.toHaveBeenCalled();
    expect(params.shouldBePending).toBe(false);
    expect(params.holdDays).toBe(0);
  });
});

describe("buildOverrideReason", () => {
  it("names the request and every rule still being overridden", () => {
    expect(
      buildOverrideReason({
        requestId: "req-9",
        override: MIN_STAY_OVERRIDE,
        adminNotes: "Agreed at committee.",
      }),
    ).toBe(
      "Booking-policy exception approved (request req-9): MINIMUM_STAY. Agreed at committee.",
    );
  });

  it("is still attributable when the officer left no note", () => {
    expect(
      buildOverrideReason({ requestId: "req-9", override: MIN_STAY_OVERRIDE }),
    ).toContain("request req-9");
  });
});
