/**
 * #4855 against real PostgreSQL: an officer write by the merge's duplicate (the
 * loser, L) racing that merge, where merge never meets the writer at a booking
 * row. The #4840 rule ("booking row before Member key share") orders the booking
 * row against the first Member key share; it does not order several Member key
 * shares against each other, and it does not fence a write merge never reaches
 * through a booking row.
 *
 * Merge's participant statement (`lockMemberMergeHostingCoverageParticipants`)
 * is one sorted `Member … FOR UPDATE`: it holds the rows before the one it waits
 * on. Its actor-column moves (`applyMoves`) run before that statement and see
 * only committed rows.
 *
 * - (a) Locked-period change-request approval by L. The claim names L
 *   (`reviewedByMemberId`, a key share on L). The booking is the survivor's (M)
 *   and M sorts before L, so merge locks M and waits on L; the canonical
 *   `modifyBookingBatch` then credits M (`MemberCredit.memberId`, a key share
 *   on M) and waits on merge.
 * - (b) Held booking-request approval by L, who did not quote the hold. Its
 *   guest swap links a guest to M (a key share on M), then the booking update
 *   names L (`createdById`, a key share on L). L sorts before M, so merge locks
 *   L and waits on M. A parked key share on M holds merge there until the
 *   approval has its share on M and waits on L.
 * - (c) Locked-period change-request approval by L, with nothing merge locks
 *   but L. Merge's `BookingChangeRequest.reviewedBy` move skips the row (the
 *   committed reviewer is still null), merge waits on L, the approval commits,
 *   and the loser delete's `onDelete: SetNull` clears the reviewer.
 *
 * Before #4855, (a) and (b) deadlocked (`40P01`: merge died in (a), the
 * approval in (b)) and (c) cleared the reviewer. Now merge never waits for a
 * Member row while holding another (`lockMemberMergeHostingCoverageParticipants`)
 * and, once it holds them, refuses with a 409 if any row still names the
 * duplicate (`member-merge-residual-references.ts`). In each case the writer
 * commits, merge refuses cleanly, and what the writer recorded stays on the
 * duplicate, who is still there. Two more cases write a row naming the
 * duplicate in the same window through a `Cascade` relation (which the delete
 * used to drop silently) and a `Restrict` one (which used to fail the delete
 * with an unmapped FK error): merge refuses both with the same 409.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  arrivingWhilePaused, clearPauses, createRaceMember, isDeadlock, keyShareOnMember, previewMerge,
  writerArrivingWhileMergeIsParked,
} from "./support/member-merge-race";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The approvals open their transactions with no options: give them a budget the race, not the runner, decides. */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

