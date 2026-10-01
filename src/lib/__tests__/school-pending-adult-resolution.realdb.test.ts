/** #3413: run the production naming transaction and rollback on migrated PostgreSQL. */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";
import { jobBlock } from "./helpers/ci-workflow";
import { realElapsedMs } from "./helpers/clock";

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/member-dietary-booking-writes", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@/lib/member-dietary-booking-writes");
  return { ...actual, resolveBookingGuestDietarySeeding: async () => actual.bookingGuestDietarySeeding(true) };
});

const databaseUrl = process.env.DATA_MIGRATION_VERIFICATION_DATABASE_URL;
const migrationDirectory = path.join(process.cwd(), "prisma/migrations");
const migrationName = "20261101020000_add_pending_school_adult_capacity";
const checkIn = new Date("2026-08-01T00:00:00.000Z");
const checkOut = new Date("2026-08-03T00:00:00.000Z");
const teacher = { firstName: "Ann", lastName: "Teacher", ageTier: "ADULT" as const };
const option = {
  id: "STANDARD", label: "School", cateringOption: null,
  totalCents: 601, pricingMode: "OVERALL_TOTAL",
  guestBreakdown: [
    { kind: "NAMED", ...teacher, guestIndex: 0, totalCents: 200 },
    { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 1, totalCents: 201 },
    { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 2, totalCents: 200 },
  ].map((entry) => ({ ...entry, isMember: false, memberId: null, nightCount: 2, rateCents: null })),
};

it("runs the pending-adult database proof in CI", () => {
  const job = jobBlock(readFileSync(".github/workflows/ci.yml", "utf8"), "data-migration-verification");
  expect(job).toContain("src/lib/__tests__/school-pending-adult-resolution.realdb.test.ts");
  if (process.env.GITHUB_JOB === "data-migration-verification") expect(databaseUrl).toBeTruthy();
});

