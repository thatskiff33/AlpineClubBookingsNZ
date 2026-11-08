/**
 * Real-PostgreSQL proof for the step-up challenge's consumption (#4616,
 * `INV-AUTH-008`).
 *
 * `consumeSessionReauthChallenge` is one guarded single-row delete — the
 * token's hash, this member, unexpired — and succeeds only when its count is
 * exactly one. No advisory key and no row lock of its own: the claim is the
 * DELETE. The unit suite proves what the statement asks for; only PostgreSQL
 * can prove what it does:
 *
 *   1. a live challenge consumes once, and the same token then consumes nothing
 *      (a replay);
 *   2. another member's token consumes nothing, and stays for its own member;
 *   3. an expired token consumes nothing; the member's next mint clears it;
 *   4. a token nobody minted consumes nothing;
 *   5. two consumers of one token, FORCED to meet — a third connection holds the
 *      row, both deletes are seen blocked on it before either has written, then
 *      the holder lets go — yield exactly one success: the second delete
 *      re-checks the row after the first commits and finds it gone;
 *   6. a burst of ten unforced consumers of one token yields exactly one.
 *
 * Probed against committed state: with the delete replaced by a read followed by
 * an unguarded delete-by-id, case 5 yields two successes.
 *
 * OFF by default, like every `*.realdb.test.ts`: it runs only with
 * `RUN_CONCURRENCY_RACE_TESTS=1` against `CONCURRENCY_RACE_DATABASE_URL`
 * (loopback, port 55442+, the `concurrency_race_1881` marker), and hosted CI
 * runs it through the import in `concurrency-lock-races.realdb.test.ts`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/session-reauth-challenge.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Step-up challenge (#4616)";
const PREFIX = "race-4616";
const MEMBER_ID = `${PREFIX}-officer`;
const OTHER_MEMBER_ID = `${PREFIX}-other`;
const BARRIER_TIMEOUT_MS = 5_000;
const RACE_TEST_TIMEOUT_MS = 20_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let prisma: typeof import("@/lib/prisma")["prisma"];
let challenge: typeof import("@/lib/session-reauth-challenge");
let twoFactor: typeof import("@/lib/two-factor");
let holderClient: PrismaClient;
let observerClient: PrismaClient;
/**
 * The keyed hash needs an auth secret. Set only when none is present, and put
 * back as found: the race harness fails a suite that leaves `process.env`
 * changed (#4107, `support/race-harness-env-guard.ts`).
 */
const savedAuthSecret: { saved: boolean; value: string | undefined } = {
  saved: false,
  value: undefined,
};

