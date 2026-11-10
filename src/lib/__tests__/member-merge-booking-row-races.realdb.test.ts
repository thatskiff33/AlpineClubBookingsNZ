/**
 * #4860 against real PostgreSQL: member merge re-points the duplicate's
 * captured bookings, and a sibling writer already holds one of them.
 *
 * The bookings are inserted so id order and insertion order disagree:
 * `mrg-book-z` first, then `mrg-book-a` (sorts first, inserted second). The
 * other session stands in for every writer that already holds the request's
 * booking (`lockBookingRowForOwnerRead`, `FOR NO KEY UPDATE`) and then updates
 * the split sibling: the policy-exception approval, the change-request
 * approval, cancel, date edits, and the other callers of
 * `reconcileAdultMemberHostingReviewWithSiblings`. Those writers are unchanged.
 *
 * Before this, the `Booking.member` update locked rows in insertion order and
 * deadlocked with that session (`40P01`). Merge now try-locks the captured set
 * inside the attempt and, on a shortfall, rolls the attempt back before
 * waiting for the one busy booking. The last case takes merge out of the cycle:
 * two sessions locking the same two rows in crossed order still deadlock.
 *
 * Waits are pid-specific (`pg_blocking_pids` in `race-lock-waits.ts`). Ordinary
 * Vitest runs skip the file; CI's real-PostgreSQL job runs it against the
 * guarded loopback race database.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { backendPid, isBlocking, RACE_TRANSACTION_BUDGET, untilBlockedChain } from "./support/race-lock-waits";
import {
  arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, isDeadlock, pauseIn, previewMerge,
} from "./support/member-merge-race";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** Merge and the stand-in open transactions the race, not Prisma's 5s default, must be allowed to finish. */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4860-";
const ADMIN = `${PREFIX}admin`;
const MASTER = `${PREFIX}master`;
const LOSER = `${PREFIX}loser`;
const LODGE = `${PREFIX}lodge`;
/** Inserted first. Sorts after `mrg-book-a`. */
const EARLIER = "mrg-book-z";
/** Inserted second. Sorts first. */
const LATER = "mrg-book-a";
const CHECK_IN = new Date("2026-06-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-11T00:00:00.000Z");

let prisma: PrismaClient;

type Settled = PromiseSettledResult<unknown>;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function clean() {
  await prisma.booking.deleteMany({ where: { id: { in: [EARLIER, LATER] } } });
  await prisma.lodge.deleteMany({ where: { id: LODGE } });
  await prisma.member.deleteMany({ where: { id: { in: [ADMIN, MASTER, LOSER] } } });
}

