/**
 * Real PostgreSQL proofs for #3271/#3292's cross-table pair-state backstop.
 * Imported by concurrency-lock-races.realdb.test.ts and therefore a no-op
 * unless the guarded disposable race database is explicitly enabled.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import {
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

let prisma: typeof import("@/lib/prisma")["prisma"];
let clientA: PrismaClient;
let clientB: PrismaClient;

const id = (suffix: string) => `${PREFIX}${suffix}`;

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
): Promise<boolean> {
  try {
    return await client.$transaction(async (tx) => {
      await acquireMemberPartnerLinkLocks(tx, [parentId, childId]);
      await acquireMemberParentPartnerPairLocks(tx, [[parentId, childId]]);
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
      clientA = createClient("race-3292-a");
      clientB = createClient("race-3292-b");
      await Promise.all([clientA.$connect(), clientB.$connect()]);
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
      await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]);
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
      const results = await Promise.all([
        appParentWrite(clientA, id("app-a"), id("app-b")),
        appPartnerWrite(clientB, id("app-a"), id("app-b"), id("app-link")),
      ]);
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

    it("locks opposing raw pair lists in one canonical order without deadlock", async () => {
      await seedMembers("order-a", "order-b", "order-c", "order-d");
      const result = await Promise.all([
        clientA.$transaction(async (tx) => {
          await acquireMemberParentPartnerPairLocks(tx, [
            [id("order-d"), id("order-c")],
            [id("order-b"), id("order-a")],
          ]);
          return "a";
        }),
        clientB.$transaction(async (tx) => {
          await acquireMemberParentPartnerPairLocks(tx, [
            [id("order-a"), id("order-b")],
            [id("order-c"), id("order-d")],
          ]);
          return "b";
        }),
      ]);
      expect(result).toEqual(["a", "b"]);
    });
  },
);
