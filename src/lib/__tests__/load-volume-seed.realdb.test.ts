/**
 * THE LOAD VOLUME SEEDER AGAINST A REAL DATABASE (#4940; `INV-OPS`).
 *
 * `prisma/load-volume-seed.ts` writes years of past bookings through the demo
 * seed's writers. The pure plan is proved in `load-volume-plan.test.ts`; this
 * file proves what only a migrated PostgreSQL can: the rows satisfy the schema,
 * no lodge night ends up over capacity once the seeder's history sits beside the
 * demo bookings, no member sleeps in two beds on one night, every night is in
 * the past, and a second run refuses rather than doubling the history.
 *
 * It owns a scratch database on the race server, like the demo-seed re-run
 * proof, because the demo seed it builds on deletes every booking. Ordinary
 * Vitest runs skip it; CI's real-PostgreSQL job runs it with the other
 * `*.realdb.test.ts` files.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const SCRATCH = `concurrency_race_1881_loadvolume_${randomBytes(4).toString("hex")}`;

let admin: Client;
let scratchUrl = "";

function scratchEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: scratchUrl,
    ALLOW_DEMO_SEED: "1",
    LOAD_TEST_CONFIRM_TARGET: "1",
    NODE_ENV: "test",
    ...extra,
  };
}

function tsx(script: string, extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync("pnpm", ["exec", "tsx", "--conditions=react-server", script], {
    cwd: process.cwd(),
    env: scratchEnv(extra),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function rows<T>(sql: string): Promise<T[]> {
  const scratch = new Client({ connectionString: scratchUrl });
  await scratch.connect();
  try {
    return (await scratch.query(sql)).rows as T[];
  } finally {
    await scratch.end();
  }
}

(RUN ? describe : describe.skip)("load volume seed (#4940)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Load volume seed");
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
    tsx("prisma/demo-seed.ts");
    // What the base seed would add, written directly so the proof makes no
    // network call (the base seed screens its passwords against a breach API):
    // a capacity for the demo lodge and one season around today.
    await rows(`UPDATE "LodgeSettings" SET capacity = 12 WHERE "lodgeId" IS NOT NULL`);
    await rows(`
      INSERT INTO "Season" (id, name, type, "startDate", "endDate", "updatedAt")
      VALUES ('load-volume-season', 'Winter', 'WINTER', CURRENT_DATE - 60, CURRENT_DATE + 120, now())`);
  }, 600_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  it("writes past history under every lodge-night ceiling, then refuses to run twice", async () => {
    tsx("prisma/load-volume-seed.ts", { LOAD_VOLUME_MEMBERS: "60", LOAD_VOLUME_SEASONS: "2" });

    const [written] = await rows<{ members: string; bookings: string; refunds: string; credits: string }>(`
      SELECT
        (SELECT count(*) FROM "Member" WHERE email LIKE 'load-%') AS members,
        (SELECT count(*) FROM "Booking" b JOIN "Member" m ON m.id = b."memberId" WHERE m.email LIKE 'load-%') AS bookings,
        (SELECT count(*) FROM "PaymentRefund" WHERE "stripeRefundId" LIKE 're_load_%') AS refunds,
        (SELECT count(*) FROM "MemberCredit" c JOIN "Member" m ON m.id = c."memberId" WHERE m.email LIKE 'load-%') AS credits`);
    expect(Number(written?.members)).toBe(60);
    expect(Number(written?.bookings)).toBeGreaterThan(100);
    expect(Number(written?.refunds) + Number(written?.credits)).toBeGreaterThan(0);

    // Every volume member can book now: a self-confirmed profile and a PAID
    // subscription for this season and the next, so a load run's writes meet
    // neither the profile gate nor the subscription lockout.
    const [bookable] = await rows<{ unconfirmed: string; paid: string }>(`
      SELECT
        (SELECT count(*) FROM "Member" WHERE email LIKE 'load-%'
           AND ("detailsConfirmedByMemberId" IS DISTINCT FROM id OR "profileCompletedAt" IS NULL)) AS unconfirmed,
        (SELECT count(*) FROM "MemberSubscription" s JOIN "Member" m ON m.id = s."memberId"
           WHERE m.email LIKE 'load-%' AND s.status = 'PAID') AS paid`);
    expect(Number(bookable?.unconfirmed)).toBe(0);
    expect(Number(bookable?.paid)).toBe(120);

    // Every night the seeder booked holds, with the demo bookings already
    // there, no more guests than the lodge's configured capacity.
    const overfull = await rows(`
      SELECT n."stayDate", b."lodgeId", count(*) AS guests
      FROM "BookingGuestNight" n
      JOIN "BookingGuest" g ON g.id = n."bookingGuestId"
      JOIN "Booking" b ON b.id = g."bookingId"
      JOIN "Member" m ON m.id = b."memberId"
      GROUP BY 1, 2
      HAVING bool_or(m.email LIKE 'load-%')
         AND count(*) > (SELECT coalesce(s.capacity, 0) FROM "LodgeSettings" s WHERE s."lodgeId" = b."lodgeId")`);
    expect(overfull).toEqual([]);

    const doubleBooked = await rows(`
      SELECT g."memberId", n."stayDate"
      FROM "BookingGuestNight" n JOIN "BookingGuest" g ON g.id = n."bookingGuestId"
      WHERE g."memberId" IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) > 1`);
    expect(doubleBooked).toEqual([]);

    // Nothing the seeder wrote reaches past tomorrow (UTC), whatever the club zone.
    const [future] = await rows<{ n: string }>(`
      SELECT count(*) AS n FROM "Booking" b JOIN "Member" m ON m.id = b."memberId"
      WHERE m.email LIKE 'load-%' AND b."checkOut" > CURRENT_DATE + 1`);
    expect(Number(future?.n)).toBe(0);

    expect(() => tsx("prisma/load-volume-seed.ts", { LOAD_VOLUME_MEMBERS: "60" })).toThrow(
      /volume member\(s\) already exist/,
    );
  }, 600_000);
});
