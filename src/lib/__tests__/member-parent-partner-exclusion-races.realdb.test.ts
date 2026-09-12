/**
 * Real PostgreSQL proofs for #3271/#3292's cross-table pair-state backstop.
 * Imported by concurrency-lock-races.realdb.test.ts and therefore a no-op
 * unless the guarded disposable race database is explicitly enabled.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import {
  MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
  acquireMemberParentPartnerPairLocks,
  hasAnyPartnerRelationship,
  hasDirectParentRelationship,
  isMemberParentPartnerExclusionViolation,
} from "@/lib/member-parent-partner-exclusivity";
import { acquireMemberPartnerLinkLocks } from "@/lib/member-partner-lock";
import { collectPrismaErrorText } from "@/lib/prisma-errors";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-3292-";
const TIMEOUT_MS = 45_000;
const LOCK_POLL_TIMEOUT_MS = 5_000;
const CLIENT_A_NAME = "race-3292-a";
const CLIENT_B_NAME = "race-3292-b";
const HOLDER_NAME = "race-3292-holder";

let prisma: typeof import("@/lib/prisma")["prisma"];
let clientA: PrismaClient;
let clientB: PrismaClient;
let holderClient: PrismaClient;
let rawClient: PgClient;

const id = (suffix: string) => `${PREFIX}${suffix}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedBy(
  waitingApplicationName: string,
  blockingApplicationName: string,
) {
  const startedAt = process.hrtime.bigint();
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity waiter
        INNER JOIN pg_stat_activity blocker
          ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
        WHERE waiter.application_name = ${waitingApplicationName}
          AND waiter.wait_event_type = 'Lock'
          AND blocker.application_name = ${blockingApplicationName}
      ) AS blocked
    `;
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `${waitingApplicationName} did not block behind ${blockingApplicationName}`,
  );
}

function memberRow(suffix: string) {
  return {
    id: id(suffix),
    email: `${id(suffix)}@example.invalid`,
    passwordHash: "not-a-password",
    firstName: "Race",
    lastName: suffix,
  };
}

async function seedMembers(...suffixes: string[]) {
  await prisma.member.createMany({ data: suffixes.map(memberRow) });
}

async function pairState(memberOneId: string, memberTwoId: string) {
  const [memberAId, memberBId] =
    memberOneId < memberTwoId
      ? [memberOneId, memberTwoId]
      : [memberTwoId, memberOneId];
  return prisma.memberParentPartnerExclusion.findUnique({
    where: { memberAId_memberBId: { memberAId, memberBId } },
  });
}

async function appParentWrite(
  client: PrismaClient,
  parentId: string,
  childId: string,
  afterPairLocks?: () => Promise<void>,
): Promise<boolean> {
  try {
    return await client.$transaction(async (tx) => {
      await acquireMemberPartnerLinkLocks(tx, [parentId, childId]);
      await acquireMemberParentPartnerPairLocks(tx, [[parentId, childId]]);
      await afterPairLocks?.();
      if (await hasAnyPartnerRelationship(tx, parentId, childId)) return false;
      await tx.member.update({
        where: { id: childId },
        data: { parentMemberId: parentId },
      });
      return true;
    });
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function appPartnerWrite(
  client: PrismaClient,
  memberOneId: string,
  memberTwoId: string,
  linkId: string,
): Promise<boolean> {
  try {
    return await client.$transaction(async (tx) => {
      await acquireMemberPartnerLinkLocks(tx, [memberOneId, memberTwoId]);
      await acquireMemberParentPartnerPairLocks(tx, [
        [memberOneId, memberTwoId],
      ]);
      if (await hasDirectParentRelationship(tx, memberOneId, memberTwoId)) {
        return false;
      }
      const [memberAId, memberBId] =
        memberOneId < memberTwoId
          ? [memberOneId, memberTwoId]
          : [memberTwoId, memberOneId];
      await tx.memberPartnerLink.create({
        data: {
          id: linkId,
          memberAId,
          memberBId,
          status: "PENDING",
        },
      });
      return true;
    });
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function directParentWrite(
  client: PrismaClient,
  parentId: string,
  childId: string,
): Promise<boolean> {
  try {
    await client.$executeRaw`
      UPDATE "Member"
      SET "parentMemberId" = ${parentId}
      WHERE "id" = ${childId}
    `;
    return true;
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function directPartnerWrite(
  client: PrismaClient,
  memberAId: string,
  memberBId: string,
  linkId: string,
): Promise<boolean> {
  try {
    await client.$executeRaw`
      INSERT INTO "MemberPartnerLink" (
        "id", "memberAId", "memberBId", "status", "updatedAt"
      ) VALUES (${linkId}, ${memberAId}, ${memberBId}, 'PENDING', now())
    `;
    return true;
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function directMultiParentWrite(
  client: PrismaClient,
  firstParentId: string,
  firstChildId: string,
  secondParentId: string,
  secondChildId: string,
): Promise<boolean> {
  try {
    await client.$executeRaw`
      UPDATE "Member"
      SET "parentMemberId" = CASE
        WHEN "id" = ${firstChildId} THEN ${firstParentId}
        WHEN "id" = ${secondChildId} THEN ${secondParentId}
        ELSE "parentMemberId"
      END
      WHERE "id" IN (${firstChildId}, ${secondChildId})
    `;
    return true;
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function directMultiPartnerWrite(
  client: PrismaClient,
  firstMemberAId: string,
  firstMemberBId: string,
  firstLinkId: string,
  secondMemberAId: string,
  secondMemberBId: string,
  secondLinkId: string,
): Promise<boolean> {
  try {
    await client.$executeRaw`
      INSERT INTO "MemberPartnerLink" (
        "id", "memberAId", "memberBId", "status", "updatedAt"
      ) VALUES
        (${firstLinkId}, ${firstMemberAId}, ${firstMemberBId}, 'PENDING', now()),
        (${secondLinkId}, ${secondMemberAId}, ${secondMemberBId}, 'CONFIRMED', now())
    `;
    return true;
  } catch (error) {
    if (isMemberParentPartnerExclusionViolation(error)) return false;
    throw error;
  }
}

async function assertExactlyOneRelationship(
  parentId: string,
  childId: string,
  results: readonly boolean[],
) {
  expect(results.filter(Boolean)).toHaveLength(1);
  const parent = await prisma.member.findUniqueOrThrow({
    where: { id: childId },
    select: { parentMemberId: true },
  });
  const partner = await prisma.memberPartnerLink.count({
    where: {
      OR: [
        { memberAId: parentId, memberBId: childId },
        { memberAId: childId, memberBId: parentId },
      ],
    },
  });
  expect(Number(parent.parentMemberId === parentId) + partner).toBe(1);
}

(RUN ? describe : describe.skip)(
  "member parent/partner exclusion - real PostgreSQL (#3292)",
  { timeout: TIMEOUT_MS },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "parent/partner exclusion");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([
          import("@prisma/client"),
          import("@/lib/prisma-adapter"),
        ]);
      const createClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({
          adapter: createPrismaPgAdapter(url.toString()),
        });
      };
      clientA = createClient(CLIENT_A_NAME);
      clientB = createClient(CLIENT_B_NAME);
      holderClient = createClient(HOLDER_NAME);
      rawClient = new PgClient({ connectionString: RACE_DB_URL });
      await Promise.all([
        clientA.$connect(),
        clientB.$connect(),
        holderClient.$connect(),
        rawClient.connect(),
      ]);
    });

    beforeEach(async () => {
      await prisma.memberPartnerLink.deleteMany({
        where: {
          OR: [
            { id: { startsWith: PREFIX } },
            { memberAId: { startsWith: PREFIX } },
            { memberBId: { startsWith: PREFIX } },
          ],
        },
      });
      await prisma.member.updateMany({
        where: { id: { startsWith: PREFIX } },
        data: { parentMemberId: null, secondaryParentId: null },
      });
      await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.memberParentPartnerExclusion.deleteMany({
        where: {
          OR: [
            { memberAId: { startsWith: PREFIX } },
            { memberBId: { startsWith: PREFIX } },
          ],
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.memberPartnerLink.deleteMany({
        where: { id: { startsWith: PREFIX } },
      });
      await prisma.member.updateMany({
        where: { id: { startsWith: PREFIX } },
        data: { parentMemberId: null, secondaryParentId: null },
      });
      await prisma.member.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await prisma.memberParentPartnerExclusion.deleteMany({
        where: {
          OR: [
            { memberAId: { startsWith: PREFIX } },
            { memberBId: { startsWith: PREFIX } },
          ],
        },
      });
      await Promise.all([
        clientA?.$disconnect(),
        clientB?.$disconnect(),
        holderClient?.$disconnect(),
        rawClient?.end(),
      ]);
    });

    it("nets inserts, endpoint updates, statuses, both parent columns, and deletes", async () => {
      await seedMembers("a", "b", "c", "d", "e");
      await prisma.member.update({
        where: { id: id("b") },
        data: { parentMemberId: id("a"), secondaryParentId: id("a") },
      });
      expect(await pairState(id("a"), id("b"))).toMatchObject({
        parentLinkCount: 2,
        partnerLinkCount: 0,
      });

      await prisma.member.update({
        where: { id: id("b") },
        data: { secondaryParentId: id("c") },
      });
      expect(await pairState(id("a"), id("b"))).toMatchObject({
        parentLinkCount: 1,
      });
      expect(await pairState(id("b"), id("c"))).toMatchObject({
        parentLinkCount: 1,
      });

      await prisma.memberPartnerLink.create({
        data: {
          id: id("link-cd"),
          memberAId: id("c"),
          memberBId: id("d"),
          status: "PENDING",
        },
      });
      await prisma.memberPartnerLink.update({
        where: { id: id("link-cd") },
        data: { status: "CONFIRMED", memberAId: id("d"), memberBId: id("e") },
      });
      expect(await pairState(id("c"), id("d"))).toBeNull();
      expect(await pairState(id("d"), id("e"))).toMatchObject({
        parentLinkCount: 0,
        partnerLinkCount: 1,
      });
      await prisma.memberPartnerLink.delete({ where: { id: id("link-cd") } });
      expect(await pairState(id("d"), id("e"))).toBeNull();

      await prisma.member.update({
        where: { id: id("b") },
        data: { parentMemberId: null, secondaryParentId: null },
      });
      expect(await pairState(id("a"), id("b"))).toBeNull();
      expect(await pairState(id("b"), id("c"))).toBeNull();
    });

    it("sanitizes both orientations, columns, and partner statuses", async () => {
      const cases = [
        ["primary-forward", "parentMemberId", "PENDING", false],
        ["secondary-forward", "secondaryParentId", "CONFIRMED", false],
        ["primary-reverse", "parentMemberId", "CONFIRMED", true],
        ["secondary-reverse", "secondaryParentId", "PENDING", true],
      ] as const;

      for (const [suffix, column, status, reverse] of cases) {
        const memberAId = id(`${suffix}-a`);
        const memberBId = id(`${suffix}-b`);
        await prisma.member.createMany({
          data: [memberRow(`${suffix}-a`), memberRow(`${suffix}-b`)],
        });
        await prisma.memberPartnerLink.create({
          data: {
            id: id(`${suffix}-link`),
            memberAId,
            memberBId,
            status,
          },
        });

        const childId = reverse ? memberAId : memberBId;
        const parentId = reverse ? memberBId : memberAId;
        let caught: unknown;
        try {
          await prisma.member.update({
            where: { id: childId },
            data: { [column]: parentId } as Prisma.MemberUncheckedUpdateInput,
          });
        } catch (error) {
          caught = error;
        }
        expect(isMemberParentPartnerExclusionViolation(caught)).toBe(true);
        const serialized = `${collectPrismaErrorText(caught)}\n${JSON.stringify(caught)}`;
        expect(serialized).toContain(
          MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
        );
        expect(serialized).not.toContain(memberAId);
        expect(serialized).not.toContain(memberBId);
        expect(serialized).not.toContain("Failing row contains");
      }

      const rawMemberAId = id("primary-forward-a");
      const rawMemberBId = id("primary-forward-b");
      let rawError: Record<string, unknown> | undefined;
      try {
        await rawClient.query(
          `UPDATE "Member" SET "parentMemberId" = $1 WHERE "id" = $2`,
          [rawMemberAId, rawMemberBId],
        );
      } catch (error) {
        rawError = error as Record<string, unknown>;
      }
      expect(rawError).toMatchObject({
        code: "23514",
        message: MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
        constraint: MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
      });
      expect(rawError?.detail).toBeUndefined();
      expect(rawError?.hint).toBeUndefined();
      expect(
        [rawError?.message, rawError?.detail, rawError?.hint].join("\n"),
      ).not.toContain(rawMemberAId);
      expect(
        [rawError?.message, rawError?.detail, rawError?.hint].join("\n"),
      ).not.toContain(rawMemberBId);
    });

    it("rejects partner inserts and endpoint updates when parentage wins first", async () => {
      await seedMembers("winner-parent", "winner-child", "other-a", "other-b");
      await prisma.member.update({
        where: { id: id("winner-child") },
        data: { secondaryParentId: id("winner-parent") },
      });

      for (const status of ["PENDING", "CONFIRMED"] as const) {
        let caught: unknown;
        try {
          await prisma.memberPartnerLink.create({
            data: {
              id: id(`parent-first-${status.toLowerCase()}`),
              memberAId: id("winner-child"),
              memberBId: id("winner-parent"),
              status,
            },
          });
        } catch (error) {
          caught = error;
        }
        expect(isMemberParentPartnerExclusionViolation(caught)).toBe(true);
      }

      await prisma.memberPartnerLink.create({
        data: {
          id: id("endpoint-link"),
          memberAId: id("other-a"),
          memberBId: id("other-b"),
          status: "PENDING",
        },
      });
      await expect(
        prisma.memberPartnerLink.update({
          where: { id: id("endpoint-link") },
          data: {
            memberAId: id("winner-child"),
            memberBId: id("winner-parent"),
          },
        }),
      ).rejects.toSatisfy(isMemberParentPartnerExclusionViolation);
      expect(await pairState(id("other-a"), id("other-b"))).toMatchObject({
        partnerLinkCount: 1,
      });
      expect(await pairState(id("winner-child"), id("winner-parent"))).toMatchObject({
        parentLinkCount: 1,
        partnerLinkCount: 0,
      });
    });

    it("recovers through unlink and removes no-op serialization rows at commit", async () => {
      await seedMembers("recover-a", "recover-b");
      await prisma.member.update({
        where: { id: id("recover-b") },
        data: { parentMemberId: id("recover-a") },
      });
      await prisma.member.update({
        where: { id: id("recover-b") },
        data: { parentMemberId: null },
      });
      await prisma.memberPartnerLink.create({
        data: {
          id: id("recover-link"),
          memberAId: id("recover-a"),
          memberBId: id("recover-b"),
          status: "PENDING",
        },
      });
      expect(await pairState(id("recover-a"), id("recover-b"))).toMatchObject({
        parentLinkCount: 0,
        partnerLinkCount: 1,
      });

      await seedMembers("noop-a", "noop-b");
      await prisma.$transaction((tx) =>
        acquireMemberParentPartnerPairLocks(tx, [[id("noop-b"), id("noop-a")]]),
      );
      expect(await pairState(id("noop-a"), id("noop-b"))).toBeNull();
    });

    it("tracks multi-row parent changes, member-id cascades, and member deletion", async () => {
      await seedMembers("cascade-a", "cascade-b", "cascade-c", "cascade-d");
      await prisma.$executeRaw`
        UPDATE "Member"
        SET "parentMemberId" = ${id("cascade-a")}
        WHERE "id" IN (${id("cascade-b")}, ${id("cascade-c")})
      `;
      await prisma.memberPartnerLink.create({
        data: {
          id: id("cascade-link"),
          memberAId: id("cascade-a"),
          memberBId: id("cascade-d"),
          status: "CONFIRMED",
        },
      });

      await prisma.$executeRaw`
        UPDATE "Member"
        SET "id" = ${id("cascade-0")}
        WHERE "id" = ${id("cascade-a")}
      `;
      expect(await pairState(id("cascade-a"), id("cascade-b"))).toBeNull();
      expect(await pairState(id("cascade-b"), id("cascade-0"))).toMatchObject({
        parentLinkCount: 1,
      });
      expect(await pairState(id("cascade-d"), id("cascade-0"))).toMatchObject({
        partnerLinkCount: 1,
      });

      await prisma.member.delete({ where: { id: id("cascade-0") } });
      const leftovers = await prisma.memberParentPartnerExclusion.count({
        where: {
          OR: [
            { memberAId: id("cascade-0") },
            { memberBId: id("cascade-0") },
          ],
        },
      });
      expect(leftovers).toBe(0);
    });

    it("lets exactly one application relationship type commit", async () => {
      await seedMembers("app-a", "app-b");
      const firstWriterReachedPair = deferred();
      const releaseFirstWriter = deferred();
      const parentWrite = appParentWrite(
        clientA,
        id("app-a"),
        id("app-b"),
        async () => {
          firstWriterReachedPair.resolve();
          await releaseFirstWriter.promise;
        },
      );
      await firstWriterReachedPair.promise;
      const partnerWrite = appPartnerWrite(
        clientB,
        id("app-a"),
        id("app-b"),
        id("app-link"),
      );
      let contentionError: unknown;
      try {
        await waitForBlockedBy(CLIENT_B_NAME, CLIENT_A_NAME);
      } catch (error) {
        contentionError = error;
      } finally {
        releaseFirstWriter.resolve();
      }
      const results = await Promise.all([parentWrite, partnerWrite]);
      if (contentionError) throw contentionError;
      await assertExactlyOneRelationship(id("app-a"), id("app-b"), results);
    });

    it("lets exactly one type commit against direct-SQL bypasses in both directions", async () => {
      await seedMembers("bypass-a", "bypass-b");
      const first = await Promise.all([
        appParentWrite(clientA, id("bypass-a"), id("bypass-b")),
        directPartnerWrite(
          clientB,
          id("bypass-a"),
          id("bypass-b"),
          id("bypass-link"),
        ),
      ]);
      await assertExactlyOneRelationship(id("bypass-a"), id("bypass-b"), first);

      await prisma.memberPartnerLink.deleteMany({
        where: { id: id("bypass-link") },
      });
      await prisma.member.update({
        where: { id: id("bypass-b") },
        data: { parentMemberId: null },
      });
      const second = await Promise.all([
        appPartnerWrite(
          clientA,
          id("bypass-a"),
          id("bypass-b"),
          id("bypass-link-2"),
        ),
        directParentWrite(clientB, id("bypass-a"), id("bypass-b")),
      ]);
      await assertExactlyOneRelationship(id("bypass-a"), id("bypass-b"), second);
    });

    it("makes two direct-SQL writers serialize through the pair primary key", async () => {
      await seedMembers("direct-a", "direct-b");
      const results = await Promise.all([
        directParentWrite(clientA, id("direct-a"), id("direct-b")),
        directPartnerWrite(
          clientB,
          id("direct-a"),
          id("direct-b"),
          id("direct-link"),
        ),
      ]);
      await assertExactlyOneRelationship(id("direct-a"), id("direct-b"), results);
    });

    it("serializes opposing multi-row source statements in canonical pair order", async () => {
      await seedMembers("multi-a", "multi-b", "multi-c", "multi-d");
      const firstPairHeld = deferred();
      const releaseFirstPair = deferred();
      const holder = holderClient.$transaction(async (tx) => {
        await acquireMemberParentPartnerPairLocks(tx, [
          [id("multi-a"), id("multi-b")],
        ]);
        firstPairHeld.resolve();
        await releaseFirstPair.promise;
      });
      await firstPairHeld.promise;

      const parentWrite = directMultiParentWrite(
        clientA,
        id("multi-a"),
        id("multi-b"),
        id("multi-c"),
        id("multi-d"),
      );
      // Present the partner pairs in the opposite order. Both statement
      // triggers must still queue on the held first canonical pair before the
      // holder releases it; otherwise the reversed writer can take C/D first
      // and deadlock with the A/B-first writer after release.
      const partnerWrite = directMultiPartnerWrite(
        clientB,
        id("multi-c"),
        id("multi-d"),
        id("multi-link-cd"),
        id("multi-a"),
        id("multi-b"),
        id("multi-link-ab"),
      );
      let contentionError: unknown;
      try {
        await Promise.all([
          waitForBlockedBy(CLIENT_A_NAME, HOLDER_NAME),
          waitForBlockedBy(CLIENT_B_NAME, HOLDER_NAME),
        ]);
      } catch (error) {
        contentionError = error;
      } finally {
        releaseFirstPair.resolve();
      }
      const [results] = await Promise.all([
        Promise.all([parentWrite, partnerWrite]),
        holder,
      ]);
      if (contentionError) throw contentionError;

      expect(results.filter(Boolean)).toHaveLength(1);
      const children = await prisma.member.findMany({
        where: { id: { in: [id("multi-b"), id("multi-d")] } },
        orderBy: { id: "asc" },
        select: { id: true, parentMemberId: true },
      });
      const partnerCount = await prisma.memberPartnerLink.count({
        where: { id: { in: [id("multi-link-ab"), id("multi-link-cd")] } },
      });
      if (results[0]) {
        expect(children).toEqual([
          { id: id("multi-b"), parentMemberId: id("multi-a") },
          { id: id("multi-d"), parentMemberId: id("multi-c") },
        ]);
        expect(partnerCount).toBe(0);
      } else {
        expect(children).toEqual([
          { id: id("multi-b"), parentMemberId: null },
          { id: id("multi-d"), parentMemberId: null },
        ]);
        expect(partnerCount).toBe(2);
      }
      for (const [memberAId, memberBId] of [
        [id("multi-a"), id("multi-b")],
        [id("multi-c"), id("multi-d")],
      ] as const) {
        expect(await pairState(memberAId, memberBId)).toMatchObject(
          results[0]
            ? { parentLinkCount: 1, partnerLinkCount: 0 }
            : { parentLinkCount: 0, partnerLinkCount: 1 },
        );
      }
    });

    it("locks opposing raw pair lists in one canonical order without deadlock", async () => {
      await seedMembers("order-a", "order-b", "order-c", "order-d");
      // Keep the later C/D pair materialized so a NOWAIT row lock can prove
      // neither contender reached it while both are queued on held A/B.
      await prisma.member.update({
        where: { id: id("order-d") },
        data: { parentMemberId: id("order-c") },
      });
      const firstPairHeld = deferred();
      const releaseFirstPair = deferred();
      const holder = holderClient.$transaction(async (tx) => {
        await acquireMemberParentPartnerPairLocks(tx, [
          [id("order-a"), id("order-b")],
        ]);
        firstPairHeld.resolve();
        await releaseFirstPair.promise;
      });
      await firstPairHeld.promise;

      const writerA = clientA.$transaction(async (tx) => {
        await acquireMemberParentPartnerPairLocks(tx, [
          [id("order-d"), id("order-c")],
          [id("order-b"), id("order-a")],
        ]);
        return "a";
      });
      const writerB = clientB.$transaction(async (tx) => {
        await acquireMemberParentPartnerPairLocks(tx, [
          [id("order-a"), id("order-b")],
          [id("order-c"), id("order-d")],
        ]);
        return "b";
      });
      let contentionError: unknown;
      try {
        await Promise.all([
          waitForBlockedBy(CLIENT_A_NAME, HOLDER_NAME),
          waitForBlockedBy(CLIENT_B_NAME, HOLDER_NAME),
        ]);
        await prisma.$transaction((tx) => tx.$queryRaw`
          SELECT "memberAId"
          FROM "MemberParentPartnerExclusion"
          WHERE "memberAId" = ${id("order-c")}
            AND "memberBId" = ${id("order-d")}
          FOR UPDATE NOWAIT
        `);
      } catch (error) {
        contentionError = error;
      } finally {
        releaseFirstPair.resolve();
      }
      const [result] = await Promise.all([
        Promise.all([writerA, writerB]),
        holder,
      ]);
      if (contentionError) throw contentionError;
      expect(result).toEqual(["a", "b"]);
    });
  },
);
