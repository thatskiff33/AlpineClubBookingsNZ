/**
 * #4823 against real PostgreSQL: a member merge re-attributing a Payment row
 * (`manuallyMarkedPaidByMemberId`, the officer who recorded a cash settlement)
 * racing `lock(1)` writers that take that booking's Payment and booking rows,
 * in both orders.
 *
 * Merge takes no `lock(1)` and holds booking rows from its owner and actor
 * moves on. A card settle (W1) takes the Payment row, then the booking row (its
 * PAID claim). The edit doors take the booking row, then the Payment row. Before
 * #4823 merge waited for the Payment row after its booking moves, so a settle
 * holding the Payment row deadlocked against it. Moving the Payment rows ahead
 * of the booking moves would deadlock against the edit-door order instead. Merge
 * now takes them last, after its `Member … FOR UPDATE`, in one sorted `NOWAIT`
 * statement, and a held row refuses the merge.
 *
 * The fixture is a booking the duplicate made on a member's behalf
 * (`Booking.createdById`), so merge holds its booking row, at a lodge neither
 * merge party has a guest row in, so merge's lodge prefix does not fence the
 * writers. For the card settle, the duplicate's attribution is written onto the
 * payable booking's Payment row directly: no writer leaves one there (a mark-paid
 * makes the booking PAID and its reversal clears it), and the case is about the
 * order of the two rows, which the settle takes the same way on any payable
 * booking. The edit-door race uses a real cash settlement by the duplicate, then
 * the doors' own lock order through their lock helpers (lock(1), the lodge key,
 * the booking row, the Payment row), paused before the Payment row. An approved
 * appeal also takes the booking row first, but refuses a cash-settled payment
 * before its transaction, so it never meets merge on one of these rows.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, isBlocking, untilBlockedChain } from "./support/race-lock-waits";
import { acquireLodgeCapacityLock } from "@/lib/capacity";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The writers open their transactions with no options: give them a budget the race, not the runner, decides (#4844 review F5). */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

/** A pause right after a writer locks one Payment row, handed that transaction's backend id: a pass-through with no hook set. */
const paymentHook = vi.hoisted(() => ({ paymentId: null as null | string, afterLock: null as null | ((pid: number) => Promise<void>) }));
vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/payment-transactions");
  return {
    ...real,
    lockPaymentForRefundedTotal: async (...args: Parameters<typeof real.lockPaymentForRefundedTotal>) => {
      await real.lockPaymentForRefundedTotal(...args);
      const hook = args[1] === paymentHook.paymentId ? paymentHook.afterLock : null;
      if (hook) {
        paymentHook.afterLock = null;
        await hook(await backendPid(args[0] as unknown as Prisma.TransactionClient));
      }
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4823-merge-payment-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/**
 * How the merge first stood: settled (either way), or waiting on the paused writer's
 * backend. Matched to that backend (`pg_blocking_pids`), never counted across the
 * database, because the CI job runs other suites against it (#4844 review F4).
 */
async function settledOrBlockedBy(merging: Promise<unknown>, writerPid: number): Promise<"settled" | "waiting"> {
  let settled = false;
  void merging.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (settled) return "settled";
    if (await isBlocking(prisma, writerPid)) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the merge neither settled nor waited");
}

async function member(id: string, extra: Record<string, unknown> = {}) {
  await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: id, ageTier: "ADULT", ...extra } });
}

/** A booking the duplicate made for the history member, with the payment in `source`. */
async function bookingMadeByDuplicate(tag: string, source: "STRIPE" | "INTERNET_BANKING") {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await member(loser);
  await member(master);
  const id = `${PREFIX}b-${tag}`;
  await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source, intent: source === "STRIPE" ? `pi_${id}` : undefined } });
  await prisma.booking.update({ where: { id }, data: { createdById: loser } });
  return { id, paymentId: `${id}-payment`, loser, master };
}

async function previewMerge(master: string, loser: string) {
  const merge = await import("@/lib/member-merge");
  const preview = await merge.buildMemberMergePreview({ masterId: master, loserId: loser, actorMemberId: ADMIN });
  expect(preview.blockers).toEqual([]);
  return () => merge.executeMemberMerge({ masterId: master, loserId: loser, actorMemberId: ADMIN, previewToken: preview.previewToken, confirmationText: preview.confirmationPhrase });
}

async function settleByCard(bookingId: string) {
  const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
  return markBookingPaymentSucceeded({ bookingId, paymentIntentId: `pi_${bookingId}`, amountCents: PRICE, paymentMethodId: null, format: CLUB_FORMAT_TEST });
}

