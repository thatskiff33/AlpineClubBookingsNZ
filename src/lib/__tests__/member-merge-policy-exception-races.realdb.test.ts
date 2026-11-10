/**
 * #4853 against real PostgreSQL: approving a policy exception on an existing
 * booking (`approveAndExecutePolicyExceptionRequest`, the MODIFICATION store)
 * racing a member merge, in both orders, for the two cycles #4845 found in the
 * change-request approval.
 *
 * The approval takes `lock(1)` and the lodge key, then claims the request: the
 * claim names the officer (`reviewedByMemberId`, a `FOR KEY SHARE` on that
 * Member row) and holds the request row. Then the canonical service updates the
 * booking. Member merge takes no `lock(1)`; it holds booking rows from its
 * relation moves on, then re-points `BookingChangeRequest.requestedBy`, then
 * takes `Member … FOR UPDATE`. With the booking at a lodge outside merge's lodge
 * prefix:
 *
 * - (a) the approving officer is the duplicate being merged;
 * - (b) the duplicate owns the booking and made the request.
 *
 * The approval now takes the booking row right after its lodge key, before the
 * claim, keyed from the request's booking id read before the locks.
 *
 * What is real: the engine and its lock order, the modification store (pre-read,
 * fresh read, guarded claim), the officer's fresh role check
 * (`reauthorizeBookingOfficerFromDb`), the request row and member merge. What
 * stands in: the policy and integrity hooks (no policy-exception fixture exists
 * on real PostgreSQL), and the canonical `modifyBookingBatch`, represented by
 * the booking-row UPDATE it makes. The lock order under test is the engine's;
 * the hooks decide only whether it proceeds.
 *
 * The choreography and its waits, each matched to the backend it waits on
 * (`pg_blocking_pids`), are shared with the other merge race suites
 * (`support/member-merge-race.ts`).
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  arrivingWhilePaused, beforeBookingRow, clearPauses, createRaceMember, expectFulfilled, firstStandWhilePaused, keyShareOnMember, pauseIn,
  previewMerge, writerArrivingWhileMergeIsParked,
} from "./support/member-merge-race";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The approval opens its transaction with no options: give it a budget the race, not the runner, decides. */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

/** A pause just before the approval takes its booking-row lock (slot `beforeBookingRow(id)`). */
vi.mock("@/lib/booking-row-lock", async (importOriginal) =>
  (await import("./support/member-merge-race")).bookingRowLockDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4853-merge-exception-";
const names = historyNames(PREFIX);
const OFFICER_ID = `${PREFIX}officer-full`;
const PRICE = 20_000;
let prisma: PrismaClient;

function member(id: string, extra: Record<string, unknown> = {}) {
  return createRaceMember(prisma, id, { canLogin: true, ...extra });
}

/**
 * A booking the duplicate made, at a lodge neither merge party has a guest row
 * in, with a pending policy-exception request on it. `ownedByDuplicate` makes the
 * duplicate the owner and the requester (cycle b); otherwise the history member
 * owns it and asked (cycle a).
 */
async function seed(tag: string, loser: string, ownedByDuplicate: boolean) {
  const { computeProposalHash, freezePolicyExceptionEvidence } = await import("@/lib/booking-exception-requests");
  const id = `${PREFIX}b-${tag}`;
  const owner = ownedByDuplicate ? loser : names.memberId;
  await createHistoryBooking(prisma, { ...names, memberId: owner }, id, { payment: { amountCents: PRICE, source: "INTERNET_BANKING" } });
  await prisma.booking.update({ where: { id }, data: { createdById: loser } });
  const party = { checkIn: "2027-08-01", checkOut: "2027-08-03", guests: [{ firstName: "History", lastName: "g1", ageTier: "ADULT" as const, isMember: false, memberId: null, nights: ["2027-08-01", "2027-08-02"] }] };
  const snapshot = { kind: "MODIFICATION" as const, lodgeId: names.lodgeId, bookingId: id, base: party, proposed: { ...party, checkOut: "2027-08-02", guests: [{ ...party.guests[0]!, nights: ["2027-08-01"] }] } };
  const evidence = freezePolicyExceptionEvidence([{
    reasonCode: "MINIMUM_STAY", policyId: `${PREFIX}policy`, policyVersion: 1, policyName: "Weekend minimum stay",
    resolvedScope: { kind: "CLUB_WIDE", lodgeId: null, effectiveLodgeId: names.lodgeId }, affectedNights: ["2027-08-01"], exceptionEligible: true,
    capacityMode: "NO_HOLD", message: "Two-night minimum.", triggerDay: "2027-08-01", minimumNights: 2, actualNights: 1,
    requirements: { kind: "MINIMUM_STAY", minimumNights: 2, actualNights: 1, triggerDays: [0] },
  }]);
  const requestId = `${id}-exception`;
  await prisma.bookingChangeRequest.create({
    data: {
      id: requestId, bookingId: id, requestedByMemberId: owner, kind: "POLICY_EXCEPTION", status: "REQUESTED",
      requestedChanges: {}, proposalSnapshot: snapshot, proposalHash: computeProposalHash(snapshot),
      frozenEvidence: evidence as unknown as Prisma.InputJsonValue, aggregateCapacityMode: "NO_HOLD",
      openStateKey: `pe:${id}:${owner}`,
    },
  });
  return { id, requestId, owner, reviewed: evidence };
}

/** The approval, with the real engine, store and role check; the policy hooks pass and the service updates the booking. */
async function approve(requestId: string, bookingId: string, officer: string) {
  const engine = await import("@/lib/booking-exception-execution");
  const { reauthorizeBookingOfficerFromDb } = await import("@/lib/booking-exception-approval");
  const { reviewedViolationsFromEvidence, parseFrozenEvidence } = await import("@/lib/booking-exception-requests");
  return engine.approveAndExecutePolicyExceptionRequest({
    requestId, expectedVersion: 1, actorMemberId: officer,
    hooks: {
      reauthorizeBookingOfficer: reauthorizeBookingOfficerFromDb,
      verifyLiveProposalIntegrity: async () => true,
      evaluateCurrentViolations: async (_snapshot, tx) => {
        const row = await tx.bookingChangeRequest.findUniqueOrThrow({ where: { id: requestId }, select: { frozenEvidence: true } });
        return reviewedViolationsFromEvidence(parseFrozenEvidence(row.frozenEvidence)!);
      },
      recheckCapacity: async () => ({ ok: true }),
      executeApprovedProposal: async ({ tx }) => {
        // A pause inside the approval after its claim, at the canonical service (slot "afterClaim").
        await pauseIn("afterClaim", tx);
        // The canonical service's write to the booking row, without re-pricing a fixture it does not have.
        await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
        return { deferredPostCommit: async () => {} };
      },
      notifyApproved: async () => {},
    },
  });
}

async function requestState(requestId: string) {
  return prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, requestedByMemberId: true, reviewedByMemberId: true } });
}

