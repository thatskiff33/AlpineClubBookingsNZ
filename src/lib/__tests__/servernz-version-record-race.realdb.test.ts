/**
 * Real-PostgreSQL proof of the central-server version recorder's fence (#4366).
 *
 * `servernz-api-version-gate.test.ts` pins the compare against doubles: it can
 * show the recorder asks for the lock first and compares the identity, but not
 * that the settings-row `FOR UPDATE` really makes a recorder wait for a key
 * change still in flight, nor that the re-read after the wait sees what that
 * change committed. This suite drives the REAL `recordServerVersionIfCurrent`
 * against a real database:
 *
 *   - settled: the same key saved again (a new IV, so a new version), or a new
 *     address, records nothing; the connection still stored records;
 *   - forced: a holder transaction re-saves the key and forgets the old answer
 *     while holding the settings row; the recorder, started with the OLD
 *     identity, queues on the row and, once the holder commits, records nothing.
 *     Without the lock it would read the old version and write over the forget.
 *
 * No `vi.mock`, so `concurrency-lock-races.realdb.test.ts` imports it (#1881).
 * Ordinary Vitest runs skip it. Reads ONLY `CONCURRENCY_RACE_DATABASE_URL`
 * (loopback, port 55442+, name containing `concurrency_race_1881`). It owns the
 * singleton `ServerNzSettings` row and the `servernz`/`api_key` credential,
 * which no other race suite touches, and cleans both before and after.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const SETTINGS_ID = "default";
const PROVIDER = "servernz";
const KEY = "api_key";
const BASE_URL = "https://central.race-4366.example.invalid";
const MOVED_URL = "https://moved.race-4366.example.invalid";
const LOCK_POLL_TIMEOUT_MS = 10_000;

/**
 * A stored key row. Never decrypted here: the recorder compares only the
 * version token, which is a hash over these three fields. `iv` stands in for
 * the fresh IV every real write draws, so the same key saved again differs.
 */
