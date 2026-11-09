/**
 * #4840 against real PostgreSQL: a manual settle recorded by an officer racing
 * a member merge that removes that officer's duplicate record, in both orders.
 *
 * The settle names its officer on the Payment row before its PAID claim, and
 * that FK takes `FOR KEY SHARE` on the officer's Member row. Member merge takes
 * no `lock(1)`. It holds the booking row from its relation moves on, then takes
 * `Member … FOR UPDATE` on the duplicate. Before #4840 the settle took the
 * Member key share first and the booking row after, so with the booking at a
 * lodge outside merge's lodge prefix the two waited on each other. The settle
 * now takes the booking row right after its lodge key: booking row, then
 * Member, the order merge and every other booking writer use.
 *
 * The fixture is a booking the duplicate made on a member's behalf
 * (`Booking.createdById`), at a lodge neither merge party has a guest row in,
 * paid in cash and recorded by the duplicate while it was an officer.
 *
 * The deadlock case parks merge at its `Member … FOR UPDATE` with a third
 * session holding `FOR KEY SHARE` on the duplicate's row (any FK write naming
 * the duplicate does this), so merge holds the booking row while it waits. That
 * is the moment the settle has to arrive in to deadlock.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** A pause inside the settle's transaction after its PAID claim, at its receipts: a pass-through with no hook set. */
const receiptsHook = vi.hoisted(() => ({ paused: null as null | (() => Promise<void>) }));
vi.mock("@/lib/member-money/doors", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/member-money/doors");
  return {
    ...real,
    postBookingReceipts: async (...args: Parameters<typeof real.postBookingReceipts>) => {
      const hook = receiptsHook.paused;
      if (hook) {
        receiptsHook.paused = null;
        await hook();
      }
      return real.postBookingReceipts(...args);
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

/** Until at least `count` backends wait on a row or advisory lock in this database. */
async function untilWaiting(count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} backends ever waited on a lock`);
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

async function state(id: string, paymentId: string) {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true, createdById: true } });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, manuallyMarkedPaidByMemberId: true } });
  return { ...booking, paymentStatus: payment.status, markedPaidBy: payment.manuallyMarkedPaidByMemberId };
}

/** Prisma's code for a write conflict or deadlock, and PostgreSQL's own, anywhere in the error. */
function isDeadlock(error: unknown): boolean {
  const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
  return /P2034|40P01|deadlock/i.test(text);
}

(RUN ? describe : describe.skip)("a manual settle by an officer racing a merge of that officer's duplicate (#4840)", { timeout: 180_000 }, () => {
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
    receiptsHook.paused = null;
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
    // Another writer's key share on the duplicate's row parks merge at its Member FOR UPDATE.
    const held = gate();
    const release = gate();
    const keyShare = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${loser} FOR KEY SHARE`;
      held.open();
      await release.opened;
    }, { maxWait: 30_000, timeout: 120_000 });
    await held.opened;
    let merging: Promise<unknown> = Promise.resolve();
    let settling: Promise<unknown> = Promise.resolve();
    try {
      merging = execute();
      await untilWaiting(1);
      // The duplicate, still signed in as an officer, records the cash now.
      settling = markPaid(id, loser);
      await untilWaiting(2);
    } finally {
      release.open();
    }
    await keyShare;
    const [merged, settled] = await Promise.allSettled([merging, settling]);
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    expect(settled.status).toBe("rejected");
    const reason = (settled as PromiseRejectedResult).reason;
    expect(isDeadlock(reason), String(reason)).toBe(false);
    // The settle names an officer the merge removed: its FK refuses and nothing is recorded.
    expect(reason).toMatchObject({ code: "P2003" });
    expect(await state(id, paymentId)).toEqual({ status: "PAYMENT_PENDING", createdById: master, paymentStatus: "PENDING", markedPaidBy: null });

    // The officer records it again from the surviving record.
    await markPaid(id, master);
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });

  it("a settle holding the booking row and the officer's key share makes the merge wait; both commit", async () => {
    const { id, paymentId, loser, master } = await bookingMadeByDuplicate("settle-first");
    const execute = await previewMerge(master, loser);
    const reached = gate();
    const release = gate();
    receiptsHook.paused = async () => {
      reached.open();
      await release.opened;
    };
    const settling = markPaid(id, loser);
    await reached.opened;
    let merging: Promise<unknown> = Promise.resolve();
    try {
      merging = execute();
      // The merge waits on the booking row the settle claimed.
      await untilWaiting(1);
    } finally {
      release.open();
    }
    const [settled, merged] = await Promise.allSettled([settling, merging]);
    expect(settled).toMatchObject({ status: "fulfilled", value: { bookingId: id, paymentId } });
    expect(merged.status, merged.status === "rejected" ? String(merged.reason) : "").toBe("fulfilled");
    // The merge carried the booking's actor and the settle's attribution to the survivor.
    expect(await state(id, paymentId)).toEqual({ status: "PAID", createdById: master, paymentStatus: "SUCCEEDED", markedPaidBy: master });
  });
});
