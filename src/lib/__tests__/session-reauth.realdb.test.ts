/**
 * Real-PostgreSQL proof that one reauthentication challenge can be consumed
 * only once (#4616).
 *
 * `consumeSessionReauthChallenge` is one `updateMany` guarded on
 * `consumedAt` null. Two concurrent consumers of the same token must produce
 * one success. A replay, an expired row and another member's claim match
 * nothing. No advisory lock.
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker). The race harness imports this file.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Session reauth challenge (#4616)";
const MEMBER_A = "race-4616-member-a";
const MEMBER_B = "race-4616-member-b";

const savedAuthSecret: { saved: boolean; value: string | undefined } = {
  saved: false,
  value: undefined,
};

let prisma: PrismaClient;
let reauth: typeof import("@/lib/session-reauth");

(RUN ? describe : describe.skip)(
  "session reauth challenge consumption — real PostgreSQL (#4616)",
  { timeout: 20_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      savedAuthSecret.value = process.env.AUTH_SECRET;
      savedAuthSecret.saved = true;
      process.env.AUTH_SECRET ??= "session-reauth-race-secret";

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      const client = (name: string) => {
        const own = new URL(url.toString());
        own.searchParams.set("application_name", name);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(own.toString()) });
      };
      prisma = client("race-4616");
      await prisma.$connect();
      reauth = await import("@/lib/session-reauth");

      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_A, MEMBER_B] } } });
      await prisma.member.createMany({
        data: [
          {
            id: MEMBER_A,
            email: "race-4616-a@example.invalid",
            firstName: "Race",
            lastName: "One",
            passwordHash: "not-a-real-password",
          },
          {
            id: MEMBER_B,
            email: "race-4616-b@example.invalid",
            firstName: "Race",
            lastName: "Two",
            passwordHash: "not-a-real-password",
          },
        ],
      });
    }, 60_000);

    afterAll(async () => {
      if (prisma) {
        await prisma.member
          .deleteMany({ where: { id: { in: [MEMBER_A, MEMBER_B] } } })
          .catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
      if (savedAuthSecret.saved) {
        if (savedAuthSecret.value === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = savedAuthSecret.value;
      }
    }, 60_000);

    async function mint() {
      return reauth.createSessionReauthChallenge(MEMBER_A);
    }

    it("lets one of two concurrent consumes succeed", async () => {
      const token = await mint();
      const [first, second] = await Promise.all([
        reauth.consumeSessionReauthChallenge(MEMBER_A, token),
        reauth.consumeSessionReauthChallenge(MEMBER_A, token),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
    });

    it("refuses a replay, an expired challenge and another member", async () => {
      const token = await mint();
      expect(await reauth.consumeSessionReauthChallenge(MEMBER_A, token)).toBe(true);
      expect(await reauth.consumeSessionReauthChallenge(MEMBER_A, token)).toBe(false);

      const expired = await mint();
      await prisma.sessionReauthChallenge.updateMany({
        where: { memberId: MEMBER_A, consumedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await reauth.consumeSessionReauthChallenge(MEMBER_A, expired)).toBe(false);

      const theirs = await mint();
      expect(await reauth.consumeSessionReauthChallenge(MEMBER_B, theirs)).toBe(false);
      expect(await reauth.consumeSessionReauthChallenge(MEMBER_A, theirs)).toBe(true);
    });
  },
);
