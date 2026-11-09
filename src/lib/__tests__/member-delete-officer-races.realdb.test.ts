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
 * while the writer holds the booking row and the officer's key share. Every
 * wait is matched to the backend it waits on (`pg_blocking_pids`).
 *
 * #4856 review: a Payment-first writer (the back-post's order: Payment row, then
 * booking row) holding a Payment the officer recorded makes the delete refuse at
 * once with a 409, because the delete now holds its booking rows from the start
 * and so takes the Payment rows `NOWAIT`.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, parkHistoryStrand, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, isBlocking, untilBlockedChain } from "./support/race-lock-waits";

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

/** Pauses inside a transaction, handed its backend id: pass-throughs with no hook set. */
type Slot = "delete" | "settle" | "closure";
const pauses = vi.hoisted(() => ({ delete: null, settle: null, closure: null } as Record<"delete" | "settle" | "closure", null | ((pid: number) => Promise<void>)>));
async function pauseIn(slot: Slot, tx: unknown): Promise<void> {
  const hook = pauses[slot];
  if (!hook) return;
  pauses[slot] = null;
  await hook(await backendPid(tx as Prisma.TransactionClient));
}
vi.mock("@/lib/xero-contact-create-recovery", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/xero-contact-create-recovery");
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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Delete", lastName: id, ageTier: "ADULT", ...extra } });
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

function isDeadlock(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
  return /P2034|40P01|deadlock/i.test(text);
}

function expectFulfilled(settled: PromiseSettledResult<unknown>) {
  expect(settled.status, settled.status === "rejected" ? String(settled.reason) : "").toBe("fulfilled");
}

/** The writer names an officer the delete removed: its FK refuses, and nothing is recorded. */
function expectRefusedByTheDeletedOfficer(written: PromiseSettledResult<unknown>) {
  expect(written.status).toBe("rejected");
  const reason = (written as PromiseRejectedResult).reason;
  expect(isDeadlock(reason), String(reason)).toBe(false);
  expect(reason).toMatchObject({ code: "P2003" });
}

/** Pause the delete right after its Member fence, start the writer, and wait until it queues behind the delete. */
async function writerArrivingWhileDeleteHoldsTheFence(approve: () => Promise<unknown>, writer: () => Promise<unknown>) {
  const reached = gate();
  const release = gate();
  let deletePid = 0;
  pauses.delete = async (pid) => {
    deletePid = pid;
    reached.open();
    await release.opened;
  };
  const deleting = approve();
  await reached.opened;
  let writing: Promise<unknown> = Promise.resolve();
  try {
    writing = writer();
    await untilBlockedChain(prisma, deletePid, 1);
  } finally {
    release.open();
  }
  const [deleted, written] = await Promise.allSettled([deleting, writing]);
  return { deleted, written };
}

/** Pause the writer after its claim, start the delete, and wait until it queues behind the writer. */
async function deleteArrivingWhileWriterHoldsTheBooking(slot: "settle" | "closure", approve: () => Promise<unknown>, writer: () => Promise<unknown>) {
  const reached = gate();
  const release = gate();
  let writerPid = 0;
  pauses[slot] = async (pid) => {
    writerPid = pid;
    reached.open();
    await release.opened;
  };
  const writing = writer();
  await reached.opened;
  let deleting: Promise<unknown> = Promise.resolve();
  try {
    deleting = approve();
    await untilBlockedChain(prisma, writerPid, 1);
  } finally {
    release.open();
  }
  const [written, deleted] = await Promise.allSettled([writing, deleting]);
  return { deleted, written };
}

/** Whether the delete settled (either way) or came to wait on the paused writer's backend. */
async function settledOrBlockedBy(deleting: Promise<unknown>, writerPid: number): Promise<"settled" | "waiting"> {
  let settled = false;
  void deleting.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (settled) return "settled";
    if (await isBlocking(prisma, writerPid)) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the delete neither settled nor waited");
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
    pauses.delete = null;
    pauses.settle = null;
    pauses.closure = null;
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
    const { deleted, written } = await writerArrivingWhileDeleteHoldsTheFence(approve, () => markPaid(id, officer));
    expectFulfilled(deleted);
    expectRefusedByTheDeletedOfficer(written);
    expect(await memberExists(officer)).toBe(false);
    expect(await state(id, paymentId)).toEqual({ status: "PAYMENT_PENDING", createdById: null, paymentStatus: "PENDING", markedPaidBy: null });
  });

  it("a settle holding the booking row and the officer's key share makes the delete wait; both commit", async () => {
    const { id, paymentId, officer } = await bookingMadeByOfficer("settle-before-delete");
    const approve = await deleteRequested(officer);
    const { deleted, written } = await deleteArrivingWhileWriterHoldsTheBooking("settle", approve, () => markPaid(id, officer));
    expectFulfilled(written);
    expectFulfilled(deleted);
    expect(await memberExists(officer)).toBe(false);
    // The delete's SET NULL cleared both of the officer's names, after the settle committed.
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: null, paymentStatus: "SUCCEEDED", markedPaidBy: null });
  });

  it("MUTATION: a delete holding the officer's Member row makes that officer's review closure wait at the booking row, never a deadlock", async () => {
    const { id, taskId, officer } = await reviewOnBookingMadeByOfficer("delete-before-closure");
    const approve = await deleteRequested(officer);
    const { deleted, written } = await writerArrivingWhileDeleteHoldsTheFence(approve, () => dismissReview(taskId, officer));
    expectFulfilled(deleted);
    expectRefusedByTheDeletedOfficer(written);
    expect(await memberExists(officer)).toBe(false);
    expect(await taskState(taskId)).toEqual({ status: "OPEN", completedByMemberId: null });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBeNull();
  });

  it("a review closure holding the booking row and the officer's key share makes the delete wait; neither deadlocks", async () => {
    const { id, taskId, officer } = await reviewOnBookingMadeByOfficer("closure-before-delete");
    const approve = await deleteRequested(officer);
    const { deleted, written } = await deleteArrivingWhileWriterHoldsTheBooking("closure", approve, () => dismissReview(taskId, officer));
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
    const { lockBookingRowForOwnerRead } = await import("@/lib/member-money/doors");
    const held = gate();
    const release = gate();
    let writerPid = 0;
    // The back-post's order through the writers' own helpers: lock(1), the lodge key, the Payment row, then the booking row.
    const writer = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, names.lodgeId);
      await lockPaymentForRefundedTotal(tx, paymentId);
      writerPid = await backendPid(tx);
      held.open();
      await release.opened;
      await lockBookingRowForOwnerRead(tx, id);
      await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 300 } });
    }, { maxWait: 30_000, timeout: 120_000 });
    await held.opened;
    let deleting: Promise<unknown> = Promise.resolve();
    let first: "settled" | "waiting" = "waiting";
    try {
      deleting = approve();
      first = await settledOrBlockedBy(deleting, writerPid);
    } finally {
      release.open();
    }
    const [deleted, written] = await Promise.allSettled([deleting, writer]);
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