(databaseUrl ? describe : describe.skip)("pending adult resolution on PostgreSQL (#3413)", () => {
  let admin: Client;
  let sql: Client;
  let prisma: PrismaClient;
  let scratchDatabase = "";
  let resolve: typeof import("@/lib/school-pending-adult-resolution")["resolveAcceptedSchoolPendingAdults"];
  let reserve: typeof import("@/lib/booking-request-pending-adult-reservations")["reservePendingAdultNights"];
  let acquireLodgeLock: typeof import("@/lib/capacity")["acquireLodgeCapacityLock"];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Pending adult database tests require a disposable loopback PostgreSQL.");
    }
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    scratchDatabase = `pending3413_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${scratchDatabase}"`);
    url.pathname = `/${scratchDatabase}`;
    sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    for (const name of readdirSync(migrationDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const source = readFileSync(path.join(migrationDirectory, name, "migration.sql"), "utf8");
      for (const statement of splitSqlStatements(source)) {
        if (statement.trim()) await sql.query(statement);
      }
    }
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("PENDING_SCHOOL_ADULTS_ENABLED", "1");
    vi.stubEnv("BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED", "1");
    ({ prisma } = await import("@/lib/prisma"));
    ({ resolveAcceptedSchoolPendingAdults: resolve } = await import("@/lib/school-pending-adult-resolution"));
    ({ reservePendingAdultNights: reserve } = await import("@/lib/booking-request-pending-adult-reservations"));
    ({ acquireLodgeCapacityLock: acquireLodgeLock } = await import("@/lib/capacity"));
    await prisma.lodge.create({ data: { id: "pending-lodge", name: "Test lodge", slug: "pending-lodge" } });
    await prisma.organisation.create({ data: { id: "pending-school", name: "Test school" } });
  }, 120_000);

  beforeEach(async () => {
    await prisma.bookingRequest.deleteMany({ where: { id: "pending-request" } });
    await prisma.booking.deleteMany({ where: { id: "pending-hold" } });
    await prisma.booking.create({ data: {
      id: "pending-hold", lodgeId: "pending-lodge", organisationId: "pending-school",
      checkIn, checkOut, status: "AWAITING_REVIEW", totalPriceCents: 601, finalPriceCents: 601,
      guests: { create: { ...teacher, stayStart: checkIn, stayEnd: checkOut, priceCents: 200, isMember: false } },
    } });
    await prisma.bookingRequest.create({ data: {
      id: "pending-request", lodgeId: "pending-lodge", type: "SCHOOL", status: "ACCEPTED", version: 4,
      contactFirstName: "Ann", contactLastName: "Teacher", contactEmail: "ann@example.invalid",
      checkIn, checkOut, guests: [teacher], teachers: [{ firstName: "Ann", lastName: "Teacher", email: null }],
      heldBookingId: "pending-hold", pendingAdultCount: 2, acceptedPriceCents: 601,
      acceptedQuoteSnapshot: option,
    } });
    await reserve({ db: prisma, bookingRequestId: "pending-request", bookingId: "pending-hold",
      lodgeId: "pending-lodge", checkIn, checkOut, adultCount: 2 });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await sql?.end();
    if (admin && scratchDatabase) await admin.query(`DROP DATABASE "${scratchDatabase}" WITH (FORCE)`);
    await admin?.end();
    vi.unstubAllEnvs();
  });

  const nameAdult = (expectedVersion = 4, firstName = "Beth") => resolve({
    requestId: "pending-request", adminMemberId: "officer", expectedVersion,
    teachers: [{ firstName, lastName: "Teacher", email: null }],
  });

  it("admits exactly one duplicate naming command, preserves cents and occupancy, then resolves the final slot", async () => {
    const results = await Promise.allSettled([nameAdult(), nameAdult()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const request = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } });
    expect(request).toMatchObject({ version: 5, pendingAdultCount: 1, acceptedPriceCents: 601, acceptedQuoteSnapshot: option });
    const hold = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    const reservations = await prisma.bookingRequestPendingAdultReservationNight.findMany({ where: { bookingId: hold.id } });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((row) => row.adultCount + hold.guests.length === 3)).toBe(true);
    const named = hold.guests.find((guest) => guest.firstName === "Beth")!;
    expect(named.priceCents).toBe(201);
    const nonMemberType = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
    expect(named.rateMembershipTypeId).toBe(nonMemberType.id);
    expect(named.nights.map((night) => night.priceCents).sort()).toEqual([100, 101]);
    expect(named.nights.every((night) => night.priceSource === "EVEN_SPLIT")).toBe(true);
    expect(hold.guests.reduce((sum, guest) => sum + guest.priceCents, 0) + 200).toBe(601);
    await expect(nameAdult(5, "Cara")).resolves.toEqual({ version: 6, pendingAdultCount: 0 });
    expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(0);
    expect(await prisma.bookingGuest.count({ where: { bookingId: hold.id } })).toBe(3);
  });

  it("re-reads a held booking cancelled while naming waits for the lodge lock", async () => {
    let naming: ReturnType<typeof nameAdult>;
    await prisma.$transaction(async (tx) => {
      // The hold writer already owns this key when the naming call locates it.
      await acquireLodgeLock(tx, "pending-lodge");
      naming = nameAdult();
      // Attach the handler immediately: the rejection arrives after this tx commits.
      naming.catch(() => {});
      const started = process.hrtime.bigint();
      let waiting = false;
      while (realElapsedMs(started) < 3_000) {
        const locks = await sql.query(`SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
        if (locks.rows[0].waiting > 0) { waiting = true; break; }
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(waiting, "the production resolver must actually wait for the held lodge key").toBe(true);
      await tx.booking.update({ where: { id: "pending-hold" }, data: { status: "CANCELLED" } });
      await tx.bookingRequestPendingAdultReservationNight.deleteMany({ where: { bookingId: "pending-hold" } });
    });
    await expect(naming!).rejects.toMatchObject({ status: 409 });
    expect(await prisma.bookingGuest.count({ where: { bookingId: "pending-hold" } })).toBe(1);
    expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(0);
  });

  it("rolls the request claim and guest creation back when a later guest write fails", async () => {
    await sql.query(`CREATE FUNCTION fail_pending_guest() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'deliberate pending guest failure'; END $$;
      CREATE TRIGGER fail_pending_guest BEFORE INSERT ON "BookingGuest"
      FOR EACH ROW EXECUTE FUNCTION fail_pending_guest()`);
    try {
      await expect(nameAdult()).rejects.toThrow(/deliberate pending guest failure/);
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } }))
        .toMatchObject({ version: 4, pendingAdultCount: 2, guests: [teacher] });
      expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(2);
      expect(await prisma.bookingGuest.count({ where: { bookingId: "pending-hold" } })).toBe(1);
    } finally {
      await sql.query('DROP TRIGGER fail_pending_guest ON "BookingGuest"; DROP FUNCTION fail_pending_guest()');
    }
  });

  it.each(["count", "reservation", "empty"] as const)("rollback checks the %s boundary", async (remaining) => {
    await sql.query("BEGIN");
    try {
      if (remaining !== "reservation") await sql.query('DELETE FROM "BookingRequestPendingAdultReservationNight"');
      if (remaining !== "count") await sql.query('UPDATE "BookingRequest" SET "pendingAdultCount" = 0');
      const reverse = sql.query(readFileSync(path.join(migrationDirectory, migrationName, "rollback.sql"), "utf8"));
      if (remaining === "empty") {
        await reverse;
        expect((await sql.query(`SELECT to_regclass('"BookingRequestPendingAdultReservationNight"') AS relation`)).rows)
          .toEqual([{ relation: null }]);
        expect((await sql.query(`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'BookingRequest' AND column_name = 'pendingAdultCount'`)).rows).toEqual([]);
      } else {
        await expect(reverse).rejects.toThrow(/pending_school_adult_rollback_blocked/);
      }
    } finally {
      await sql.query("ROLLBACK");
    }
  });
});