/** A pause inside the change-request approval after its claim, at the canonical service (slot "afterClaim"). */
vi.mock("@/lib/booking-batch-modification-service", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/booking-batch-modification-service");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    modifyBookingBatch: async (...args: Parameters<typeof real.modifyBookingBatch>) => {
      await pauseIn("afterClaim", args[0].tx);
      return real.modifyBookingBatch(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4855-";
/** Merge parties: `x1-…` sorts before `x2-…` in merge's Member statement. */
const PARTY = `${PREFIX}x`;
const OWNER_ID = `${PREFIX}owner`;
const OFFICER_ID = `${PREFIX}officer`;
const CONTACT_ID = `${PREFIX}contact`;
const LODGE_ID = `${PREFIX}lodge`;
const SEASON_ID = `${PREFIX}season`;
const BOOKING_ID = `${PREFIX}booking`;
const KEPT_GUEST_ID = `${PREFIX}guest-kept`;
const LEAVING_GUEST_ID = `${PREFIX}guest-leaving`;
const PAYMENT_ID = `${PREFIX}payment`;
const CHANGE_REQUEST_ID = `${PREFIX}change-request`;
const HELD_LODGE_ID = `${PREFIX}held-lodge`;
const HELD_BOOKING_ID = `${PREFIX}held-booking`;
const HELD_GUEST_ID = `${PREFIX}held-guest`;
const BOOKING_REQUEST_ID = `${PREFIX}booking-request`;
const CHECK_IN = new Date("2026-06-10T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-11T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-12T00:00:00.000Z");
const HELD_CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const HELD_NIGHT_2 = new Date("2026-08-11T00:00:00.000Z");
const HELD_CHECK_OUT = new Date("2026-08-12T00:00:00.000Z");
const NIGHT_CENTS = 5_000;
const STORED_NIGHT_CENTS = 4_321;
const HELD_PRICE_CENTS = 9_000;

let prisma: PrismaClient;
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

function member(id: string, extra: Record<string, unknown> = {}) {
  return createRaceMember(prisma, id, { canLogin: true, ...extra });
}

/**
 * A COMPLETED two-night stay for two non-member guests, owned by `owner` and
 * made by them, at a lodge neither merge party has a guest row in, paid by
 * internet banking. One LOCKED_PERIOD request, made by the owner, removes one
 * guest; the approval settles the reduction as account credit to the owner.
 */
async function seedChangeRequest(owner: string) {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID, memberId: owner, createdById: owner, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      status: "COMPLETED", totalPriceCents: 4 * STORED_NIGHT_CENTS, finalPriceCents: 4 * STORED_NIGHT_CENTS,
    },
  });
  for (const [id, firstName] of [[KEPT_GUEST_ID, "Kept"], [LEAVING_GUEST_ID, "Leaving"]] as const) {
    await prisma.bookingGuest.create({
      data: {
        id, bookingId: BOOKING_ID, firstName, lastName: "Guest", ageTier: "ADULT", isMember: false,
        stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: 2 * STORED_NIGHT_CENTS,
        nights: { create: [
          { stayDate: CHECK_IN, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
          { stayDate: NIGHT_2, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" },
        ] },
      },
    });
  }
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 4 * STORED_NIGHT_CENTS, source: "INTERNET_BANKING", reference: "RACE4855",
      status: "SUCCEEDED", xeroInvoiceId: `${PREFIX}xero-invoice`, xeroInvoiceNumber: "INV-4855",
      // The captured charge a credit is allocated against.
      transactions: { create: { kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 4 * STORED_NIGHT_CENTS, status: "SUCCEEDED", xeroInvoiceId: `${PREFIX}xero-invoice` } },
    },
  });
  await prisma.bookingChangeRequest.create({
    data: {
      id: CHANGE_REQUEST_ID, bookingId: BOOKING_ID, requestedByMemberId: owner, kind: "LOCKED_PERIOD", status: "REQUESTED",
      reason: "My friend could not come after all.",
      requestedChanges: {
        original: { checkIn: "2026-06-10", checkOut: "2026-06-12", guests: [{ id: KEPT_GUEST_ID }, { id: LEAVING_GUEST_ID }] },
        requested: {
          checkIn: null, checkOut: null, addGuests: [], removeGuests: [{ id: LEAVING_GUEST_ID }],
          guestStayRanges: [], requestedEffectiveDate: null, summary: "remove Leaving Guest",
        },
      },
    },
  });
}

type Figures = { additionalAmountCents: number; refundAmountCents: number; accountCreditAmountCents: number };

async function executeChangeRequest(officer: string, mode: { dryRun: true } | { expectedFigures: Figures }) {
  const executor = await import("@/lib/booking-change-request-execution");
  const batchService = await import("@/lib/booking-batch-modification-service");
  const clubTimeServer = await import("@/lib/club-time/server");
  return executor.approveAndExecuteLockedPeriodChangeRequest({
    ...mode,
    requestId: CHANGE_REQUEST_ID, expectedVersion: 1, actorMemberId: officer,
    adminNotes: "Removed your friend from the stay.", internalNotes: null, confirmOverCapacity: false,
    settlementMethod: "credit",
    todayAtClub: (await clubTimeServer.clubTime()).today(), format: CLUB_FORMAT_TEST,
    preTransaction: await batchService.prepareBatchModificationForCallerTransaction({ audience: "admin" }),
    ipAddress: "127.0.0.1",
  });
}

/** The officer's check of the figures (a dry run that rolls back), read before a race is set up. */
async function checkFigures(officer: string): Promise<Figures> {
  const quoted = await executeChangeRequest(officer, { dryRun: true });
  if (quoted.outcome !== "quoted") throw new Error(`expected a quote, got ${JSON.stringify(quoted)}`);
  const figures = { additionalAmountCents: quoted.additionalAmountCents, refundAmountCents: quoted.refundAmountCents, accountCreditAmountCents: quoted.accountCreditAmountCents };
  // The case needs the approval to credit the owner: that write is its second Member key share.
  expect(figures.accountCreditAmountCents).toBeGreaterThan(0);
  return figures;
}