/** Hold one of the duplicate's reset tokens, so the merge stops at its delete, after the Payment rows. */
async function holdLoserDelete(loser: string) {
  const token = await prisma.passwordResetToken.create({ data: { memberId: loser, tokenHash: `${loser}-reset`, expiresAt: new Date("2026-08-01T00:00:00.000Z") } });
  const held = gate();
  const release = gate();
  let pid = 0;
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "PasswordResetToken" WHERE "id" = ${token.id} FOR UPDATE`;
    pid = await backendPid(tx);
    held.open();
    await release.opened;
  }, { maxWait: 30_000, timeout: 120_000 });
  await held.opened;
  return { release: release.open, blocker, pid };
}

async function attribution(paymentId: string) {
  return (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { manuallyMarkedPaidByMemberId: true } })).manuallyMarkedPaidByMemberId;
}

async function bookingState(id: string) {
  return prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true, createdById: true } });
}

(RUN ? describe : describe.skip)("a member merge re-attributing a Payment row racing lock(1) writers (#4823)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4823 merge Payment row race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    await seedHistoryFixtures(prisma, PREFIX);
    await member(ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
  }, 120_000);

  afterAll(async () => {
    paymentHook.paymentId = null;
    paymentHook.afterLock = null;
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    await cleanHistories(prisma, PREFIX);
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }] } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  it("MUTATION: a card settle holding the Payment row makes the merge refuse at once, never wait; the settle commits and a re-run merges", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("settle-first", "STRIPE");
    await prisma.payment.update({ where: { id: paymentId }, data: { manuallyMarkedPaidByMemberId: loser } });
    const reached = gate();
    const release = gate();
    paymentHook.paymentId = paymentId;
    let settlePid = 0;
    paymentHook.afterLock = async (pid) => {
      settlePid = pid;
      reached.open();
      await release.opened;
    };
    const settling = settleByCard(id);
    await reached.opened;
    let merging: Promise<unknown> = Promise.resolve();
    let first: "settled" | "waiting";
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      first = await settledOrBlockedBy(merging, settlePid);
    } finally {
      release.open();
    }
    const [settled, merged] = await Promise.allSettled([settling, merging]);
    // Before #4823 the merge waited here, holding the booking row the settle was about to claim.
    expect(first, "the merge waited for the Payment row the settle held").toBe("settled");
    expect(settled).toMatchObject({ status: "fulfilled", value: { outcome: "paid" } });
    expect(merged.status).toBe("rejected");
    expect((merged as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: "merge_payment_row_busy" });
    // Nothing of the merge was written.
    expect(await attribution(paymentId)).toBe(loser);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: loser });
    expect(await prisma.member.count({ where: { id: loser } })).toBe(1);

    const rerun = await previewMerge(master, loser);
    await rerun();
    expect(await attribution(paymentId)).toBe(master);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: master });
    expect(await prisma.member.count({ where: { id: loser } })).toBe(0);
  });

  it("a merge holding the Payment row makes the card settle wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("merge-first", "STRIPE");
    await prisma.payment.update({ where: { id: paymentId }, data: { manuallyMarkedPaidByMemberId: loser } });
    const { release, blocker, pid } = await holdLoserDelete(loser);
    let merging: Promise<unknown> = Promise.resolve();
    let settling: Promise<unknown> = Promise.resolve();
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      // The merge stops at the duplicate's delete, after its Payment rows.
      await untilBlockedChain(prisma, pid, 1);
      settling = settleByCard(id);
      // The settle queues behind the merge.
      await untilBlockedChain(prisma, pid, 2);
    } finally {
      release();
    }
    await blocker;
    const [merged, settled] = await Promise.allSettled([merging, settling]);
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(settled).toMatchObject({ status: "fulfilled", value: { outcome: "paid" } });
    expect(await attribution(paymentId)).toBe(master);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: master });
  });

  it("MUTATION: an edit door holding the booking row, before its Payment row, makes the merge wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("door-first", "INTERNET_BANKING");
    const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
    // The duplicate, an officer at the time, recorded the cash.
    await markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: loser, note: "cash at the lodge", expectedAmountCents: PRICE, notifyMember: false, format: CLUB_FORMAT_TEST });
    expect(await attribution(paymentId)).toBe(loser);
    const { lockBookingRowForOwnerRead } = await import("@/lib/member-money/doors");
    const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
    const held = gate();
    const release = gate();
    let doorPid = 0;
    // The edit doors' order through their own helpers: lock(1), the lodge key, the booking row, then the Payment row.
    const door = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, names.lodgeId);
      await lockBookingRowForOwnerRead(tx, id);
      doorPid = await backendPid(tx);
      held.open();
      await release.opened;
      await lockPaymentForRefundedTotal(tx, paymentId);
      await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 500 } });
    }, { maxWait: 30_000, timeout: 120_000 });
    await held.opened;
    let merging: Promise<unknown> = Promise.resolve();
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      // The merge waits on the booking row; it must not hold the Payment row while it does.
      await untilBlockedChain(prisma, doorPid, 1);
    } finally {
      release.open();
    }
    const [doorDone, merged] = await Promise.allSettled([door, merging]);
    expect(doorDone.status, doorDone.status === "rejected" ? String(doorDone.reason) : "").toBe("fulfilled");
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(await attribution(paymentId)).toBe(master);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: master });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { changeFeeCents: true } })).changeFeeCents).toBe(500);
  });

  it("a merge holding both rows makes the edit door wait at the booking row; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("merge-before-door", "INTERNET_BANKING");
    const { markBookingPaymentManuallySettled } = await import("@/lib/payment-reconciliation");
    await markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: loser, note: "cash at the lodge", expectedAmountCents: PRICE, notifyMember: false, format: CLUB_FORMAT_TEST });
    const { lockBookingRowForOwnerRead } = await import("@/lib/member-money/doors");
    const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
    const { release, blocker, pid } = await holdLoserDelete(loser);
    let merging: Promise<unknown> = Promise.resolve();
    let door: Promise<unknown> = Promise.resolve();
    try {
      const execute = await previewMerge(master, loser);
      merging = execute();
      await untilBlockedChain(prisma, pid, 1);
      door = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, names.lodgeId);
        await lockBookingRowForOwnerRead(tx, id);
        await lockPaymentForRefundedTotal(tx, paymentId);
        await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 700 } });
      }, { maxWait: 30_000, timeout: 120_000 });
      await untilBlockedChain(prisma, pid, 2);
    } finally {
      release();
    }
    await blocker;
    const [merged, doorDone] = await Promise.allSettled([merging, door]);
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(doorDone.status, doorDone.status === "rejected" ? String(doorDone.reason) : "").toBe("fulfilled");
    expect(await attribution(paymentId)).toBe(master);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { changeFeeCents: true } })).changeFeeCents).toBe(700);
  });
});
