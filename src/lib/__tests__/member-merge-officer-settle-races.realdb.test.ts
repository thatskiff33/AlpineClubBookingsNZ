/**
 * #4840 against real PostgreSQL: an officer's write racing a member merge that
 * removes that officer's duplicate record, in both orders, for the two writers
 * that named the officer before taking the booking row.
 *
 * - A manual settle names its officer on the Payment row
 *   (`manuallyMarkedPaidByMemberId`) before its PAID claim.
 * - An edit review's closure names its officer in its claim
 *   (`completedByMemberId`), and used to take the booking row only after it.
 *
 * Each FK write takes `FOR KEY SHARE` on the officer's Member row. Member merge
 * takes no `lock(1)`. It holds the booking row from its relation moves on, then
 * takes `Member … FOR UPDATE` on the duplicate. With the booking at a lodge
 * outside merge's lodge prefix, a writer holding the key share and waiting for
 * the booking row deadlocked against it. Both writers now take the booking row
 * first: booking row, then Member, the order merge and the other booking
 * writers use.
 *
 * The fixture is a booking the duplicate made on a member's behalf
 * (`Booking.createdById`), at a lodge neither merge party has a guest row in.
 * The settle's booking is unpaid cash; the closure's booking was paid in cash by
 * another officer and carries an open edit review.
 *
 * The merge-first cases park merge at its `Member … FOR UPDATE` with a third
 * session holding `FOR KEY SHARE` on the duplicate's row. Since #4876 that wait
 * holds none of the rows merge re-points, so the writer does not queue behind
 * a booking row: it commits. The settle's attribution is moved under the Member
 * rows (#4823), so the merge carries it. The closure's officer was not in the
 * preview's move set, so the residual check refuses (#4855) and the task keeps
 * naming the duplicate, who is still there. The choreography and its waits are
 * shared (`support/member-merge-race.ts`).
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, parkHistoryStrand, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, keyShareOnMember, previewMerge,
  writerArrivingWhileMergeIsParked,
} from "./support/member-merge-race";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The writers open their transactions with no options: give them a budget the race, not the runner, decides. */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

/** Pauses inside a writer's transaction after its claim (slots "settle" and "closure"): pass-throughs unless a case arms one. */
vi.mock("@/lib/member-money/doors", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/member-money/doors");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    postBookingReceipts: async (...args: Parameters<typeof real.postBookingReceipts>) => {
      await pauseIn("settle", args[0]);
      return real.postBookingReceipts(...args);
    },
  };
});
vi.mock("@/lib/manual-refund-task-audit", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/manual-refund-task-audit");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    recordManualRefundTaskClosureAudit: async (...args: Parameters<typeof real.recordManualRefundTaskClosureAudit>) => {
      await pauseIn("closure", args[0].store);
      return real.recordManualRefundTaskClosureAudit(...args);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4840-merge-officer-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

/** A cash booking the duplicate made for the history member, still unpaid. */
async function bookingMadeByDuplicate(tag: string) {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await createRaceMember(prisma, loser);
  await createRaceMember(prisma, master);
  const id = `${PREFIX}b-${tag}`;
  await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source: "INTERNET_BANKING" } });
  await prisma.booking.update({ where: { id }, data: { createdById: loser } });
  return { id, paymentId: `${id}-payment`, loser, master };
}

/** The same booking, paid in cash by another officer, with an edit review open on its second guest. */
async function reviewOnBookingMadeByDuplicate(tag: string) {
  const made = await bookingMadeByDuplicate(tag);
  await markPaid(made.id, names.officerId);
  const guestId = `${made.id}-g2`;
  const taskId = await parkHistoryStrand(prisma, names, made.id, guestId);
  // The officer priced the strand's nights, so the closure has nothing left to ask for.
  for (const [stayDate, priceCents] of [["2027-08-01", 5_000], ["2027-08-02", 2_000]] as const) {
    await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: guestId, stayDate: new Date(`${stayDate}T00:00:00.000Z`) }, data: { priceCents, priceSource: "OFFICER_PRICED" } });
  }
  await prisma.bookingGuest.update({ where: { id: guestId }, data: { priceCents: 7_000 } });
  return { ...made, taskId };
}

