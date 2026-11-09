/**
 * #4845 against real PostgreSQL: approving a locked-period change request
 * (`approveAndExecuteLockedPeriodChangeRequest`) racing a member merge, in both
 * orders, for the two cycles the issue names.
 *
 * The approval takes `lock(1)`, the lodge key, then claims the request: the
 * claim names the officer (`reviewedByMemberId`, a `FOR KEY SHARE` on that
 * Member row) and holds the request row. Member merge takes no `lock(1)`. It
 * holds booking rows from its relation moves on, then re-points
 * `BookingChangeRequest.requestedBy`, then takes `Member … FOR UPDATE`. With the
 * booking at a lodge outside merge's lodge prefix:
 *
 * - (a) the approving officer is the duplicate being merged: merge holds the
 *   booking and waits on the officer's Member row, the approval holds the key
 *   share and waits on the booking;
 * - (b) the duplicate owns the booking and made the request: merge holds the
 *   booking and waits on the request row, the approval holds the request row and
 *   waits on the booking.
 *
 * No merge guard refuses while the duplicate has a pending change request
 * (`countPendingLifecycleOrFamily` counts lifecycle, family-join and deletion
 * requests only), so (b) is reachable; case (b) here runs with the guard matrix
 * passing. The approval now takes the booking row right after its lodge key,
 * before the claim: booking row, then Member and request rows, as merge orders
 * them.
 *
 * The approval-first cases pause the approval after its claim, at the canonical
 * `modifyBookingBatch`. The merge-first cases park merge at its
 * `Member … FOR UPDATE` behind another session's key share on the duplicate, so
 * merge holds the booking (and, in (b), has re-pointed the request) while it
 * waits. Every wait is matched to the backend it waits on (`pg_blocking_pids`).
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, isBlocking, untilBlockedChain } from "./support/race-lock-waits";

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

/** A pause inside the approval after its claim, at the canonical service, handed the transaction's backend id. */
const pause = vi.hoisted(() => ({ afterClaim: null as null | ((pid: number) => Promise<void>) }));
vi.mock("@/lib/booking-batch-modification-service", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-batch-modification-service");
  return {
    ...real,
    modifyBookingBatch: async (...args: Parameters<typeof real.modifyBookingBatch>) => {
      const hook = pause.afterClaim;
      if (hook) {
        pause.afterClaim = null;
        await hook(await backendPid(args[0].tx as Prisma.TransactionClient));
      }
      return real.modifyBookingBatch(...args);
    },
  };
});

/** A pause just before a writer takes the booking-row lock, handed the transaction's backend id. */
const beforeBookingRow = vi.hoisted(() => ({ bookingId: null as null | string, paused: null as null | ((pid: number) => Promise<void>) }));
// The one lock helper lives in `booking-row-lock.ts` (#4845); the journal's doors re-export it, so one mock covers both.
vi.mock("@/lib/booking-row-lock", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-row-lock");
  return {
    ...real,
    lockBookingRowForOwnerRead: async (...args: Parameters<typeof real.lockBookingRowForOwnerRead>) => {
      const hook = args[1] === beforeBookingRow.bookingId ? beforeBookingRow.paused : null;
      if (hook) {
        beforeBookingRow.paused = null;
        await hook(await backendPid(args[0] as Prisma.TransactionClient));
      }
      return real.lockBookingRowForOwnerRead(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4845-";
const OWNER_ID = `${PREFIX}owner`;
const OFFICER_ID = `${PREFIX}officer`;
const LODGE_ID = `${PREFIX}lodge`;
const SEASON_ID = `${PREFIX}season`;
const BOOKING_ID = `${PREFIX}booking`;
const GUEST_ID = `${PREFIX}guest`;
const PAYMENT_ID = `${PREFIX}payment`;
const REQUEST_ID = `${PREFIX}request`;
const CHECK_IN = new Date("2026-06-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-12T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const STORED_NIGHT_CENTS = 4_321;

let prisma: PrismaClient;
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({
    data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", canLogin: true, ...extra },
  });
}

/**
 * A COMPLETED two-night stay at a lodge neither merge party has a guest row in,
 * paid by internet banking against an issued invoice, with one LOCKED_PERIOD
 * request to add a guest. `ownedByDuplicate` makes the duplicate the booking's
 * owner and the request's maker (cycle b); otherwise the duplicate only made the
 * booking on the owner's behalf (cycle a).
 */
async function seed(loser: string, ownedByDuplicate: boolean) {
  const owner = ownedByDuplicate ? loser : OWNER_ID;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID, memberId: owner, createdById: loser, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      status: "COMPLETED", totalPriceCents: 2 * STORED_NIGHT_CENTS, finalPriceCents: 2 * STORED_NIGHT_CENTS,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Original", lastName: "Guest", ageTier: "ADULT", isMember: false,
      stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: 2 * STORED_NIGHT_CENTS,
      nights: { create: [
        { stayDate: CHECK_IN, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
        { stayDate: NIGHT_2, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
      ] },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 2 * STORED_NIGHT_CENTS, source: "INTERNET_BANKING", reference: "RACE4845",
      status: "SUCCEEDED", xeroInvoiceId: `${PREFIX}xero-invoice`, xeroInvoiceNumber: "INV-4845",
    },
  });
  await prisma.bookingChangeRequest.create({
    data: {
      id: REQUEST_ID, bookingId: BOOKING_ID, requestedByMemberId: owner, kind: "LOCKED_PERIOD", status: "REQUESTED",
      reason: "My friend stayed both nights too.",
      requestedChanges: {
        original: { checkIn: "2026-06-10", checkOut: "2026-06-12", guests: [{ id: GUEST_ID }] },
        requested: {
          checkIn: null, checkOut: null, addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }],
          removeGuests: [], guestStayRanges: [], requestedEffectiveDate: null, summary: "add Late Friend",
        },
      },
    },
  });
}

type Figures = { additionalAmountCents: number; refundAmountCents: number; accountCreditAmountCents: number };

async function execute(officer: string, mode: { dryRun: true } | { expectedFigures: Figures }) {
  const executor = await import("@/lib/booking-change-request-execution");
  const batchService = await import("@/lib/booking-batch-modification-service");
  const clubTimeServer = await import("@/lib/club-time/server");
  return executor.approveAndExecuteLockedPeriodChangeRequest({
    ...mode,
    requestId: REQUEST_ID, expectedVersion: 1, actorMemberId: officer,
    adminNotes: "Added your friend to the stay.", internalNotes: null, confirmOverCapacity: false,
    todayAtClub: (await clubTimeServer.clubTime()).today(), format: CLUB_FORMAT_TEST,
    preTransaction: await batchService.prepareBatchModificationForCallerTransaction({ audience: "admin" }),
    ipAddress: "127.0.0.1",
  });
}

/** The officer's check of the figures (a dry run that rolls back), read before a race is set up. */
async function checkFigures(officer: string): Promise<Figures> {
  const quoted = await execute(officer, { dryRun: true });
  if (quoted.outcome !== "quoted") throw new Error(`expected a quote, got ${JSON.stringify(quoted)}`);
  return { additionalAmountCents: quoted.additionalAmountCents, refundAmountCents: quoted.refundAmountCents, accountCreditAmountCents: quoted.accountCreditAmountCents };
}

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
}

