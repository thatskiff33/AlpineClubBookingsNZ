/**
 * #4876 against real PostgreSQL: a writer that already holds a key share on a
 * merge participant, then updates a row the merge re-points.
 *
 * An UPDATE locks its target before it takes foreign-key key shares, so a
 * claim-style write never starts this cycle. The sign-off does: its insert
 * takes a key share on the signer, and a completing hut-leader induction then
 * updates the inductee and the induction the merge moves. The allocation case
 * is the same shape with the key share taken first and the moved row second.
 *
 * Merge used to hold that moved row while it waited for the signer's Member
 * row. It now rolls the move back before the wait
 * (`withMemberMergeParticipantRows`), so the writer commits and the merge
 * either commits or returns its 409. Two probes restore the old orders and
 * both deadlock.
 *
 * Ordinary Vitest runs skip the database cases; CI's real-PostgreSQL job runs
 * them against the guarded loopback race database.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { RACE_TRANSACTION_BUDGET } from "./support/race-lock-waits";
import {
  arrivingWhilePaused, clearPauses, createRaceMember, isDeadlock, keyShareOnMember, pauseIn, previewMerge,
  writerArrivingWhileMergeIsParked,
} from "./support/member-merge-race";

vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The sign-off opens its transaction with no options: give it a budget the race, not the runner, decides. */
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/prisma");
  const { withRaceTransactionBudget } = await import("./support/race-lock-waits");
  return { ...real, prisma: withRaceTransactionBudget(real.prisma) };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4876-";
const ADMIN = `${PREFIX}admin`;
/** `x1` sorts before `x2` in merge's Member statement. The signer is the survivor. */
const MASTER = `${PREFIX}x1-master`;
const LOSER = `${PREFIX}x2-loser`;
const OWNER = `${PREFIX}owner`;
const TEMPLATE = `${PREFIX}template`;
const INDUCTION = `${PREFIX}induction`;
const LODGE = `${PREFIX}lodge`;
const ROOM = `${PREFIX}room`;
const BED = `${PREFIX}bed`;
const BOOKING = `${PREFIX}booking`;
const GUEST = `${PREFIX}guest`;
const ALLOCATION = `${PREFIX}allocation`;
const STAY = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-11T00:00:00.000Z");

let prisma: PrismaClient;

type Settled = PromiseSettledResult<unknown>;

function expectNoDeadlock(...outcomes: Settled[]) {
  for (const outcome of outcomes) {
    const reason = outcome.status === "rejected" ? outcome.reason : null;
    expect(isDeadlock(reason), String(reason)).toBe(false);
  }
}

/** The writer committed. The merge committed, or refused with its 409. Neither died on a deadlock. */
function expectWriterKeptAndMergeClean(written: Settled, merged: Settled) {
  expectNoDeadlock(written, merged);
  expect(written.status, written.status === "rejected" ? String(written.reason) : "").toBe("fulfilled");
  if (merged.status === "rejected") {
    expect(merged.reason).toMatchObject({ statusCode: 409 });
  } else {
    expect(merged.status).toBe("fulfilled");
  }
}

function expectOneDeadlock(held: Settled, arrived: Settled) {
  const dead = [held, arrived].filter((outcome) => outcome.status === "rejected" && isDeadlock(outcome.reason));
  expect(dead.length, [held, arrived].map((outcome) => outcome.status === "rejected" ? String(outcome.reason) : "fulfilled").join(" | ")).toBeGreaterThan(0);
}

