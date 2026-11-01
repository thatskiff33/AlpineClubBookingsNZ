/**
 * RE-RUNNING THE DEMO SEED OVER ITS OWN OUTPUT (#4583; `INV-OPS`).
 *
 * `prisma/demo-seed.ts` clears its previous rows before it builds new ones. Its
 * clean-up once never deleted `ManualRefundTask`, which holds a RESTRICT key onto
 * the payment the seed also creates, so the second run died at
 * `payment.deleteMany` with `ManualRefundTask_paymentId_fkey`. Only a real
 * PostgreSQL has the foreign keys, so the proof runs the real script, twice,
 * against one migrated database.
 *
 * It owns a scratch database on the race server: the seed deletes every booking
 * and refuses a database holding a non-demo member, so it must never share the
 * race database the other realdb files write to. Ordinary Vitest runs skip it;
 * CI's real-PostgreSQL job runs it with the other `*.realdb.test.ts` files.
 *
 * Also proved: a booking that carries append-only money history makes the seed
 * refuse before it deletes anything (Ledger M2, `INV-MONEY-043`).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const SCRATCH = `concurrency_race_1881_demoseed_${randomBytes(4).toString("hex")}`;

let admin: Client;
let scratchUrl = "";

function scratchEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: scratchUrl, ALLOW_DEMO_SEED: "1", NODE_ENV: "test" };
}

function runSeed(): string {
  return execFileSync("pnpm", ["exec", "tsx", "--conditions=react-server", "prisma/demo-seed.ts"], {
    cwd: process.cwd(),
    env: scratchEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function count(sql: string): Promise<number> {
  const scratch = new Client({ connectionString: scratchUrl });
  await scratch.connect();
  try {
    return Number((await scratch.query<{ n: string }>(sql)).rows[0]?.n);
  } finally {
    await scratch.end();
  }
}

(RUN ? describe : describe.skip)("demo seed re-run (#4583)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Demo seed re-run");
    const url = new URL(RACE_DB_URL);
    url.pathname = `/${SCRATCH}`;
    scratchUrl = url.toString();
    admin = new Client({ connectionString: RACE_DB_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${SCRATCH}"`);
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: scratchEnv(),
      stdio: "ignore",
    });
  }, 300_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it("seeds twice into the same database, with the bank-refund follow-up task in place", async () => {
    runSeed();
    expect(await count(`SELECT count(*) AS n FROM "ManualRefundTask" WHERE "paymentId" IS NOT NULL`)).toBeGreaterThan(0);
    const bookings = await count(`SELECT count(*) AS n FROM "Booking"`);

    expect(() => runSeed()).not.toThrow();

    expect(await count(`SELECT count(*) AS n FROM "Booking"`)).toBe(bookings);
    expect(await count(`SELECT count(*) AS n FROM "ManualRefundTask" WHERE "paymentId" IS NOT NULL`)).toBeGreaterThan(0);
  }, 600_000);

  it("refuses, deleting nothing, when a booking carries append-only ledger history", async () => {
    const scratch = new Client({ connectionString: scratchUrl });
    await scratch.connect();
    try {
      await scratch.query(`INSERT INTO "BookingLedgerLine"
        ("id", "bookingId", "lodgeId", "side", "kind", "sign", "quantity", "unitCents", "amountCents",
         "guestNames", "anchorKind", "anchorId", "narration")
        SELECT 'seed-4583-line', b."id", b."lodgeId", 'ADJUSTMENT', 'AGREED_ADJUSTMENT', 1, 1, 100, 100,
          ARRAY[]::text[], 'REVIEW_TASK', b."id", 'Adjustment agreed with member: seed 4583'
        FROM "Booking" b ORDER BY b."id" LIMIT 1`);
    } finally {
      await scratch.end();
    }
    const bookings = await count(`SELECT count(*) AS n FROM "Booking"`);

    let stderr = "";
    try {
      runSeed();
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? error);
    }

    expect(stderr).toContain("Demo seed refused");
    expect(await count(`SELECT count(*) AS n FROM "Booking"`)).toBe(bookings);
  }, 600_000);
});
