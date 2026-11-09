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
 * session holding `FOR KEY SHARE` on the duplicate's row (any FK write naming
 * the duplicate does this), so merge holds the booking row while it waits. That
 * is the moment the writer has to arrive in to deadlock. Every wait is matched
 * to the backend it waits on (`pg_blocking_pids`), never counted across the
 * database, because the CI job runs other suites against it.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, parkHistoryStrand, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, untilBlockedChain } from "./support/race-lock-waits";

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

/** A pause inside a writer's transaction after its claim, handed that transaction's backend id: pass-throughs with no hook set. */
const pauses = vi.hoisted(() => ({ settle: null as null | ((pid: number) => Promise<void>), closure: null as null | ((pid: number) => Promise<void>) }));
async function pauseIn(slot: "settle" | "closure", tx: unknown): Promise<void> {
  const hook = pauses[slot];
  if (!hook) return;
  pauses[slot] = null;
  await hook(await backendPid(tx as Prisma.TransactionClient));
}
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
const PREFIX = "race-4840-merge-officer-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", ...extra } });
}

/** A cash booking the duplicate made for the history member, still unpaid. */
async function bookingMadeByDuplicate(tag: string) {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await member(loser);
  await member(master);
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

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: ADMIN });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: ADMIN, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
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

/** Prisma's code for a write conflict or deadlock, and PostgreSQL's own, anywhere in the error. */
function isDeadlock(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
  return /P2034|40P01|deadlock/i.test(text);
}

/**
 * Park a merge at its Member FOR UPDATE behind another session's key share on
 * the duplicate, start `writer` and wait until it queues behind the merge, then
 * let everything go. Returns both outcomes.
 */
async function writerArrivingWhileMergeWaitsOnTheMember(loser: string, execute: () => Promise<unknown>, writer: () => Promise<unknown>) {
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
  let writing: Promise<unknown> = Promise.resolve();
  try {
    merging = execute();
    await untilBlockedChain(prisma, blockerPid, 1);
    writing = writer();
    // The writer queues behind the merge, which is still waiting on the key share.
    await untilBlockedChain(prisma, blockerPid, 2);
  } finally {
    release.open();
  }
  await keyShare;
  const [merged, written] = await Promise.allSettled([merging, writing]);
  return { merged, written };
}

/** Pause `writer` after its claim, start the merge, and wait until the merge queues behind it. */
async function mergeArrivingWhileWriterHoldsTheBooking(slot: "settle" | "closure", execute: () => Promise<unknown>, writer: () => Promise<unknown>) {
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
  let merging: Promise<unknown> = Promise.resolve();
  try {
    merging = execute();
    // The merge waits on the booking row the writer claimed.
    await untilBlockedChain(prisma, writerPid, 1);
  } finally {
    release.open();
  }
  const [written, merged] = await Promise.allSettled([writing, merging]);
  return { merged, written };
}

function expectRefusedByTheDeletedOfficer(written: PromiseSettledResult<unknown>) {
  expect(written.status).toBe("rejected");
  const reason = (written as PromiseRejectedResult).reason;
  expect(isDeadlock(reason), String(reason)).toBe(false);
  // The writer names an officer the merge removed: its FK refuses and nothing is recorded.
  expect(reason).toMatchObject({ code: "P2003" });
}

(RUN ? describe : describe.skip)("an officer's write racing a merge of that officer's duplicate (#4840)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4840 merge officer settle race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await member(ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
  }, 120_000);

  afterAll(async () => {
    pauses.settle = null;
    pauses.closure = null;
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  it("MUTATION: a merge holding the booking row and waiting for the duplicate's Member row makes the settle wait at the booking row, never a deadlock", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("merge-first");
    const execute = await previewMerge(master, loser);
    // The duplicate, still signed in as an officer, records the cash now.
    const { merged, written } = await writerArrivingWhileMergeWaitsOnTheMember(loser, execute, () => markPaid(id, loser));
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expectRefusedByTheDeletedOfficer(written);
    expect(await state(id, paymentId)).toEqual({ status: "PAYMENT_PENDING", createdById: master, paymentStatus: "PENDING", markedPaidBy: null });

    // The officer records it again from the surviving record.
    await markPaid(id, master);
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });

  it("a settle holding the booking row and the officer's key share makes the merge wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("settle-first");
    const execute = await previewMerge(master, loser);
    const { merged, written } = await mergeArrivingWhileWriterHoldsTheBooking("settle", execute, () => markPaid(id, loser));
    expect(written).toMatchObject({ status: "fulfilled", value: { bookingId: id, paymentId } });
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    // The merge carried the booking's actor and the settle's attribution to the survivor.
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });

  it("MUTATION: a merge holding the booking row and waiting for the duplicate's Member row makes an edit review's closure wait at the booking row, never a deadlock", async () => {
    const { id, taskId, loser, master } = await reviewOnBookingMadeByDuplicate("merge-before-closure");
    const execute = await previewMerge(master, loser);
    const { merged, written } = await writerArrivingWhileMergeWaitsOnTheMember(loser, execute, () => dismissReview(taskId, loser));
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expectRefusedByTheDeletedOfficer(written);
    expect(await taskState(taskId)).toEqual({ status: "OPEN", completedByMemberId: null });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBe(master);

    // The officer closes it again from the surviving record.
    await dismissReview(taskId, master);
    expect(await taskState(taskId)).toEqual({ status: "DISMISSED", completedByMemberId: master });
  });

  it("an edit review's closure holding the booking row and the officer's key share makes the merge wait; both commit", async () => {
    const { id, taskId, loser, master } = await reviewOnBookingMadeByDuplicate("closure-first");
    const execute = await previewMerge(master, loser);
    const { merged, written } = await mergeArrivingWhileWriterHoldsTheBooking("closure", execute, () => dismissReview(taskId, loser));
    expect(written.status, written.status === "rejected" ? String(written.reason) : "").toBe("fulfilled");
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    // The merge carried the booking's actor and the closure's officer to the survivor.
    expect(await taskState(taskId)).toEqual({ status: "DISMISSED", completedByMemberId: master });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id }, select: { createdById: true } })).createdById).toBe(master);
  });
});