async function seed() {
  await createRaceMember(prisma, ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
  await createRaceMember(prisma, MASTER, { canLogin: true });
  await createRaceMember(prisma, LOSER, { canLogin: true });
  await prisma.lodge.create({ data: { id: LODGE, name: "Race 4860 lodge", slug: "race-4860-lodge" } });
  await prisma.booking.create({
    data: {
      id: EARLIER, memberId: LOSER, createdById: ADMIN, lodgeId: LODGE, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      status: "CONFIRMED", totalPriceCents: 1_000, finalPriceCents: 1_000,
    },
  });
  await prisma.booking.create({
    data: {
      id: LATER, memberId: LOSER, createdById: ADMIN, lodgeId: LODGE, checkIn: CHECK_IN, checkOut: CHECK_OUT,
      status: "CONFIRMED", totalPriceCents: 1_000, finalPriceCents: 1_000,
    },
  });
}

/**
 * Hold `heldId` at `lockBookingRowForOwnerRead`'s strength, let `during` run
 * while that is the only booking row this session holds, then update `updatedId`'s
 * notes (not its owner) and commit.
 */
async function holdThenUpdate(
  heldId: string,
  updatedId: string,
  during: (writerPid: number) => Promise<void>,
): Promise<{ written: Settled; merged: Settled }> {
  const merge = await previewMerge(MASTER, LOSER, ADMIN);
  const held = gate();
  const release = gate();
  let writerPid = 0;
  const writing = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${heldId} FOR NO KEY UPDATE`;
    writerPid = await backendPid(tx);
    held.open();
    await release.opened;
    await tx.$executeRaw`UPDATE "Booking" SET "notes" = ${"sibling"} WHERE "id" = ${updatedId}`;
  }, RACE_TRANSACTION_BUDGET);
  await held.opened;
  const merging = merge();
  try {
    await during(writerPid);
  } finally {
    release.open();
  }
  const [written, merged] = await Promise.allSettled([writing, merging]);
  return { written, merged };
}

function expectNoDeadlock(written: Settled, merged: Settled) {
  const reason = (settled: Settled) => (settled.status === "rejected" ? settled.reason : null);
  expect(isDeadlock(reason(written)), String(reason(written))).toBe(false);
  expect(isDeadlock(reason(merged)), String(reason(merged))).toBe(false);
  expectFulfilled(written);
  expectFulfilled(merged);
}

async function expectBothRepointed() {
  const rows = await prisma.booking.findMany({
    where: { id: { in: [EARLIER, LATER] } },
    select: { id: true, memberId: true },
    orderBy: { id: "asc" },
  });
  expect(rows).toEqual([
    { id: LATER, memberId: MASTER },
    { id: EARLIER, memberId: MASTER },
  ]);
}

(RUN ? describe : describe.skip)("member merge and a sibling booking writer (#4860)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4860 merge booking-row race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await clean();
  });

  beforeEach(async () => {
    clearPauses();
    await clean();
    await seed();
  });

  afterAll(async () => {
    clearPauses();
    if (prisma) await clean();
  });

  it("MUTATION: a writer holding the later-inserted booking and then updating the earlier one never deadlocks with the merge: the writer commits and the merge re-points both", async () => {
    const { written, merged } = await holdThenUpdate(LATER, EARLIER, async (writerPid) => {
      await untilBlockedChain(prisma, writerPid);
    });
    expectNoDeadlock(written, merged);
    await expectBothRepointed();
  });

  it("MUTATION: while that writer holds only the later-inserted booking, the merge waits on it and does not hold the earlier one", async () => {
    const { written, merged } = await holdThenUpdate(LATER, EARLIER, async (writerPid) => {
      const [mergePid] = await untilBlockedChain(prisma, writerPid);
      expect(await isBlocking(prisma, mergePid)).toBe(false);
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${EARLIER} FOR UPDATE NOWAIT`;
        });
      } catch (error) {
        throw new Error(`merge held ${EARLIER} while waiting on ${LATER}: ${String(error)}`);
      }
    });
    expectNoDeadlock(written, merged);
    await expectBothRepointed();
  });

  it("a writer holding the earlier-inserted booking and then updating the later one never deadlocks with the merge: both commit", async () => {
    const { written, merged } = await holdThenUpdate(EARLIER, LATER, async (writerPid) => {
      await untilBlockedChain(prisma, writerPid);
    });
    expectNoDeadlock(written, merged);
    await expectBothRepointed();
  });

  it("MUTATION: two sessions locking those two bookings in crossed order still deadlock", async () => {
    const { held, arrived } = await arrivingWhilePaused(
      prisma,
      "crossed",
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${LATER} FOR NO KEY UPDATE`;
        await pauseIn("crossed", tx);
        await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${EARLIER} FOR UPDATE`;
      }, RACE_TRANSACTION_BUDGET),
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${EARLIER} FOR NO KEY UPDATE`;
        await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${LATER} FOR UPDATE`;
      }, RACE_TRANSACTION_BUDGET),
    );
    const dead = [held, arrived].filter((outcome) => outcome.status === "rejected" && isDeadlock(outcome.reason));
    expect(
      dead.length,
      [held, arrived].map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "fulfilled")).join(" | "),
    ).toBeGreaterThan(0);
  });
});