async function clean() {
  await prisma.booking.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.lodgeBed.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.lodgeRoom.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.lodge.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.inductionChecklistTemplate.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function seedParties() {
  await createRaceMember(prisma, ADMIN, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
  await createRaceMember(prisma, MASTER, { canLogin: true });
  await createRaceMember(prisma, LOSER, { canLogin: true });
  await prisma.inductionChecklistTemplate.create({
    data: { id: TEMPLATE, name: "Race 4876 hut leader", version: "race-4876", kind: "HUT_LEADER", isActive: true },
  });
  await prisma.memberInduction.create({
    data: {
      id: INDUCTION, memberId: LOSER, templateId: TEMPLATE, kind: "HUT_LEADER", status: "IN_PROGRESS", requiredSignOffs: 1,
    },
  });
}

/** The three writes a completing hut-leader sign-off makes, in `addSignOff`'s order, stopped after the insert. */
function completingSignOff(tx: Prisma.TransactionClient) {
  return (async () => {
    await tx.memberInductionSignOff.create({
      data: {
        inductionId: INDUCTION, signerMemberId: MASTER, signerName: "Race Signer", signerRole: "HUT_LEADER",
        declarationAccepted: true,
      },
    });
    await pauseIn("afterSignOffInsert", tx);
    await tx.member.update({
      where: { id: LOSER },
      data: { hutLeaderEligible: true, hutLeaderEligibleAt: new Date("2026-07-01T00:00:00.000Z") },
    });
    await tx.memberInduction.update({
      where: { id: INDUCTION },
      data: { status: "COMPLETED", completedAt: new Date("2026-07-01T00:00:00.000Z"), completionSource: "SIGN_OFFS" },
    });
  })();
}

(RUN ? describe : describe.skip)("a writer holding a participant key share and then a row merge moves (#4876)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#4876 merge moved-row race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await clean();
  });

  beforeEach(async () => {
    clearPauses();
    await clean();
    await seedParties();
  });

  afterAll(async () => {
    clearPauses();
    if (prisma) await clean();
  });

  it("(a) a completing hut-leader sign-off holding the signer's key share commits, and the merge commits or refuses cleanly", async () => {
    const merge = await previewMerge(MASTER, LOSER, ADMIN);
    const { held, arrived } = await arrivingWhilePaused(
      prisma,
      "afterSignOffInsert",
      () => prisma.$transaction((tx) => completingSignOff(tx), RACE_TRANSACTION_BUDGET),
      merge,
    );
    expectWriterKeptAndMergeClean(held, arrived);
    expect(await prisma.memberInductionSignOff.count({ where: { inductionId: INDUCTION, signerMemberId: MASTER } })).toBe(1);
    const induction = await prisma.memberInduction.findUniqueOrThrow({ where: { id: INDUCTION }, select: { status: true } });
    expect(induction.status).toBe("COMPLETED");
  });

  it("(b) a completing hut-leader sign-off started while the merge waits on the signer commits, and the merge commits or refuses cleanly", async () => {
    const merge = await previewMerge(MASTER, LOSER, ADMIN);
    const { addSignOff } = await import("@/lib/induction");
    const { merged, written, writerFirst } = await writerArrivingWhileMergeIsParked(
      prisma,
      keyShareOnMember(MASTER),
      merge,
      () => addSignOff({
        inductionId: INDUCTION, signerMemberId: MASTER, signerName: "Race Signer", signerRole: "HUT_LEADER",
        declarationAccepted: true,
      }),
      { writer: "queuesOrFinishes" },
    );
    expect(writerFirst).toBe("settled");
    expectWriterKeptAndMergeClean(written, merged);
    expect(await prisma.memberInductionSignOff.count({ where: { inductionId: INDUCTION, signerMemberId: MASTER } })).toBe(1);
  });

  it("an allocation rewrite that already holds the approver's key share commits, and the merge commits or refuses cleanly", async () => {
    await createRaceMember(prisma, OWNER, { canLogin: true });
    await prisma.lodge.create({ data: { id: LODGE, name: "Race 4876 lodge", slug: "race-4876-lodge" } });
    await prisma.lodgeRoom.create({ data: { id: ROOM, lodgeId: LODGE, name: "Race 4876 room" } });
    await prisma.lodgeBed.create({ data: { id: BED, roomId: ROOM, name: "A", bedType: "SINGLE", sortOrder: 0 } });
    await prisma.booking.create({
      data: {
        id: BOOKING, memberId: OWNER, createdById: OWNER, lodgeId: LODGE, checkIn: STAY, checkOut: CHECK_OUT,
        status: "CONFIRMED", totalPriceCents: 1_000, finalPriceCents: 1_000,
      },
    });
    await prisma.bookingGuest.create({
      data: {
        id: GUEST, bookingId: BOOKING, firstName: "Staying", lastName: "Guest", ageTier: "ADULT", isMember: false,
        stayStart: STAY, stayEnd: CHECK_OUT, priceCents: 1_000,
      },
    });
    await prisma.bedAllocation.create({
      data: {
        id: ALLOCATION, bookingId: BOOKING, bookingGuestId: GUEST, roomId: ROOM, bedId: BED, stayDate: STAY,
        source: "MANUAL", approvedByMemberId: LOSER, approvedAt: null,
      },
    });
    const { approveBedAllocationsWithLocksHeld } = await import("@/lib/bed-allocation-approval");
    const merge = await previewMerge(MASTER, LOSER, ADMIN);
    const { held, arrived } = await arrivingWhilePaused(
      prisma,
      "afterApproverShare",
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${MASTER} FOR KEY SHARE`;
        await pauseIn("afterApproverShare", tx);
        await approveBedAllocationsWithLocksHeld({ approvedByMemberId: MASTER, allocationIds: [ALLOCATION], db: tx });
      }, RACE_TRANSACTION_BUDGET),
      merge,
    );
    expectWriterKeptAndMergeClean(held, arrived);
    const allocation = await prisma.bedAllocation.findUniqueOrThrow({
      where: { id: ALLOCATION },
      select: { approvedByMemberId: true, approvedAt: true },
    });
    expect(allocation.approvedByMemberId).toBe(MASTER);
    expect(allocation.approvedAt).not.toBeNull();
  });

  it("MUTATION: waiting for a Member row while still holding the moved induction deadlocks the sign-off", async () => {
    const { held, arrived } = await arrivingWhilePaused(
      prisma,
      "afterSignOffInsert",
      () => prisma.$transaction((tx) => completingSignOff(tx), RACE_TRANSACTION_BUDGET),
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "MemberInduction" SET "memberId" = ${MASTER} WHERE "id" = ${INDUCTION} AND "memberId" = ${LOSER}`;
        await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${MASTER} FOR UPDATE`;
      }, RACE_TRANSACTION_BUDGET),
    );
    expectOneDeadlock(held, arrived);
  });

  it("MUTATION: rolling back the Member locks but not the moved induction still deadlocks the sign-off", async () => {
    const { held, arrived } = await arrivingWhilePaused(
      prisma,
      "afterSignOffInsert",
      () => prisma.$transaction((tx) => completingSignOff(tx), RACE_TRANSACTION_BUDGET),
      () => prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "MemberInduction" SET "memberId" = ${MASTER} WHERE "id" = ${INDUCTION} AND "memberId" = ${LOSER}`;
        await tx.$executeRaw`SAVEPOINT member_merge_partial`;
        await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${LOSER} FOR UPDATE SKIP LOCKED`;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT member_merge_partial`;
        await tx.$executeRaw`SELECT 1 FROM "Member" WHERE "id" = ${MASTER} FOR UPDATE`;
      }, RACE_TRANSACTION_BUDGET),
    );
    expectOneDeadlock(held, arrived);
  });
});