async function bookingState(id: string) {
  return prisma.booking.findUniqueOrThrow({ where: { id }, select: { memberId: true, createdById: true } });
}

(RUN ? describe : describe.skip)("approving a policy exception on a booking racing a member merge (#4853)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4853 merge policy-exception race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await member(OFFICER_ID, { role: "ADMIN", accessRoles: { create: { role: "ADMIN" } } });
  }, 120_000);

  afterAll(async () => {
    clearPauses();
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await prisma.bookingChangeRequest.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  /** The duplicate and its survivor; a booking officer when `officer`, a role a merge may remove. */
  async function mergePair(tag: string, officer: boolean) {
    const loser = `${PREFIX}loser-${tag}`;
    const master = `${PREFIX}master-${tag}`;
    await member(loser, officer ? { accessRoles: { create: { role: "ADMIN_BOOKINGS" } } } : {});
    await member(master);
    return { loser, master };
  }

  it("MUTATION: (a) a merge waiting for the officer's Member row holds no booking row, so that officer's approval commits and the merge carries the reviewer to the survivor", async () => {
    const { loser, master } = await mergePair("a-merge-first", true);
    const { id, requestId } = await seed("a-merge-first", loser, false);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { merged, written: approved, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(loser), runMerge, () => approve(requestId, id, loser), { writer: "queuesOrFinishes" },
    );
    expect(writerFirst, "the approval waited on the merge").toBe("settled");
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: names.memberId, reviewedByMemberId: master });
    expect(await bookingState(id)).toEqual({ memberId: names.memberId, createdById: master });
  });

  it("MUTATION: (a) an approval by the duplicate holding its claim makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("a-approval-first", true);
    const { id, requestId } = await seed("a-approval-first", loser, false);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { held: approved, arrived: merged } = await arrivingWhilePaused(prisma, "afterClaim", () => approve(requestId, id, loser), runMerge);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: names.memberId, reviewedByMemberId: master });
    expect(await bookingState(id)).toEqual({ memberId: names.memberId, createdById: master });
  });

  it("(b) a merge waiting for the duplicate's Member row holds no booking or request row, so the approval commits and the merge carries both to the survivor", async () => {
    const { loser, master } = await mergePair("b-merge-first", false);
    const { id, requestId } = await seed("b-merge-first", loser, true);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { merged, written: approved, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(loser), runMerge, () => approve(requestId, id, OFFICER_ID), { writer: "queuesOrFinishes" },
    );
    expect(writerFirst, "the approval waited on the merge").toBe("settled");
    expectFulfilled(merged);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState(id)).toEqual({ memberId: master, createdById: master });
  });

  it("MUTATION: (b) an approval holding its claim on the duplicate's request makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("b-approval-first", false);
    const { id, requestId } = await seed("b-approval-first", loser, true);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { held: approved, arrived: merged } = await arrivingWhilePaused(prisma, "afterClaim", () => approve(requestId, id, OFFICER_ID), runMerge);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState(id)).toEqual({ memberId: master, createdById: master });
  });

  it("MUTATION: (b) an approval paused at its booking-row lock holds nothing the merge needs: the merge commits, then the approval executes on the survivor's request", async () => {
    const { loser, master } = await mergePair("b-at-the-lock", false);
    const { id, requestId } = await seed("b-at-the-lock", loser, true);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    // Taken before the claim, the lock is where this approval stops; one that never takes it cannot be paused there.
    const { first, held: approved, arrived: merged } = await firstStandWhilePaused(
      prisma, beforeBookingRow(id), () => approve(requestId, id, OFFICER_ID), runMerge,
      { label: "the merge", neverPaused: "the approval never took the booking-row lock" },
    );
    // Before #4853 the approval had claimed the request by here, so the merge waited on it while holding the booking.
    expect(first, "the merge waited on the approval before it took the booking row").toBe("settled");
    expectFulfilled(merged);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
  });
});
