/**
 * Real-PostgreSQL proof that the stored-password cost upgrade never overwrites
 * a password changed at the same moment (#5261).
 *
 * `upgradePasswordHashAfterProof` is one `updateMany` guarded on the proved
 * hash, with no lock and no transaction. Four cases:
 *
 *   1. an older-cost hash is replaced by a current-cost one that verifies;
 *   2. a password changed before the upgrade's write is left alone;
 *   3. FORCED interleaving: a change holds the Member row uncommitted, the
 *      upgrade's write blocks on it (barrier: `pg_stat_activity` reports it
 *      waiting on a lock), the change commits, and PostgreSQL re-checks the
 *      guard against the committed row, so the upgrade matches nothing;
 *   4. FORCED interleaving (#5342): two sign-ins upgrade the same older hash.
 *      A holder keeps the row locked (without changing the hash) until both
 *      writes are waiting on it, then commits. Exactly one write matches; the
 *      other re-checks the guard against the winner's hash and matches
 *      nothing, so exactly one call returns true and the hash still verifies.
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker). The race harness imports this file.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Password cost upgrade (#5261)";
const MEMBER = "race-5261-member";
const PLAIN = "race-5261-old-password";
const CHANGED = "race-5261-changed-password";

/** Covers the cost-13 hash the upgrade computes before its write. */
const BARRIER_TIMEOUT_MS = 10_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let prisma: PrismaClient;
let holderClient: PrismaClient;
let rehash: typeof import("@/lib/password-rehash");
let hashing: typeof import("@/lib/password-hashing");
let olderHash: string;
let changedHash: string;

(RUN ? describe : describe.skip)(
  "stored password cost upgrade — real PostgreSQL (#5261)",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const client = (name: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", name);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      prisma = client("race-5261-observer");
      holderClient = client("race-5261-holder");
      await Promise.all([prisma.$connect(), holderClient.$connect()]);
      rehash = await import("@/lib/password-rehash");
      hashing = await import("@/lib/password-hashing");

      olderHash = await hashing.hashPin(PLAIN, hashing.PASSWORD_BCRYPT_COST - 1);
      changedHash = await hashing.hashPassword(CHANGED);
      await prisma.member.deleteMany({ where: { id: MEMBER } });
      await prisma.member.create({
        data: {
          id: MEMBER,
          email: "race-5261@example.invalid",
          firstName: "Race",
          lastName: "Rehash",
          passwordHash: olderHash,
        },
      });
    }, 60_000);

    beforeEach(async () => {
      await prisma.member.update({ where: { id: MEMBER }, data: { passwordHash: olderHash } });
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.member.deleteMany({ where: { id: MEMBER } }).catch(() => {});
        await prisma.$disconnect().catch(() => {});
      }
      if (holderClient) await holderClient.$disconnect().catch(() => {});
    }, 60_000);

    async function storedHash() {
      const row = await prisma.member.findUniqueOrThrow({ where: { id: MEMBER } });
      return row.passwordHash;
    }

    function upgrade() {
      return rehash.upgradePasswordHashAfterProof({ memberId: MEMBER, plain: PLAIN, storedHash: olderHash });
    }

    async function waitForBlockedWriter(writers = 1) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < BARRIER_TIMEOUT_MS) {
        const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
          SELECT COUNT(*)::int AS "waiting"
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()
        `;
        if ((rows[0]?.waiting ?? 0) >= writers) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `Timed out waiting for ${writers} upgrade write(s) to block on the held Member row.`,
      );
    }

    it("replaces an older-cost hash with a current-cost one that still verifies", async () => {
      expect(await upgrade()).toBe(true);
      const stored = await storedHash();
      expect(hashing.passwordHashCost(stored)).toBe(hashing.PASSWORD_BCRYPT_COST);
      expect(await hashing.verifyPassword(PLAIN, stored)).toBe(true);
    });

    it("leaves a password changed before the upgrade writes", async () => {
      await prisma.member.update({ where: { id: MEMBER }, data: { passwordHash: changedHash } });
      expect(await upgrade()).toBe(false);
      expect(await storedHash()).toBe(changedHash);
    });

    it("re-checks the guard after waiting on a concurrent change, and matches nothing", async () => {
      const held = deferred();
      const release = deferred();
      const change = holderClient.$transaction(
        async (tx) => {
          await tx.member.update({ where: { id: MEMBER }, data: { passwordHash: changedHash } });
          held.resolve();
          await release.promise;
        },
        { timeout: 20_000 },
      );
      await held.promise;

      const upgraded = upgrade();
      try {
        await waitForBlockedWriter();
      } finally {
        release.resolve();
        await change;
      }

      await expect(upgraded).resolves.toBe(false);
      expect(await storedHash()).toBe(changedHash);
      expect(await hashing.verifyPassword(CHANGED, await storedHash())).toBe(true);
    });

    it("lets exactly one of two parallel upgrades of the same older hash win (#5342)", async () => {
      const held = deferred();
      const release = deferred();
      // Locks the row without changing the hash: both upgrades' guards still
      // match when the holder commits, so only the order between them decides.
      const holder = holderClient.$transaction(
        async (tx) => {
          await tx.member.update({ where: { id: MEMBER }, data: { passwordHash: olderHash } });
          held.resolve();
          await release.promise;
        },
        { timeout: 20_000 },
      );
      await held.promise;

      const first = upgrade();
      const second = upgrade();
      try {
        // Barrier: both writes have computed their hash and are queued on the row.
        await waitForBlockedWriter(2);
      } finally {
        release.resolve();
        await holder;
      }

      const results = await Promise.all([first, second]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await storedHash();
      expect(stored).not.toBe(olderHash);
      expect(hashing.passwordHashCost(stored)).toBe(hashing.PASSWORD_BCRYPT_COST);
      expect(await hashing.verifyPassword(PLAIN, stored)).toBe(true);
    });
  },
);
