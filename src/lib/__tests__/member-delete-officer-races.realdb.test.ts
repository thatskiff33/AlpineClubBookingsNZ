/**
 * #4850 against real PostgreSQL: an approved hard-delete of an officer racing
 * that officer's own write on a booking the officer made, in both orders, for
 * the two writers #4840 aligned: a manual settle and an edit review's closure.
 *
 * Each writer takes the booking row, then names the officer through an FK
 * (`manuallyMarkedPaidByMemberId`, `completedByMemberId`), a `FOR KEY SHARE` on
 * the officer's Member row. The delete locks that Member row `FOR UPDATE` (its
 * Xero fence) and then, through `ON DELETE SET NULL`, updates every booking that
 * names the officer (`createdById` here). Taken in that order the delete held
 * the Member row and waited for the booking while the writer held the booking
 * and waited for the Member row. The delete now locks the booking rows naming
 * the member before its fence: booking row, then Member, as the writers do.
 *
 * The delete-first cases pause the delete right after its fence, so the writer
 * arrives while the delete holds the Member row (and, now, the booking row). The
 * writer-first cases pause the writer after its claim, so the delete arrives
 * while the writer holds the booking row and the officer's key share. The
 * choreography and its waits, each matched to the backend it waits on
 * (`pg_blocking_pids`), are shared with the member-merge race suites
 * (`support/member-merge-race.ts`).
 *
 * #4856 review: a Payment-first writer (the back-post's order: Payment row, then
 * booking row) holding a Payment the officer recorded makes the delete refuse at
 * once with a 409, because the delete now holds its booking rows from the start
 * and so takes the Payment rows `NOWAIT`.
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
  arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, expectRefusedByTheDeletedOfficer, firstStandWhilePaused, isDeadlock, pauseIn,
} from "./support/member-merge-race";
import { RACE_TRANSACTION_BUDGET } from "./support/race-lock-waits";

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

/** Pauses inside a transaction (slots "delete", "settle" and "closure"): pass-throughs unless a case arms one. */
vi.mock("@/lib/xero-contact-create-recovery", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/xero-contact-create-recovery");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    lockMemberForAccountDeletionXeroFence: async (...args: Parameters<typeof real.lockMemberForAccountDeletionXeroFence>) => {
      const fenced = await real.lockMemberForAccountDeletionXeroFence(...args);
      await pauseIn("delete", args[0]);
      return fenced;
    },
  };
});
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
const PREFIX = "race-4850-delete-officer-";
const names = historyNames(PREFIX);
const REQUESTER = `${PREFIX}admin-a`;
const APPROVER = `${PREFIX}admin-b`;
const PRICE = 20_000;
let prisma: PrismaClient;

function member(id: string, extra: Record<string, unknown> = {}) {
  return createRaceMember(prisma, id, { firstName: "Delete", ...extra });
}

/** An officer, and a cash booking that officer made for the history member, still unpaid. */
async function bookingMadeByOfficer(tag: string) {
  const officer = `${PREFIX}officer-${tag}`;
  await member(officer);
  const id = `${PREFIX}b-${tag}`;
  await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source: "INTERNET_BANKING" } });
  await prisma.booking.update({ where: { id }, data: { createdById: officer } });
  return { id, paymentId: `${id}-payment`, officer };
}

/** The same booking, paid in cash by another officer, with an edit review open on its second guest. */
async function reviewOnBookingMadeByOfficer(tag: string) {
  const made = await bookingMadeByOfficer(tag);
  await markPaid(made.id, names.officerId);
  const guestId = `${made.id}-g2`;
  const taskId = await parkHistoryStrand(prisma, names, made.id, guestId);
  for (const [stayDate, priceCents] of [["2027-08-01", 5_000], ["2027-08-02", 2_000]] as const) {
    await prisma.bookingGuestNight.updateMany({ where: { bookingGuestId: guestId, stayDate: new Date(`${stayDate}T00:00:00.000Z`) }, data: { priceCents, priceSource: "OFFICER_PRICED" } });
  }
  await prisma.bookingGuest.update({ where: { id: guestId }, data: { priceCents: 7_000 } });
  return { ...made, taskId };
}

/** One admin asks for the officer's hard-delete; the approval, by another, is returned to run. */
async function deleteRequested(officer: string) {
  const lifecycle = await import("@/lib/member-lifecycle-actions");
  const { request } = await lifecycle.createMemberDeleteRequest({ memberId: officer, requestedByMemberId: REQUESTER, reason: "Duplicate officer account" });
  return () => lifecycle.reviewMemberDeleteRequest({ requestId: request.id, reviewedByMemberId: APPROVER, action: "approve", reviewNote: "Approved" });
}

async function markPaid(bookingId: string, officer: string) {
  const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
  return markBookingPaymentManuallySettled({ bookingId, actingAdminMemberId: officer, note: "cash at the lodge", expectedAmountCents: PRICE, notifyMember: false, format: CLUB_FORMAT_TEST });
}

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

async function memberExists(id: string) {
  return (await prisma.member.count({ where: { id } })) === 1;
}

