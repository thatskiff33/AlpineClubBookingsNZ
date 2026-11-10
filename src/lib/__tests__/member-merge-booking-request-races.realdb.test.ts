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
 * session's key share on the duplicate (whose id sorts before the survivor's).
 * Since #4876 that wait holds none of the rows merge re-points, so the approval
 * does not queue behind a booking row. The approval-first cases pause the
 * approval after its claim, at `buildApprovalGuestCreates`, or just before its
 * booking-row lock. The choreography and its waits, each matched to the
 * backend it waits on (`pg_blocking_pids`), are shared with the other merge
 * race suites (`support/member-merge-race.ts`).
 *
 * Member hard-delete (#4850) is the other booking-row-then-Member writer; it is
 * raced in `member-delete-officer-races.realdb.test.ts`, not here.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  beforeBookingRow, clearPauses, createRaceMember, expectFulfilled, firstStandWhilePaused, keyShareOnMember, previewMerge,
  writerArrivingWhileMergeIsParked,
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

/** A pause inside the approval after its claim, before its guest swap (slot "afterClaim"): a pass-through unless a case arms it. */
vi.mock("@/lib/booking-request-shared", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-request-shared");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    buildApprovalGuestCreates: async (...args: Parameters<typeof real.buildApprovalGuestCreates>) => {
      await pauseIn("afterClaim", args[0]);
      return real.buildApprovalGuestCreates(...args);
    },
  };
});

/** A pause just before the approval takes the booking-row lock (slot `beforeBookingRow(id)`). */
vi.mock("@/lib/booking-row-lock", async (importOriginal) =>
  (await import("./support/member-merge-race")).bookingRowLockDouble(await importOriginal()),
);

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

function member(id: string, extra: Record<string, unknown> = {}) {
  return createRaceMember(prisma, id, { canLogin: true, ...extra });
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

async function requestState() {
  return prisma.bookingRequest.findUniqueOrThrow({ where: { id: REQUEST_ID }, select: { status: true, reviewedByMemberId: true, convertedBookingId: true } });
}

async function bookingState() {
  return prisma.booking.findUniqueOrThrow({
    where: { id: BOOKING_ID },
    select: { status: true, memberId: true, createdById: true, guests: { select: { memberId: true } } },
  });
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
    clearPauses();
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    clearPauses();
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

  it("MUTATION: a merge waiting for the Member rows holds no booking row, so the approval commits without waiting on one", async () => {
    const { loser, master } = await mergePair("merge-first");
    await seed(loser, master);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { merged, written: approved, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(loser), runMerge, approve, { writer: "queuesOrFinishes" },
    );
    // Before #4857 the approval had linked the survivor and waited on the booking while merge
    // waited on the survivor. Since #4876 merge does not hold the booking through the wait.
    expect(writerFirst, "the approval waited on the merge").toBe("settled");
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: BOOKING_ID } });
    expect(await requestState()).toMatchObject({ reviewedByMemberId: OFFICER_ID, convertedBookingId: BOOKING_ID });
    expect(await bookingState()).toEqual({ status: "PENDING", memberId: CONTACT_ID, createdById: OFFICER_ID, guests: [{ memberId: master }] });
  });

  it("MUTATION: an approval holding its claim makes the merge wait at the held booking's row; the approval commits and the merge refuses cleanly", async () => {
    const { loser, master } = await mergePair("approval-first");
    await seed(loser, master);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { first, held: approved, arrived: merged } = await firstStandWhilePaused(
      prisma, "afterClaim", approve, runMerge, { label: "the merge", neverPaused: "the approval never reached its guest swap" },
    );
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
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    // Taken before the claim, the lock is where this approval stops; one that never takes it cannot be paused there.
    const { first, held: approved, arrived: merged } = await firstStandWhilePaused(
      prisma, beforeBookingRow(BOOKING_ID), approve, runMerge,
      { label: "the merge", neverPaused: "the approval never took the booking-row lock" },
    );
    expect(first, "the merge waited on the approval before it took the booking row").toBe("settled");
    expectFulfilled(merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: BOOKING_ID } });
    expect(await bookingState()).toEqual({ status: "PENDING", memberId: CONTACT_ID, createdById: OFFICER_ID, guests: [{ memberId: master }] });
  });
});