/**
 * A PRICED general request with an AWAITING_REVIEW hold another officer quoted
 * (`createdById`), owned by a non-login contact, at a lodge neither merge party
 * has a guest row in. Its one guest is unlinked; the request links it to the
 * survivor, so the approval's in-place swap writes the survivor's id onto it.
 */
async function seedBookingRequest(master: string) {
  await prisma.booking.create({
    data: {
      id: HELD_BOOKING_ID, memberId: CONTACT_ID, createdById: OFFICER_ID, lodgeId: HELD_LODGE_ID,
      checkIn: HELD_CHECK_IN, checkOut: HELD_CHECK_OUT,
      status: "AWAITING_REVIEW", totalPriceCents: HELD_PRICE_CENTS, finalPriceCents: HELD_PRICE_CENTS, hasNonMembers: true,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: HELD_GUEST_ID, bookingId: HELD_BOOKING_ID, firstName: "Linked", lastName: "Friend", ageTier: "ADULT", isMember: false,
      stayStart: HELD_CHECK_IN, stayEnd: HELD_CHECK_OUT, priceCents: HELD_PRICE_CENTS,
      nights: { create: [
        { stayDate: HELD_CHECK_IN, priceCents: HELD_PRICE_CENTS / 2, priceSource: "SOLD" },
        { stayDate: HELD_NIGHT_2, priceCents: HELD_PRICE_CENTS / 2, priceSource: "SOLD" },
      ] },
    },
  });
  await prisma.bookingRequest.create({
    data: {
      id: BOOKING_REQUEST_ID, type: "GENERAL", status: "PRICED", lodgeId: HELD_LODGE_ID, version: 1,
      contactFirstName: "Request", contactLastName: "Contact", contactEmail: `${CONTACT_ID}@example.invalid`,
      checkIn: HELD_CHECK_IN, checkOut: HELD_CHECK_OUT, priceCents: HELD_PRICE_CENTS, pricedByMemberId: OFFICER_ID,
      guests: [{ firstName: "Linked", lastName: "Friend", ageTier: "ADULT" }],
      linkedGuestMembers: [{ guestIndex: 0, memberId: master }],
      heldBookingId: HELD_BOOKING_ID,
    },
  });
}

async function approveBookingRequestAs(officer: string) {
  const { approveBookingRequest } = await import("@/lib/booking-request");
  return approveBookingRequest({ requestId: BOOKING_REQUEST_ID, adminMemberId: officer });
}

async function changeRequestReviewer() {
  return (await prisma.bookingChangeRequest.findUniqueOrThrow({ where: { id: CHANGE_REQUEST_ID }, select: { reviewedByMemberId: true } })).reviewedByMemberId;
}

/** Neither side of the race died on a deadlock: PostgreSQL never had to break a wait-for cycle. */
function expectNoDeadlock(...outcomes: PromiseSettledResult<unknown>[]) {
  for (const outcome of outcomes) {
    const reason = outcome.status === "rejected" ? outcome.reason : null;
    expect(isDeadlock(reason), String(reason)).toBe(false);
  }
}