(RUN ? describe : describe.skip)("an officer's hard-delete racing that officer's own write (#4850)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4850 delete officer race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    for (const admin of [REQUESTER, APPROVER]) {
      await member(admin, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
    }
  }, 120_000);

  afterAll(async () => {
    clearPauses();
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }, { subjectMemberId: members }] } });
    await prisma.memberLifecycleActionRequest.deleteMany({ where: { OR: [{ memberId: members }, { requestedByMemberId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  it("MUTATION: a delete holding the officer's Member row makes that officer's settle wait at the booking row, never a deadlock", async () => {
    const { id, paymentId, officer } = await bookingMadeByOfficer("delete-before-settle");
    const approve = await deleteRequested(officer);
    const { held: deleted, arrived: written } = await arrivingWhilePaused(prisma, "delete", approve, () => markPaid(id, officer));
    expectFulfilled(deleted);
    expectRefusedByTheDeletedOfficer(written);
    expect(await memberExists(officer)).toBe(false);
    expect(await state(id, paymentId)).toEqual({ status: "PAYMENT_PENDING", createdById: null, paymentStatus: "PENDING", markedPaidBy: null });
  });

  it("a settle holding the booking row and the officer's key share makes the delete wait; both commit", async () => {
    const { id, paymentId, officer } = await bookingMadeByOfficer("settle-before-delete");
    const approve = await deleteRequested(officer);
    const { held: written, arrived: deleted } = await arrivingWhilePaused(prisma, "settle", () => markPaid(id, officer), approve);
    expectFulfilled(written);
    expectFulfilled(deleted);
    expect(await memberExists(officer)).toBe(false);
    // The delete's SET NULL cleared both of the officer's names, after the settle committed.
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: null, paymentStatus: "SUCCEEDED", markedPaidBy: null });
  });

  it("MUTATION: a delete holding the officer's Member row makes that officer's review closure wait at the booking row, never a deadlock", async () => {
    const { id, taskId, officer } = await reviewOnBookingMadeByOfficer("delete-before-closure");
    const approve = await deleteRequested(officer);
    const { held: deleted, arrived: written } = await arrivingWhilePaused(prisma, "delete", approve, () => dismissReview(taskId, officer));
    expectFulfilled(deleted);
    expectRefusedByTheDeletedOfficer(written);
    expect(await memberExists(officer)).toBe(false);
    expect(await taskState(taskId)).toEqual({ status: "OPEN", completedByMemberId: null });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBeNull();
  });

  it("a review closure holding the booking row and the officer's key share makes the delete wait; neither deadlocks", async () => {
    const { id, taskId, officer } = await reviewOnBookingMadeByOfficer("closure-before-delete");
    const approve = await deleteRequested(officer);
    const { held: written, arrived: deleted } = await arrivingWhilePaused(prisma, "closure", () => dismissReview(taskId, officer), approve);
    expectFulfilled(written);
    expect(await taskState(taskId)).toMatchObject({ status: "DISMISSED" });
    // The closure recorded a booking modification in the officer's name, so the delete's
    // eligibility, re-read under its fence, now refuses: the officer and the history stay.
    expect(deleted.status).toBe("rejected");
    const reason = (deleted as PromiseRejectedResult).reason;
    expect(isDeadlock(reason), String(reason)).toBe(false);
    expect(reason).toMatchObject({ statusCode: 409 });
    expect(await memberExists(officer)).toBe(true);
    expect(await taskState(taskId)).toEqual({ status: "DISMISSED", completedByMemberId: officer });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBe(officer);
  });

  it("MUTATION: a Payment-first writer holding a payment the officer recorded makes the delete refuse at once, never wait; the writer then commits", async () => {
    const { id, paymentId, officer } = await bookingMadeByOfficer("payment-first");
    // The officer recorded the cash, so the Payment row names the officer.
    await markPaid(id, officer);
    const approve = await deleteRequested(officer);
    const { acquireLodgeCapacityLock } = await import("@/lib/capacity");
    const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
    const { lockBookingRowForOwnerRead } = await import("@/lib/booking-row-lock");
    // The back-post's order through the writers' own helpers: lock(1), the lodge key, the Payment row, then the booking row.
    const writer = () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, names.lodgeId);
      await lockPaymentForRefundedTotal(tx, paymentId);
      await pauseIn("payment-first-before-booking-row", tx);
      await lockBookingRowForOwnerRead(tx, id);
      await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 300 } });
    }, RACE_TRANSACTION_BUDGET);
    const { first, held: written, arrived: deleted } = await firstStandWhilePaused(
      prisma, "payment-first-before-booking-row", writer, approve, { label: "the delete" },
    );
    // Before the review fix the delete held the booking row and waited for this Payment row in its cascade.
    expect(first, "the delete waited for the Payment row the writer held").toBe("settled");
    expect(deleted.status).toBe("rejected");
    expect((deleted as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expectFulfilled(written);
    expect(await memberExists(officer)).toBe(true);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { manuallyMarkedPaidByMemberId: true, changeFeeCents: true } });
    expect(payment).toEqual({ manuallyMarkedPaidByMemberId: officer, changeFeeCents: 300 });
  });
});