/** The officer records the cash, as the mark-paid route does. */
async function markPaid(bookingId: string, officer: string) {
  const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
  return markBookingPaymentManuallySettled({ bookingId, actingAdminMemberId: officer, note: "cash at the lodge", expectedAmountCents: PRICE, notifyMember: false, format: CLUB_FORMAT_TEST });
}

/** The officer closes the review, as the refund-task route does. */
async function dismissReview(taskId: string, officer: string) {
  const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
  return resolveManualRefundTask({ taskId, resolution: "dismissed", note: "Settled with the member another way.", actingMemberId: officer, recordedNightPrices: null }, CLUB_FORMAT_TEST);
}

async function state(id: string, paymentId: string) {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true, createdById: true } });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, manuallyMarkedPaidByMemberId: true } });
  return { ...booking, paymentStatus: payment.status, markedPaidBy: payment.manuallyMarkedPaidByMemberId };
}

async function taskState(taskId: string) {
  return prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, completedByMemberId: true } });
}

/** The closure committed an officer the preview never counted. Merge refuses; the duplicate stays. */
function expectClosureKept(merged: PromiseSettledResult<unknown>) {
  expect(merged).toMatchObject({ status: "rejected", reason: { statusCode: 409, code: "merge_drift_in_transaction" } });
  const details = (merged as PromiseRejectedResult).reason.details as { driftFields: string[] };
  expect(details.driftFields).toContain("ManualRefundTask.completedBy");
}

(RUN ? describe : describe.skip)("an officer's write racing a merge of that officer's duplicate (#4840)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4840 merge officer settle race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await createRaceMember(prisma, ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
  }, 120_000);

  afterAll(async () => {
    clearPauses();
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  it("MUTATION: a merge waiting for the duplicate's Member row holds no booking row, so the settle commits and the merge carries it to the survivor", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("merge-first");
    const execute = await previewMerge(master, loser, ADMIN);
    // The duplicate, still signed in as an officer, records the cash while merge waits holding nothing it needs.
    const { merged, written, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(loser), execute, () => markPaid(id, loser), { writer: "queuesOrFinishes" },
    );
    // Holding the booking through that wait would make the settle queue here, the cycle #4840 closed and #4876 must not reopen.
    expect(writerFirst, "the settle waited on the merge").toBe("settled");
    expectFulfilled(written);
    expectFulfilled(merged);
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });

  it("a settle holding the booking row and the officer's key share makes the merge wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("settle-first");
    const execute = await previewMerge(master, loser, ADMIN);
    const { held: written, arrived: merged } = await arrivingWhilePaused(prisma, "settle", () => markPaid(id, loser), execute);
    expect(written).toMatchObject({ status: "fulfilled", value: { bookingId: id, paymentId } });
    expectFulfilled(merged);
    // The merge carried the booking's actor and the settle's attribution to the survivor.
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });

  it("MUTATION: a merge waiting for the duplicate's Member row holds no booking row, so the review closure commits and the merge refuses, keeping the officer", async () => {
    const { id, taskId, loser, master } = await reviewOnBookingMadeByDuplicate("merge-before-closure");
    const execute = await previewMerge(master, loser, ADMIN);
    const { merged, written, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma, keyShareOnMember(loser), execute, () => dismissReview(taskId, loser), { writer: "queuesOrFinishes" },
    );
    expect(writerFirst, "the closure waited on the merge").toBe("settled");
    expectFulfilled(written);
    expectClosureKept(merged);
    expect(await taskState(taskId)).toEqual({ status: "DISMISSED", completedByMemberId: loser });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBe(loser);
    expect(await prisma.member.count({ where: { id: loser } })).toBe(1);
  });

  it("an edit review's closure holding the booking row and the officer's key share commits, and the merge refuses, keeping the officer", async () => {
    const { id, taskId, loser, master } = await reviewOnBookingMadeByDuplicate("closure-first");
    const execute = await previewMerge(master, loser, ADMIN);
    const { held: written, arrived: merged } = await arrivingWhilePaused(prisma, "closure", () => dismissReview(taskId, loser), execute);
    expectFulfilled(written);
    expectClosureKept(merged);
    // The officer was not in the preview's move set. Moving them after the Member rows is the order #4840 forbids.
    expect(await taskState(taskId)).toEqual({ status: "DISMISSED", completedByMemberId: loser });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBe(loser);
    expect(await prisma.member.count({ where: { id: loser } })).toBe(1);
  });
});