function credentialRow(iv: string) {
  return { ciphertext: "race-4366-ciphertext", iv, authTag: "race-4366-tag" };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recordServerVersionIfCurrent: (typeof import("@/lib/servernz-version-record"))["recordServerVersionIfCurrent"];
let forgetServerConnectionAnswers: (typeof import("@/lib/servernz-settings"))["forgetServerConnectionAnswers"];
let withServerNzConnectionTransaction: (typeof import("@/lib/servernz-config"))["withServerNzConnectionTransaction"];
let credentialVersionOf: (typeof import("@/lib/integration-credential-actor"))["credentialVersionOf"];
let holderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(
  "central-server version recorder under a concurrent key change — real PostgreSQL (#4366)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.integrationCredential.deleteMany({ where: { provider: PROVIDER, key: KEY } });
      await prisma.serverNzSettings.deleteMany({ where: { id: SETTINGS_ID } });
    }

    async function storeKey(iv: string) {
      const row = credentialRow(iv);
      await prisma.integrationCredential.upsert({
        where: { provider_key: { provider: PROVIDER, key: KEY } },
        create: {
          provider: PROVIDER,
          key: KEY,
          ...row,
          secretSource: "AUTH_SECRET",
          labelVersion: "integration-credential:v1",
        },
        update: row,
      });
      return credentialVersionOf(row);
    }

    async function storedVersion() {
      const row = await prisma.serverNzSettings.findUnique({
        where: { id: SETTINGS_ID },
        select: { serverVersion: true },
      });
      return row?.serverVersion ?? null;
    }

    /** Sessions of this database currently waiting on a lock, observer excluded. */
    async function lockWaiters(): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      return rows[0]?.count ?? 0;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Central-server version recorder");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ recordServerVersionIfCurrent } = await import("@/lib/servernz-version-record"));
      ({ forgetServerConnectionAnswers } = await import("@/lib/servernz-settings"));
      ({ withServerNzConnectionTransaction } = await import("@/lib/servernz-config"));
      ({ credentialVersionOf } = await import("@/lib/integration-credential-actor"));

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = createSeparateClient("race-4366-holder");
      observerClient = createSeparateClient("race-4366-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    });

    beforeEach(async () => {
      await deleteFixtures();
      await prisma.serverNzSettings.create({ data: { id: SETTINGS_ID, baseUrl: BASE_URL } });
    });

    afterAll(async () => {
      if (prisma) await deleteFixtures();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("records an answer from the connection still stored", async () => {
      const credentialVersion = await storeKey("race-4366-iv-a1");

      await expect(recordServerVersionIfCurrent({ baseUrl: BASE_URL, credentialVersion }, "2.1")).resolves.toBe(true);
      expect(await storedVersion()).toBe("2.1");
    });

    it("records nothing once the same key has been saved again (A -> B -> A)", async () => {
      const sentOn = await storeKey("race-4366-iv-a1");
      await storeKey("race-4366-iv-b");
      const again = await storeKey("race-4366-iv-a2");
      expect(again).not.toBe(sentOn);

      await expect(recordServerVersionIfCurrent({ baseUrl: BASE_URL, credentialVersion: sentOn }, "2.1")).resolves.toBe(
        false,
      );
      expect(await storedVersion()).toBeNull();
    });

    it("records nothing once the address has moved, even with the same key", async () => {
      const credentialVersion = await storeKey("race-4366-iv-a1");
      await prisma.serverNzSettings.update({ where: { id: SETTINGS_ID }, data: { baseUrl: MOVED_URL } });

      await expect(recordServerVersionIfCurrent({ baseUrl: BASE_URL, credentialVersion }, "2.1")).resolves.toBe(false);
      expect(await storedVersion()).toBeNull();
    });

    it("waits for a key change in flight and then records nothing over its forget", async () => {
      const sentOn = await storeKey("race-4366-iv-a1");
      await prisma.serverNzSettings.update({
        where: { id: SETTINGS_ID },
        data: { serverVersion: "1.9", serverVersionCheckedAt: new Date() },
      });

      let releaseHolder!: () => void;
      const holderMayCommit = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderHasRow!: () => void;
      const holderHoldsRow = new Promise<void>((resolve) => {
        holderHasRow = resolve;
      });
      const holder = holderClient.$transaction(
        async (tx) => {
          // An atomic replacement probe, not the production writers' separate
          // commits: hold the settings row until both writes commit together.
          await tx.integrationCredential.update({
            where: { provider_key: { provider: PROVIDER, key: KEY } },
            data: credentialRow("race-4366-iv-a2"),
          });
          await tx.serverNzSettings.update({
            where: { id: SETTINGS_ID },
            data: { serverVersion: null, serverVersionCheckedAt: null },
          });
          holderHasRow();
          await holderMayCommit;
        },
        { timeout: 30_000 },
      );
      await holderHoldsRow;

      const recorder = recordServerVersionIfCurrent({ baseUrl: BASE_URL, credentialVersion: sentOn }, "2.1");
      const pollStart = process.hrtime.bigint();
      while ((await lockWaiters()) < 1) {
        if (realElapsedMs(pollStart) > LOCK_POLL_TIMEOUT_MS) {
          releaseHolder();
          await holder;
          throw new Error("The recorder never queued on the settings row.");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      releaseHolder();
      await holder;
      await expect(recorder).resolves.toBe(false);
      expect(await storedVersion()).toBeNull();
    });

    it("lets a separately committed key write and forget clear a recorder holding the row lock", async () => {
      const sentOn = await storeKey("race-4366-iv-a1");
      let releaseRecorder!: () => void;
      const recorderMayCommit = new Promise<void>((resolve) => {
        releaseRecorder = resolve;
      });
      let recorderHasRow!: () => void;
      const recorderHoldsRow = new Promise<void>((resolve) => {
        recorderHasRow = resolve;
      });
      const realTransaction = prisma.$transaction.bind(prisma);
      const transaction = vi.spyOn(prisma, "$transaction").mockImplementationOnce((
        (work: (tx: Prisma.TransactionClient) => Promise<boolean>, options?: { timeout?: number; maxWait?: number }) =>
          realTransaction(async (tx) => {
            const recorded = await work(tx);
            recorderHasRow();
            await recorderMayCommit;
            return recorded;
          }, options)
      ) as typeof prisma.$transaction);

      const recorder = recordServerVersionIfCurrent({ baseUrl: BASE_URL, credentialVersion: sentOn }, "2.1");
      let forget: Promise<void> | undefined;
      try {
        await Promise.race([
          recorderHoldsRow,
          recorder.then(() => { throw new Error("The recorder committed before the test released it."); }),
        ]);
        const replacement = await storeKey("race-4366-iv-b");
        expect(replacement).not.toBe(sentOn);
        // The forget inside its connection fence (#4436): it queues on the recorder's row.
        forget = withServerNzConnectionTransaction((tx) => forgetServerConnectionAnswers(tx));

        const pollStart = process.hrtime.bigint();
        while ((await lockWaiters()) < 1) {
          if (realElapsedMs(pollStart) > LOCK_POLL_TIMEOUT_MS) {
            throw new Error("The separately committed forget never queued on the recorder's settings row.");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        releaseRecorder();
        await expect(recorder).resolves.toBe(true);
        await forget;
        expect(await storedVersion()).toBeNull();
      } finally {
        releaseRecorder();
        transaction.mockRestore();
        await Promise.allSettled([recorder, forget]);
      }
    });
  },
);
