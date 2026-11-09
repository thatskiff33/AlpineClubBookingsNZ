/**
 * #4857 against real PostgreSQL: an officer approving a held booking request
 * (`approveBookingRequest`) racing a member merge, in both orders.
 *
 * The approval takes `lock(1)` and the held booking's lodge key, claims the
 * request, swaps the held party in place and only then updates the held
 * booking. The swap writes each guest's member link, so a guest newly linked to
 * a member takes `FOR KEY SHARE` on that Member row. Member merge takes no
 * `lock(1)`. It holds booking rows from its relation moves on (here
 * `Booking.createdById`: the duplicate is the officer who quoted the hold), then
 * takes its sorted `Member … FOR UPDATE`. With the held booking at a lodge
 * outside merge's lodge prefix, and a guest newly linked to the survivor, the
 * approval held the survivor's key share and waited on the booking while merge
 * held the booking and waited on the survivor's row: PostgreSQL aborted one
 * side (`40P01`). The approval now takes the held booking's row right after its
 * lodge key, before its claim: booking row, then Member rows, as merge orders
 * them.
 *
 * The merge-first case parks merge at its `Member … FOR UPDATE` behind another
 * session's key share on the duplicate (whose id sorts before the survivor's),
 * so merge holds the booking while it waits. The approval-first cases pause the
 * approval after its claim, at `buildApprovalGuestCreates`, or just before its
 * booking-row lock. Every wait is matched to the backend it waits on
 * (`pg_blocking_pids`).
 *
 * Member hard-delete (#4850, PR #4856) is the other booking-row-then-Member
 * writer; it is not on main yet, so it is not raced here.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
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

/** A pause inside the approval after its claim, before its guest swap, handed the transaction's backend id. */
const pause = vi.hoisted(() => ({ afterClaim: null as null | ((pid: number) => Promise<void>) }));
vi.mock("@/lib/booking-request-shared", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-request-shared");
  return {
    ...real,
    buildApprovalGuestCreates: async (...args: Parameters<typeof real.buildApprovalGuestCreates>) => {
      const hook = pause.afterClaim;
      if (hook) {
        pause.afterClaim = null;
        await hook(await backendPid(args[0]));
      }
      return real.buildApprovalGuestCreates(...args);
    },
  };
});

/** A pause just before the approval takes the booking-row lock, handed the transaction's backend id. */
const beforeBookingRow = vi.hoisted(() => ({ bookingId: null as null | string, paused: null as null | ((pid: number) => Promise<void>) }));
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
const PREFIX = "race-4857-";
const CONTACT_ID = `${PREFIX}contact`;
const OFFICER_ID = `${PREFIX}officer`;
const LODGE_ID = `${PREFIX}lodge`;
const BOOKING_ID = `${PREFIX}booking`;
const GUEST_ID = `${PREFIX}guest`;
const REQUEST_ID = `${PREFIX}request`;
const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-08-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-12T00:00:00.000Z");
const PRICE_CENTS = 9_000;

let prisma: PrismaClient;

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
 * A PRICED general request with an AWAITING_REVIEW hold the duplicate quoted
 * (`createdById`), owned by a non-login contact, at a lodge neither merge party
 * has a guest row in. The hold's one guest is unlinked; the officer has since
 * linked that guest to the survivor, so the approval's in-place swap writes the
 * survivor's id onto the guest row.
 */
async function seed(loser: string, master: string) {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID, memberId: CONTACT_ID, createdById: loser, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      status: "AWAITING_REVIEW", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS, hasNonMembers: true,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Linked", lastName: "Friend", ageTier: "ADULT", isMember: false,
      stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS,
      nights: { create: [
        { stayDate: CHECK_IN, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" },
        { stayDate: NIGHT_2, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" },
      ] },
    },
  });
  await prisma.bookingRequest.create({
    data: {
      id: REQUEST_ID, type: "GENERAL", status: "PRICED", lodgeId: LODGE_ID, version: 1,
      contactFirstName: "Request", contactLastName: "Contact", contactEmail: `${CONTACT_ID}@example.invalid`,
      checkIn: CHECK_IN, checkOut: CHECK_OUT, priceCents: PRICE_CENTS, pricedByMemberId: loser,
      guests: [{ firstName: "Linked", lastName: "Friend", ageTier: "ADULT" }],
      linkedGuestMembers: [{ guestIndex: 0, memberId: master }],
      heldBookingId: BOOKING_ID,
    },
  });
}

async function approve() {
  const { approveBookingRequest } = await import("@/lib/booking-request");
  return approveBookingRequest({ requestId: REQUEST_ID, adminMemberId: OFFICER_ID });
}

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: OFFICER_ID, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
}

async function requestState() {
  return prisma.bookingRequest.findUniqueOrThrow({ where: { id: REQUEST_ID }, select: { status: true, reviewedByMemberId: true, convertedBookingId: true } });
}

async function bookingState() {
  return prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { status: true, memberId: true, createdById: true, guests: { select: { memberId: true } } },
  });
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