(RUN ? describe : describe.skip)("an officer write by the merge's duplicate racing that merge (#4855)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4855 merge loser-officer race");
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
    await member(CONTACT_ID, { role: "NON_MEMBER", canLogin: false });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4855 Lodge", slug: "race-4855" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80 } });
    await prisma.lodge.create({ data: { id: HELD_LODGE_ID, name: "Race 4855 Held Lodge", slug: "race-4855-held" } });
    await prisma.lodgeSettings.create({ data: { id: HELD_LODGE_ID, lodgeId: HELD_LODGE_ID, capacity: 10 } });
    const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    await prisma.season.create({
      data: {
        id: SEASON_ID, name: "Race 4855 winter", type: "WINTER", startDate: new Date("2026-06-01T00:00:00.000Z"), endDate: new Date("2026-06-30T00:00:00.000Z"),
        active: true, lodgeId: LODGE_ID,
        membershipTypeRates: { create: [
          { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: NIGHT_CENTS },
          { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
        ] },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    clearPauses();
    await clean();
  });

  afterAll(async () => {
    try {
      if (!prisma) return;
      clearPauses();
      await clean();
      await teardownFixtures();
    } finally {
      restoreXeroQueue?.();
    }
  }, 120_000);

  async function clean() {
    while (pendingXeroWork.length > 0) await Promise.allSettled(pendingXeroWork.splice(0));
    const bookingIds = [BOOKING_ID, HELD_BOOKING_ID];
    const payments = (await prisma.payment.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } })).map((row) => row.id);
    const modifications = (await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } })).map((row) => row.id);
    await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "BookingModification", localId: { in: modifications } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [...bookingIds, CHANGE_REQUEST_ID, BOOKING_REQUEST_ID] } }, { memberId: { startsWith: PREFIX } }, { actorMemberId: { startsWith: PREFIX } }, { subjectMemberId: { startsWith: PREFIX } }] } });
    await prisma.bookingChangeRequest.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.paymentLink.deleteMany({ where: { bookingRequestId: BOOKING_REQUEST_ID } });
    await prisma.bookingRequest.deleteMany({ where: { id: BOOKING_REQUEST_ID } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await releaseBookingJournalForTeardown(prisma, bookingIds);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.manualRefundTask.deleteMany({ where: { paymentId: { in: payments } } });
    await prisma.memberCredit.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.issueReport.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...bookingIds, ...payments] } } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payments } } });
    await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: bookingIds } } } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    // The merge parties of a case; the owner, officer and contact outlive every case.
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: PARTY } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: PARTY } } });
  }

  async function teardownFixtures() {
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: { in: [LODGE_ID, HELD_LODGE_ID] } } });
    await prisma.lodge.deleteMany({ where: { id: { in: [LODGE_ID, HELD_LODGE_ID] } } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: PREFIX } } });
    await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  /**
   * The duplicate (a booking officer, a role a merge may remove) and its
   * survivor. `masterFirst` puts the survivor first in merge's sorted Member
   * statement; otherwise the duplicate is first.
   */
  async function mergePair(tag: string, masterFirst: boolean) {
    const master = `${PARTY}${masterFirst ? 1 : 2}-master-${tag}`;
    const loser = `${PARTY}${masterFirst ? 2 : 1}-loser-${tag}`;
    await member(loser, { accessRoles: { create: { role: "ADMIN_BOOKINGS" } } });
    await member(master);
    return { loser, master };
  }

  /** Merge refused with its clean 409 because, under its Member rows, `driftField` still named the duplicate. */
  function expectRefusedForResidual(merged: PromiseSettledResult<unknown>, driftField: string) {
    expect(merged).toMatchObject({ status: "rejected", reason: { statusCode: 409, code: "merge_drift_in_transaction" } });
    const details = (merged as PromiseRejectedResult).reason.details as { driftFields: string[] };
    expect(details.driftFields).toContain(driftField);
  }

  async function stillThere(memberId: string) {
    return (await prisma.member.count({ where: { id: memberId } })) === 1;
  }

  it("(a) a change-request approval by the duplicate, crediting the survivor, never deadlocks with the merge: the approval commits and the merge refuses, keeping the reviewer", async () => {
    const { loser, master } = await mergePair("a", true);
    await seedChangeRequest(master);
    const figures = await checkFigures(loser);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    // The merge waits on the officer's row ALONE, holding the survivor's no more, so the credit goes through.
    const { held: approved, arrived: merged } = await arrivingWhilePaused(
      prisma, "afterClaim", () => executeChangeRequest(loser, { expectedFigures: figures }), runMerge,
    );
    expectNoDeadlock(approved, merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    expectRefusedForResidual(merged, "BookingChangeRequest.reviewedBy");
    expect(await changeRequestReviewer()).toBe(loser);
    expect(await stillThere(loser)).toBe(true);
    expect(await prisma.memberCredit.count({ where: { memberId: master, sourceBookingId: BOOKING_ID } })).toBe(1);
  });

  it("(b) a held booking-request approval by the duplicate, linking a guest to the survivor, never deadlocks with the merge: the approval commits and the merge refuses", async () => {
    const { loser, master } = await mergePair("b", false);
    await seedBookingRequest(master);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { merged, written: approved, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(master), runMerge, () => approveBookingRequestAs(loser), { writer: "queuesOrFinishes" },
    );
    expectNoDeadlock(approved, merged);
    // Before #4855 the approval queued behind the merge's hold on the officer's row and died there (40P01).
    expect(writerFirst, "the approval waited on the merge").toBe("settled");
    expect(approved).toMatchObject({ status: "fulfilled", value: { type: "approved", bookingId: HELD_BOOKING_ID } });
    // The survivor's new guest row is at a lodge the merge never locked and the hold now names the duplicate:
    // either refuses the whole merge with a clean 409, nothing moved.
    expect(merged).toMatchObject({ status: "rejected", reason: { statusCode: 409 } });
    expect(["merge_drift_in_transaction", "partner_share_lodge_drift"]).toContain((merged as PromiseRejectedResult).reason.code);
    const held = await prisma.booking.findUniqueOrThrow({ where: { id: HELD_BOOKING_ID }, select: { status: true, createdById: true, guests: { select: { memberId: true } } } });
    expect(held).toEqual({ status: "PENDING", createdById: loser, guests: [{ memberId: master }] });
    expect(await stillThere(loser)).toBe(true);
  });

  it("(c) a change-request approval by the duplicate that merge waits on keeps its reviewer: the approval commits and the merge refuses", async () => {
    const { loser, master } = await mergePair("c", false);
    await seedChangeRequest(OWNER_ID);
    const figures = await checkFigures(loser);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    const { held: approved, arrived: merged } = await arrivingWhilePaused(
      prisma, "afterClaim", () => executeChangeRequest(loser, { expectedFigures: figures }), runMerge,
    );
    expectNoDeadlock(approved, merged);
    expect(approved).toMatchObject({ status: "fulfilled", value: { outcome: "executed" } });
    // Before #4855 the merge's reviewer move skipped the uncommitted claim, both committed, and the loser
    // delete's SetNull cleared the reviewer.
    expect(await changeRequestReviewer(), "the approval's reviewer was cleared").toBe(loser);
    expectRefusedForResidual(merged, "BookingChangeRequest.reviewedBy");
    expect(await stillThere(loser)).toBe(true);
  });

  /** A row naming the duplicate, written by another session while the merge runs and committed once the merge waits on it. */
  async function mergeWithLateRow(tag: string, write: (tx: Prisma.TransactionClient, loser: string) => Promise<unknown>) {
    const { loser, master } = await mergePair(tag, false);
    const runMerge = await previewMerge(master, loser, OFFICER_ID);
    // The row's FK write holds a key share on the duplicate, so the merge's moves skip it and the merge parks on it.
    const { merged } = await writerArrivingWhileMergeIsParked(
      prisma, (tx) => write(tx, loser), runMerge, () => Promise.resolve(), { writer: "queuesOrFinishes" },
    );
    return { loser, merged };
  }

  it("refuses a merge, rather than dropping it, when a Cascade row naming the duplicate commits under it", async () => {
    const { loser, merged } = await mergeWithLateRow("cascade", (tx, id) =>
      tx.issueReport.create({ data: { memberId: id, pageUrl: "https://example.invalid/race-4855", description: "Race 4855 late report" } }));
    // Before #4855 the merge committed and the loser delete cascaded the report away.
    expectRefusedForResidual(merged, "IssueReport.member");
    expect(await prisma.issueReport.count({ where: { memberId: loser } })).toBe(1);
  });

  it("refuses a merge with its clean 409, not an FK error, when a Restrict row naming the duplicate commits under it", async () => {
    const { loser, merged } = await mergeWithLateRow("restrict", (tx, id) =>
      tx.memberCredit.create({ data: { memberId: id, amountCents: 1_000, type: "ADMIN_ADJUSTMENT", description: "Race 4855 late credit" } }));
    // Before #4855 the loser delete failed on the FK (P2003) and the operator saw a 500.
    expectRefusedForResidual(merged, "MemberCredit.member");
    expect(await prisma.memberCredit.count({ where: { memberId: loser } })).toBe(1);
  });
});