(RUN ? describe : describe.skip)(
  "step-up challenge consumption — real PostgreSQL (#4616)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    /**
     * Backends waiting on a lock: the deletes, queued on the held row. (A
     * DELETE takes its transaction id before it waits on the tuple, so unlike
     * a bare row lock it cannot be told apart by holding none.)
     */
    async function waitForBlockedDeletes(expected: number) {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < BARRIER_TIMEOUT_MS) {
        const rows = await observerClient.$queryRaw<Array<{ waiting: number }>>`
          SELECT COUNT(*)::int AS "waiting"
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()
        `;
        seen = rows[0]?.waiting ?? 0;
        if (seen >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for ${expected} consume(s) to block on the challenge row — saw ${seen}. ` +
          "The consume no longer claims the row with one guarded DELETE (INV-AUTH-008).",
      );
    }

    async function rowsFor(memberId: string) {
      return prisma.sessionReauthChallenge.count({ where: { memberId } });
    }

    async function rowsForToken(token: string) {
      return prisma.sessionReauthChallenge.count({
        where: { tokenHash: twoFactor.hashTwoFactorCode(token) },
      });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      savedAuthSecret.value = process.env.AUTH_SECRET;
      savedAuthSecret.saved = true;
      process.env.AUTH_SECRET ??= "step-up-challenge-race-secret";
      ({ prisma } = await import("@/lib/prisma"));
      challenge = await import("@/lib/session-reauth-challenge");
      twoFactor = await import("@/lib/two-factor");

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const separate = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = separate(`${PREFIX}-holder`);
      observerClient = separate(`${PREFIX}-observer`);
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);

      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OTHER_MEMBER_ID] } } });
      for (const id of [MEMBER_ID, OTHER_MEMBER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Step",
            lastName: "Up",
            ageTier: "ADULT",
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      if (typeof prisma !== "undefined") {
        // The challenges cascade with their members.
        await prisma.member
          .deleteMany({ where: { id: { in: [MEMBER_ID, OTHER_MEMBER_ID] } } })
          .catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
      await Promise.all(
        [holderClient, observerClient].map((client) =>
          client ? client.$disconnect().catch(() => {}) : Promise.resolve(),
        ),
      );
      if (savedAuthSecret.saved) {
        if (savedAuthSecret.value === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = savedAuthSecret.value;
      }
    });

    it("consumes a live challenge once, and a replay of the same token consumes nothing", async () => {
      const token = await challenge.createSessionReauthChallenge(MEMBER_ID);

      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, token)).toBe(true);
      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, token)).toBe(false);
      expect(await rowsFor(MEMBER_ID)).toBe(0);
    });

    it("refuses another member's token, which stays for its own member", async () => {
      const othersToken = await challenge.createSessionReauthChallenge(OTHER_MEMBER_ID);

      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, othersToken)).toBe(false);
      expect(await rowsFor(OTHER_MEMBER_ID)).toBe(1);
      expect(await challenge.consumeSessionReauthChallenge(OTHER_MEMBER_ID, othersToken)).toBe(true);
    });

    it("refuses an expired token, which the member's next mint clears", async () => {
      const token = await challenge.createSessionReauthChallenge(MEMBER_ID);
      await prisma.sessionReauthChallenge.updateMany({
        where: { memberId: MEMBER_ID, tokenHash: twoFactor.hashTwoFactorCode(token) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });

      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, token)).toBe(false);
      expect(await rowsFor(MEMBER_ID)).toBe(1);

      const fresh = await challenge.createSessionReauthChallenge(MEMBER_ID);
      expect(await rowsFor(MEMBER_ID)).toBe(1);
      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, fresh)).toBe(true);
    });

    it("refuses a token nobody minted, and a live token's own hash presented as the token", async () => {
      const token = await challenge.createSessionReauthChallenge(MEMBER_ID);

      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, "f".repeat(64))).toBe(false);
      expect(
        await challenge.consumeSessionReauthChallenge(MEMBER_ID, twoFactor.hashTwoFactorCode(token)),
      ).toBe(false);
      expect(await rowsFor(MEMBER_ID)).toBe(1);
      expect(await challenge.consumeSessionReauthChallenge(MEMBER_ID, token)).toBe(true);
    });

    it("lets exactly one of two consumers FORCED to meet on the row succeed", async () => {
      const token = await challenge.createSessionReauthChallenge(MEMBER_ID);
      const tokenHash = twoFactor.hashTwoFactorCode(token);

      const held = deferred();
      const release = deferred();
      const holder = holderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "SessionReauthChallenge" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
          held.resolve();
          await release.promise;
        },
        { timeout: 15_000 },
      );
      await held.promise;

      const consumers = [
        challenge.consumeSessionReauthChallenge(MEMBER_ID, token),
        challenge.consumeSessionReauthChallenge(MEMBER_ID, token),
      ];
      await waitForBlockedDeletes(2);
      release.resolve();
      await holder;

      const results = await Promise.all(consumers);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await rowsForToken(token)).toBe(0);
    });

    it("lets exactly one of a burst of ten unforced consumers succeed", async () => {
      const token = await challenge.createSessionReauthChallenge(MEMBER_ID);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => challenge.consumeSessionReauthChallenge(MEMBER_ID, token)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await rowsForToken(token)).toBe(0);
    });
  },
);
