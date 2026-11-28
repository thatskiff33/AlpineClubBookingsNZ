/**
 * #5540 against real PostgreSQL: a Full Admin's unarchive racing the writers
 * that change the same member's archive.
 *
 * The unarchive takes the member's `member-lifecycle:<memberId>` key, the key
 * archive approval already holds (INV-LOCK-001..003), then re-reads the member
 * and claims `archivedAt` with a guarded update. So:
 *
 * - an archive approval holding the key makes the unarchive wait; once the
 *   approval commits, the unarchive sees the archive and clears it. Without the
 *   key the unarchive would read the pre-approval row, find nothing archived and
 *   refuse, so the case fails if the lock goes;
 * - two unarchives of one member serialise on the key: the second waits, then
 *   finds the member no longer archived and refuses with nothing written.
 *
 * Each holder pauses inside its transaction at a named slot
 * (`support/member-merge-race.ts`), and every wait is matched to the backend it
 * waits on. Ordinary Vitest runs skip the file; CI's `realdb-all` job runs it
 * against the guarded loopback race database.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { arrivingWhilePaused, clearPauses, createRaceMember, expectFulfilled, isDeadlock } from "./support/member-merge-race";

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

/** Slot "archive": inside the approval, after its claim and archive write, holding the member's key. */
vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/adult-member-hosting-review");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    enqueueHostingCoverageReevaluationForMember: async (
      ...args: Parameters<typeof real.enqueueHostingCoverageReevaluationForMember>
    ) => {
      await pauseIn("archive", args[1]);
      return real.enqueueHostingCoverageReevaluationForMember(...args);
    },
  };
});

/** Slot "unarchive": inside the unarchive, just after it takes the member's key. */
vi.mock("@/lib/member-lifecycle-lock", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/member-lifecycle-lock");
  const { pauseIn } = await import("./support/member-merge-race");
  return {
    ...real,
    acquireMemberLifecycleLocks: async (...args: Parameters<typeof real.acquireMemberLifecycleLocks>) => {
      await real.acquireMemberLifecycleLocks(...args);
      await pauseIn("unarchive", args[0]);
    },
  };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-5540-unarchive-";
const REQUESTER = `${PREFIX}admin-requester`;
const APPROVER = `${PREFIX}admin-approver`;
const FULL_A = `${PREFIX}admin-full-a`;
const FULL_B = `${PREFIX}admin-full-b`;
const CANCELLED_AT = new Date("2026-05-01T00:00:00.000Z");
let prisma: PrismaClient;

/** A member whose membership is cancelled: inactive, login off, as every archive target is. */
async function cancelledMember(id: string, extra: Record<string, unknown> = {}) {
  await createRaceMember(prisma, id, { firstName: "Unarchive", active: false, canLogin: false, cancelledAt: CANCELLED_AT, cancelledReason: "Moved away", ...extra });
}

async function unarchive(memberId: string, actorMemberId: string) {
  const { unarchiveMember } = await import("@/lib/member-unarchive");
  return unarchiveMember({ memberId, actorMemberId, reason: "Archived by mistake" });
}

async function lifecycleRows(memberId: string) {
  return prisma.memberLifecycleActionRequest.findMany({
    where: { memberId },
    orderBy: { requestedAt: "asc" },
    select: { action: true, status: true },
  });
}

async function memberState(id: string) {
  return prisma.member.findUniqueOrThrow({
    where: { id },
    select: { archivedAt: true, archivedViaLifecycleActionRequestId: true, cancelledAt: true, active: true, canLogin: true },
  });
}

(RUN ? describe : describe.skip)("a Full Admin's unarchive racing the member's archive writers (#5540)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "#5540 unarchive race");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    await cleanup();
    for (const admin of [REQUESTER, APPROVER, FULL_A, FULL_B]) {
      await createRaceMember(prisma, admin, { role: "ADMIN", canLogin: true, accessRoles: { create: { role: "ADMIN" } } });
    }
  }, 120_000);

  afterAll(async () => {
    clearPauses();
    if (prisma) await cleanup();
  }, 120_000);

  async function cleanup() {
    const members = { startsWith: PREFIX };
    await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: members }, { actorMemberId: members }, { targetId: members }, { subjectMemberId: members }] } });
    await prisma.member.updateMany({ where: { id: members }, data: { archivedViaLifecycleActionRequestId: null } });
    await prisma.memberLifecycleActionRequest.deleteMany({ where: { OR: [{ memberId: members }, { requestedByMemberId: members }] } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: members } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: members } });
    await prisma.member.deleteMany({ where: { id: members } });
  }

  it("MUTATION: an archive approval holding the member's key makes the unarchive wait; the unarchive then clears that archive", async () => {
    const memberId = `${PREFIX}member-approval`;
    await cancelledMember(memberId);
    const lifecycle = await import("@/lib/member-lifecycle-actions");
    const { request } = await lifecycle.createMemberArchiveRequest({ memberId, requestedByMemberId: REQUESTER, reason: "Left the club" });
    const approve = () => lifecycle.reviewMemberArchiveRequest({ requestId: request.id, reviewedByMemberId: APPROVER, action: "approve", notifyMember: false });

    const { held: approved, arrived: unarchived } = await arrivingWhilePaused(prisma, "archive", approve, () => unarchive(memberId, FULL_A));

    expectFulfilled(approved);
    expectFulfilled(unarchived);
    // Cleared, and still cancelled: unarchive reverses the archive only.
    expect(await memberState(memberId)).toEqual({ archivedAt: null, archivedViaLifecycleActionRequestId: null, cancelledAt: CANCELLED_AT, active: false, canLogin: false });
    // Both events stay on the record, in order.
    expect(await lifecycleRows(memberId)).toEqual([
      { action: "ARCHIVE", status: "APPROVED" },
      { action: "UNARCHIVE", status: "APPROVED" },
    ]);
    const audits = await prisma.auditLog.findMany({ where: { subjectMemberId: memberId }, orderBy: { createdAt: "asc" }, select: { action: true } });
    expect(audits.map((row) => row.action)).toEqual([
      "member_lifecycle.archive_requested",
      "member_lifecycle.archive_approved",
      "member_lifecycle.unarchived",
    ]);
  });

  it("MUTATION: a second unarchive waits on the first's key, then refuses with 409 and writes nothing", async () => {
    const memberId = `${PREFIX}member-double`;
    await cancelledMember(memberId, { archivedAt: new Date("2026-06-01T00:00:00.000Z"), archivedReason: "Left the club" });

    const { held: first, arrived: second } = await arrivingWhilePaused(prisma, "unarchive", () => unarchive(memberId, FULL_A), () => unarchive(memberId, FULL_B));

    expectFulfilled(first);
    expect(second.status).toBe("rejected");
    const reason = (second as PromiseRejectedResult).reason;
    expect(isDeadlock(reason), String(reason)).toBe(false);
    expect(reason).toMatchObject({ name: "MemberLifecycleActionError", statusCode: 409, message: "This member is not archived." });
    expect((await memberState(memberId)).archivedAt).toBeNull();
    expect(await lifecycleRows(memberId)).toEqual([{ action: "UNARCHIVE", status: "APPROVED" }]);
    expect(await prisma.auditLog.count({ where: { subjectMemberId: memberId, action: "member_lifecycle.unarchived" } })).toBe(1);
  });
});