(RUN ? describe : describe.skip)("approving a held booking request racing a member merge (#4857)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4857 merge booking-request race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await clean();
    await teardownFixtures();
    await member(CONTACT_ID, { role: "NON_MEMBER", canLogin: false });
    await member(OFFICER_ID, { role: "ADMIN", accessRoles: { create: { role: "ADMIN" } } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4857 Lodge", slug: "race-4857" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
  }, 120_000);

  beforeEach(async () => {
    pause.afterClaim = null;
    beforeBookingRow.paused = null;
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    pause.afterClaim = null;
    beforeBookingRow.paused = null;
    await clean();
    await teardownFixtures();
  }, 120_000);

  async function clean() {
    const payments = (await prisma.payment.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } })).map((row) => row.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [BOOKING_ID, REQUEST_ID] } }, { memberId: { startsWith: PREFIX } }, { actorMemberId: { startsWith: PREFIX } }, { subjectMemberId: { startsWith: PREFIX } }] } });
    await prisma.paymentLink.deleteMany({ where: { bookingRequestId: REQUEST_ID } });
    await prisma.bookingRequest.deleteMany({ where: { id: REQUEST_ID } });
    await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, ...payments] } } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payments } } });
    await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    // The merge parties of a case; the contact and officer outlive every case.
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: `${PREFIX}l` } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: `${PREFIX}l` } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: `${PREFIX}m` } } });
  }

  async function teardownFixtures() {
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  /** The duplicate (`l…`, an officer who quoted the hold) and its survivor (`m…`); `l` sorts first in merge's Member set. */
  async function mergePair(tag: string) {
    const loser = `${PREFIX}loser-${tag}`;
    const master = `${PREFIX}master-${tag}`;
    await member(loser, { accessRoles: { create: { role: "ADMIN_BOOKINGS" } } });
    await member(master);
    return { loser, master };
  }

  it("MUTATION: a merge holding the held booking and waiting for the Member rows makes the approval wait at the booking row before it links the survivor; both commit", async () => {
    const { loser, master } = await mergePair("merge-first");
    await seed(loser, master);
    const runMerge = await previewMerge(master, loser);
    const { merged, approved } = await approvalArrivingWhileMergeWaitsOnTheMember(loser, runMerge, approve);
    // Before #4857 the approval had linked the survivor (a key share) by here, so the merge's
    // `Member … FOR UPDATE` waited on it while it waited on the booking: one side died with 40P01.
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: BOOKING_ID } });
    expect(await requestState()).toMatchObject({ reviewedByMemberId: OFFICER_ID, convertedBookingId: BOOKING_ID });
    expect(await bookingState()).toEqual({ status: "PENDING", memberId: CONTACT_ID, createdById: OFFICER_ID, guests: [{ memberId: master }] });
  });

  it("MUTATION: an approval holding its claim makes the merge wait at the held booking's row; the approval commits and the merge refuses cleanly", async () => {
    const { loser, master } = await mergePair("approval-first");
    await seed(loser, master);
    const runMerge = await previewMerge(master, loser);
    const reached = gate();
    const release = gate();
    let approvalPid = 0;
    pause.afterClaim = async (pid) => {
      approvalPid = pid;
      reached.open();
      await release.opened;
    };
    const approving = approve();
    let merging: Promise<unknown> = Promise.resolve();
    let first: "settled" | "waiting" = "settled";
    try {
      await Promise.race([reached.opened, approving.then(() => { throw new Error("the approval never reached its guest swap"); })]);
      merging = runMerge();
      first = await settledOrBlockedBy(merging, approvalPid);
    } finally {
      release.open();
    }
    const [approved, merged] = await Promise.allSettled([approving, merging]);
    // Before #4857 the approval held only its request row here, which merge never touches, so the
    // merge ran to completion past it; now it holds the booking row and the merge waits on it.
    expect(first, "the merge never waited on the approval's booking row").toBe("waiting");
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: BOOKING_ID } });
    expect(await requestState()).toMatchObject({ reviewedByMemberId: OFFICER_ID, convertedBookingId: BOOKING_ID });
    // The approval committed the survivor's guest row at a lodge merge's prefix never locked, so the
    // merge's re-derivation under its Member rows refuses the whole merge (#2672): a clean 409, nothing moved.
    expect(merged).toMatchObject({ status: "rejected", reason: { statusCode: 409, code: "partner_share_lodge_drift" } });
    expect(await bookingState()).toEqual({ status: "PENDING", memberId: CONTACT_ID, createdById: OFFICER_ID, guests: [{ memberId: master }] });
    expect(await prisma.member.count({ where: { id: { in: [loser, master] } } })).toBe(2);
  });

  it("MUTATION: an approval paused at its booking-row lock holds nothing the merge needs: the merge commits, then the approval converts the hold", async () => {
    const { loser, master } = await mergePair("at-the-lock");
    await seed(loser, master);
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
    const approving = approve();
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
    expect(first, "the merge waited on the approval before it took the booking row").toBe("settled");
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: BOOKING_ID } });
    expect(await bookingState()).toEqual({ status: "PENDING", memberId: CONTACT_ID, createdById: OFFICER_ID, guests: [{ memberId: master }] });
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
