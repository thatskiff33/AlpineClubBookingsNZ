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
 * Every wait is matched to the backend it waits on (`pg_blocking_pids`).
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, isBlocking, RACE_TRANSACTION_BUDGET, untilBlockedChain } from "./support/race-lock-waits";

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

/** A pause just before the approval takes its booking-row lock, handed the transaction's backend id. */
const beforeBookingRow = vi.hoisted(() => ({ bookingId: null as null | string, paused: null as null | ((pid: number) => Promise<void>) }));
vi.mock("@/lib/booking-row-lock", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-row-lock");
  return {
    ...real,
    lockBookingRowForOwnerRead: async (...args: Parameters<typeof real.lockBookingRowForOwnerRead>) => {
      const hook = args[1] === beforeBookingRow.bookingId ? beforeBookingRow.paused : null;
      if (hook) {
        beforeBookingRow.paused = null;
        await hook(await backendPid(args[0] as unknown as Prisma.TransactionClient));
      }
      return real.lockBookingRowForOwnerRead(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4853-merge-exception-";
const names = historyNames(PREFIX);
const OFFICER_ID = `${PREFIX}officer-full`;
const PRICE = 20_000;
let prisma: PrismaClient;

/** A pause inside the approval after its claim, at the canonical service, handed the transaction's backend id. */
let afterClaim: null | ((pid: number) => Promise<void>) = null;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", canLogin: true, ...extra } });
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
        const hook = afterClaim;
        if (hook) {
          afterClaim = null;
          await hook(await backendPid(tx));
        }
        // The canonical service's write to the booking row, without re-pricing a fixture it does not have.
        await tx.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date() } });
        return { deferredPostCommit: async () => {} };
      },
      notifyApproved: async () => {},
    },
  });
}

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
}

async function requestState(requestId: string) {
  return prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, requestedByMemberId: true, reviewedByMemberId: true } });
}

async function bookingState(id: string) {
  return prisma.booking.findUniqueOrThrow({ where: { id }, select: { memberId: true, createdById: true } });
}

function expectFulfilled(settled: PromiseSettledResult<unknown>) {
  expect(settled.status, settled.status === "rejected" ? String(settled.reason) : "").toBe("fulfilled");
}

async function approvalArrivingWhileMergeWaitsOnTheMember(loser: string, runMerge: () => Promise<unknown>, approval: () => Promise<unknown>) {
  const held = gate();
  const release = gate();
  let blockerPid = 0;
  const keyShare = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${loser} FOR KEY SHARE`;
    blockerPid = await backendPid(tx);
    held.open();
    await release.opened;
  }, RACE_TRANSACTION_BUDGET);
  await held.opened;
  let merging: Promise<unknown> = Promise.resolve();
  let approving: Promise<unknown> = Promise.resolve();
  try {
    merging = runMerge();
    await untilBlockedChain(prisma, blockerPid, 1);
    approving = approval();
    await untilBlockedChain(prisma, blockerPid, 2);
  } finally {
    release.open();
  }
  await keyShare;
  const [merged, approved] = await Promise.allSettled([merging, approving]);
  return { merged, approved };
}

async function mergeArrivingWhileApprovalHoldsItsClaim(runMerge: () => Promise<unknown>, approval: () => Promise<unknown>) {
  const reached = gate();
  const release = gate();
  let approvalPid = 0;
  afterClaim = async (pid) => {
    approvalPid = pid;
    reached.open();
    await release.opened;
  };
  const approving = approval();
  await reached.opened;
  let merging: Promise<unknown> = Promise.resolve();
  try {
    merging = runMerge();
    await untilBlockedChain(prisma, approvalPid, 1);
  } finally {
    release.open();
  }
  const [approved, merged] = await Promise.allSettled([approving, merging]);
  return { merged, approved };
}

/** Whether the merge settled (either way) or came to wait on the paused approval's backend. */
async function settledOrBlockedBy(merging: Promise<unknown>, writerPid: number): Promise<"settled" | "waiting"> {
  let settled = false;
  void merging.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (settled) return "settled";
    if (await isBlocking(prisma, writerPid)) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the merge neither settled nor waited");
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
    afterClaim = null;
    beforeBookingRow.paused = null;
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

  it("MUTATION: (a) a merge holding the booking and waiting for the officer's Member row makes that officer's approval wait at the booking row; the merge commits and the approval refuses cleanly", async () => {
    const { loser, master } = await mergePair("a-merge-first", true);
    const { id, requestId } = await seed("a-merge-first", loser, false);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await approvalArrivingWhileMergeWaitsOnTheMember(loser, runMerge, () => approve(requestId, id, loser));
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "notAuthorized" } });
    expect(await requestState(requestId)).toEqual({ status: "REQUESTED", requestedByMemberId: names.memberId, reviewedByMemberId: null });
    expect(await bookingState(id)).toEqual({ memberId: names.memberId, createdById: master });
  });

  it("MUTATION: (a) an approval by the duplicate holding its claim makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("a-approval-first", true);
    const { id, requestId } = await seed("a-approval-first", loser, false);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await mergeArrivingWhileApprovalHoldsItsClaim(runMerge, () => approve(requestId, id, loser));
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: names.memberId, reviewedByMemberId: master });
    expect(await bookingState(id)).toEqual({ memberId: names.memberId, createdById: master });
  });

  it("(b) a merge holding the duplicate's booking and request makes the approval wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("b-merge-first", false);
    const { id, requestId } = await seed("b-merge-first", loser, true);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await approvalArrivingWhileMergeWaitsOnTheMember(loser, runMerge, () => approve(requestId, id, OFFICER_ID));
    expectFulfilled(merged);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState(id)).toEqual({ memberId: master, createdById: master });
  });

  it("MUTATION: (b) an approval holding its claim on the duplicate's request makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("b-approval-first", false);
    const { id, requestId } = await seed("b-approval-first", loser, true);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await mergeArrivingWhileApprovalHoldsItsClaim(runMerge, () => approve(requestId, id, OFFICER_ID));
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState(id)).toEqual({ memberId: master, createdById: master });
  });

  it("MUTATION: (b) an approval paused at its booking-row lock holds nothing the merge needs: the merge commits, then the approval executes on the survivor's request", async () => {
    const { loser, master } = await mergePair("b-at-the-lock", false);
    const { id, requestId } = await seed("b-at-the-lock", loser, true);
    const runMerge = await previewMerge(master, loser);
    const reached = gate();
    const release = gate();
    let approvalPid = 0;
    beforeBookingRow.bookingId = id;
    beforeBookingRow.paused = async (pid) => {
      approvalPid = pid;
      reached.open();
      await release.opened;
    };
    const approving = approve(requestId, id, OFFICER_ID);
    let merging: Promise<unknown> = Promise.resolve();
    let first: "settled" | "waiting" = "waiting";
    try {
      // Taken before the claim, the lock is where this approval stops; one that never takes it cannot be paused there.
      await Promise.race([reached.opened, approving.then(() => { throw new Error("the approval never took the booking-row lock"); })]);
      merging = runMerge();
      first = await settledOrBlockedBy(merging, approvalPid);
    } finally {
      release.open();
    }
    const [merged, approved] = await Promise.allSettled([merging, approving]);
    // Before #4853 the approval had claimed the request by here, so the merge waited on it while holding the booking.
    expect(first, "the merge waited on the approval before it took the booking row").toBe("settled");
    expectFulfilled(merged);
    expectFulfilled(approved);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState(requestId)).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
  });
});