async function requestState() {
  return prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: REQUEST_ID }, select: { status: true, requestedByMemberId: true, reviewedByMemberId: true } });
}

async function bookingState() {
  return prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { memberId: true, createdById: true } });
}

async function guestCount() {
  return prisma.bookingGuest.count({ where: { bookingId: BOOKING_ID } });
}

function expectFulfilled(settled: PromiseSettledResult<unknown>) {
  expect(settled.status, settled.status === "rejected" ? String(settled.reason) : "").toBe("fulfilled");
}

/** Park the merge at its Member FOR UPDATE behind a key share on the duplicate, start the approval, wait until it queues behind the merge. */
async function approvalArrivingWhileMergeWaitsOnTheMember(loser: string, execute: () => Promise<unknown>, approval: () => Promise<unknown>) {
  const held = gate();
  const release = gate();
  let blockerPid = 0;
  const keyShare = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${loser} FOR KEY SHARE`;
    blockerPid = await backendPid(tx);
    held.open();
    await release.opened;
  }, { maxWait: 30_000, timeout: 120_000 });
  await held.opened;
  let merging: Promise<unknown> = Promise.resolve();
  let approving: Promise<unknown> = Promise.resolve();
  try {
    merging = execute();
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

/** Pause the approval after its claim, start the merge, wait until the merge queues behind the approval. */
async function mergeArrivingWhileApprovalHoldsItsClaim(execute: () => Promise<unknown>, approval: () => Promise<unknown>) {
  const reached = gate();
  const release = gate();
  let approvalPid = 0;
  pause.afterClaim = async (pid) => {
    approvalPid = pid;
    reached.open();
    await release.opened;
  };
  const approving = approval();
  await reached.opened;
  let merging: Promise<unknown> = Promise.resolve();
  try {
    merging = execute();
    await untilBlockedChain(prisma, approvalPid, 1);
  } finally {
    release.open();
  }
  const [approved, merged] = await Promise.allSettled([approving, merging]);
  return { merged, approved };
}

(RUN ? describe : describe.skip)("approving a locked-period change request racing a member merge (#4845)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4845 merge change-request race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
    const queue = xeroQueue.queueXeroBookingEditSettlement;
    const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
      const pending = queue(input);
      if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
      return pending;
    });
    restoreXeroQueue = () => spy.mockRestore();
    await clean();
    await teardownFixtures();
    await member(OWNER_ID);
    await member(OFFICER_ID, { role: "ADMIN", accessRoles: { create: { role: "ADMIN" } } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4845 Lodge", slug: "race-4845" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 } });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID, name: "Race 4845 winter", type: "WINTER", startDate: new Date("2026-06-01T00:00:00.000Z"), endDate: new Date("2026-06-30T00:00:00.000Z"),
        active: true, lodgeId: LODGE_ID,
        membershipTypeRates: { create: [
          { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
          { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
        ] },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    pause.afterClaim = null;
    beforeBookingRow.paused = null;
    await clean();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      pause.afterClaim = null;
      await clean();
      await teardownFixtures();
    } finally {
      restoreXeroQueue?.();
    }
  }, 120_000);

  async function clean() {
    while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
    const modifications = (await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } })).map((row) => row.id);
    await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "BookingModification", localId: { in: modifications } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [BOOKING_ID, REQUEST_ID] } }, { memberId: { startsWith: PREFIX } }, { actorMemberId: { startsWith: PREFIX } }, { subjectMemberId: { startsWith: PREFIX } }] } });
    await prisma.bookingChangeRequest.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
    await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.manualRefundTask.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.memberCredit.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
    await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    // The merge parties of a case; the owner and officer outlive every case.
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: `${PREFIX}l` } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: `${PREFIX}l` } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: `${PREFIX}m` } } });
  }

  async function teardownFixtures() {
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  /** The duplicate (`l…`) and its survivor (`m…`); a booking officer when `officer`, a role a merge may remove. */
  async function mergePair(tag: string, officer: boolean) {
    const loser = `${PREFIX}loser-${tag}`;
    const master = `${PREFIX}master-${tag}`;
    await member(loser, officer ? { accessRoles: { create: { role: "ADMIN_BOOKINGS" } } } : {});
    await member(master);
    return { loser, master };
  }

  it("MUTATION: (a) a merge holding the booking and waiting for the officer's Member row makes that officer's approval wait at the booking row; the merge commits and the approval refuses cleanly", async () => {
    const { loser, master } = await mergePair("a-merge-first", true);
    await seed(loser, false);
    const figures = await checkFigures(loser);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await approvalArrivingWhileMergeWaitsOnTheMember(loser, runMerge, () => approveWith(loser, figures));
    expectFulfilled(merged);
    // The officer it would have named is gone: the approval's fresh role check refuses, writing nothing.
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "notAuthorized" } });
    expect(await requestState()).toEqual({ status: "REQUESTED", requestedByMemberId: OWNER_ID, reviewedByMemberId: null });
    expect(await bookingState()).toEqual({ memberId: OWNER_ID, createdById: master });
    expect(await guestCount()).toBe(1);
  });

  it("MUTATION: (a) an approval by the duplicate holding its claim makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("a-approval-first", true);
    await seed(loser, false);
    const figures = await checkFigures(loser);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await mergeArrivingWhileApprovalHoldsItsClaim(runMerge, () => approveWith(loser, figures));
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    // The merge carried the reviewer and the booking's maker to the survivor.
    expect(await requestState()).toEqual({ status: "APPROVED", requestedByMemberId: OWNER_ID, reviewedByMemberId: master });
    expect(await bookingState()).toEqual({ memberId: OWNER_ID, createdById: master });
    expect(await guestCount()).toBe(2);
  });

  it("(b) a merge holding the duplicate's booking and request makes the approval wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("b-merge-first", false);
    await seed(loser, true);
    const figures = await checkFigures(OFFICER_ID);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await approvalArrivingWhileMergeWaitsOnTheMember(loser, runMerge, () => approveWith(OFFICER_ID, figures));
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState()).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState()).toEqual({ memberId: master, createdById: master });
    expect(await guestCount()).toBe(2);
  });

  it("MUTATION: (b) an approval holding its claim on the duplicate's request makes the merge wait at the booking row; both commit", async () => {
    const { loser, master } = await mergePair("b-approval-first", false);
    await seed(loser, true);
    const figures = await checkFigures(OFFICER_ID);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await mergeArrivingWhileApprovalHoldsItsClaim(runMerge, () => approveWith(OFFICER_ID, figures));
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectFulfilled(merged);
    expect(await requestState()).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState()).toEqual({ memberId: master, createdById: master });
    expect(await guestCount()).toBe(2);
  });

  it("MUTATION: (b) an approval paused at its booking-row lock holds nothing the merge needs: the merge commits, then the approval executes on the survivor's request", async () => {
    const { loser, master } = await mergePair("b-at-the-lock", false);
    await seed(loser, true);
    const figures = await checkFigures(OFFICER_ID);
    const runMerge = await previewMerge(master, loser);
    const reached = gate();
    const release = gate();
    let approvalPid = 0;
    beforeBookingRow.bookingId = BOOKING_ID;
    beforeBookingRow.paused = async (pid) => {
      approvalPid = pid;
      reached.open();
      await release.opened;
    };
    const approving = approveWith(OFFICER_ID, figures);
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
    // Before #4845 the approval had claimed the request by here, so the merge waited on it while holding the booking.
    expect(first, "the merge waited on the approval before it took the booking row").toBe("settled");
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expect(await requestState()).toEqual({ status: "APPROVED", requestedByMemberId: master, reviewedByMemberId: OFFICER_ID });
    expect(await bookingState()).toEqual({ memberId: master, createdById: master });
  });
});

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

function approveWith(officer: string, expectedFigures: Figures) {
  return execute(officer, { expectedFigures });
}
