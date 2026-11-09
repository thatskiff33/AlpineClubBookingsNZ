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
import {
  arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, firstStandWhilePaused, pauseIn, previewMerge, writerArrivingWhileMergeIsParked,
} from "./support/member-merge-race";
import { RACE_TRANSACTION_BUDGET } from "./support/race-lock-waits";
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

/** A pause right after a writer locks one Payment row (slot `after-payment-row:<id>`): a pass-through unless a case arms it. */
vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/payment-transactions");
  const race = await import("./support/member-merge-race");
  return {
    ...real,
    lockPaymentForRefundedTotal: async (...args: Parameters<typeof real.lockPaymentForRefundedTotal>) => {
      await real.lockPaymentForRefundedTotal(...args);
      await race.pauseIn(`after-payment-row:${args[1]}`, args[0]);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4823-merge-payment-";
const names = historyNames(PREFIX);
const ADMIN = `${PREFIX}admin`;
const PRICE = 20_000;
let prisma: PrismaClient;

/** A booking the duplicate made for the history member, with the payment in `source`. */
async function bookingMadeByDuplicate(tag: string, source: "STRIPE" | "INTERNET_BANKING") {
  const loser = `${PREFIX}loser-${tag}`;
  const master = `${PREFIX}master-${tag}`;
  await createRaceMember(prisma, loser);
  await createRaceMember(prisma, master);
  const id = `${PREFIX}b-${tag}`;
  await createHistoryBooking(prisma, names, id, { payment: { amountCents: PRICE, source, intent: source === "STRIPE" ? `pi_${id}` : undefined } });
  await prisma.booking.update({ where: { id }, data: { createdById: loser } });
  return { id, paymentId: `${id}-payment`, loser, master };
}

async function settleByCard(bookingId: string) {
  const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
  return markBookingPaymentSucceeded({ bookingId, paymentIntentId: `pi_${bookingId}`, amountCents: PRICE, paymentMethodId: null, format: CLUB_FORMAT_TEST });
}

/** One of the duplicate's reset tokens, and the lock on it that parks the merge at its delete, after the Payment rows. */
async function loserDeleteHold(loser: string) {
  const token = await prisma.passwordResetToken.create({ data: { memberId: loser, tokenHash: `${loser}-reset`, expiresAt: new Date("2026-08-01T00:00:00.000Z") } });
  return (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT 1 FROM "PasswordResetToken" WHERE "id" = ${token.id} FOR UPDATE`;
}

/** The merge, previewed by the admin as it starts. */
async function previewAndMerge(master: string, loser: string) {
  return (await previewMerge(master, loser, ADMIN))();
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

  it("MUTATION: a card settle holding the Payment row makes the merge refuse at once, never wait; the settle commits and a re-run merges", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("settle-first", "STRIPE");
    await prisma.payment.update({ where: { id: paymentId }, data: { manuallyMarkedPaidByMemberId: loser } });
    const { first, held: settled, arrived: merged } = await firstStandWhilePaused(
      prisma, `after-payment-row:${paymentId}`, () => settleByCard(id), () => previewAndMerge(master, loser), { label: "the merge" },
    );
    // Before #4823 the merge waited here, holding the booking row the settle was about to claim.
    expect(first, "the merge waited for the Payment row the settle held").toBe("settled");
    expect(settled).toMatchObject({ status: "fulfilled", value: { outcome: "paid" } });
    expect(merged.status).toBe("rejected");
    expect((merged as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: "merge_payment_row_busy" });
    // Nothing of the merge was written.
    expect(await attribution(paymentId)).toBe(loser);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: loser });
    expect(await prisma.member.count({ where: { id: loser } })).toBe(1);

    const rerun = await previewMerge(master, loser, ADMIN);
    await rerun();
    expect(await attribution(paymentId)).toBe(master);
    expect(await bookingState(id)).toEqual({ status: "PAID", createdById: master });
    expect(await prisma.member.count({ where: { id: loser } })).toBe(0);
  });

  it("a merge holding the Payment row makes the card settle wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("merge-first", "STRIPE");
    await prisma.payment.update({ where: { id: paymentId }, data: { manuallyMarkedPaidByMemberId: loser } });
    // The merge stops at the duplicate's delete, after its Payment rows, and the settle queues behind it.
    const park = await loserDeleteHold(loser);
    const execute = await previewMerge(master, loser, ADMIN);
    const { merged, written: settled } = await writerArrivingWhileMergeIsParked(prisma, park, execute, () => settleByCard(id));
    expectFulfilled(merged);
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
    // The edit doors' order through their own helpers: lock(1), the lodge key, the booking row, then the Payment row.
    const door = () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, names.lodgeId);
      await lockBookingRowForOwnerRead(tx, id);
      await pauseIn("door-before-payment-row", tx);
      await lockPaymentForRefundedTotal(tx, paymentId);
      await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 500 } });
    }, RACE_TRANSACTION_BUDGET);
    // The merge waits on the booking row; it must not hold the Payment row while it does.
    const { held: doorDone, arrived: merged } = await arrivingWhilePaused(prisma, "door-before-payment-row", door, () => previewAndMerge(master, loser));
    expectFulfilled(doorDone);
    expectFulfilled(merged);
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
    const park = await loserDeleteHold(loser);
    const execute = await previewMerge(master, loser, ADMIN);
    const door = () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, names.lodgeId);
      await lockBookingRowForOwnerRead(tx, id);
      await lockPaymentForRefundedTotal(tx, paymentId);
      await tx.payment.update({ where: { id: paymentId }, data: { changeFeeCents: 700 } });
    }, RACE_TRANSACTION_BUDGET);
    const { merged, written: doorDone } = await writerArrivingWhileMergeIsParked(prisma, park, execute, door);
    expectFulfilled(merged);
    expectFulfilled(doorDone);
    expect(await attribution(paymentId)).toBe(master);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { changeFeeCents: true } })).changeFeeCents).toBe(700);
  });
});
