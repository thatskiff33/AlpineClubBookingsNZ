/** #3413: run the production naming transaction and rollback on migrated PostgreSQL. */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";
import { jobBlock } from "./helpers/ci-workflow";
import { realElapsedMs } from "./helpers/clock";

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn(async () => {}) }));
const email = vi.hoisted(() => ({ quote: vi.fn(async () => ({ status: "sent" })) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...await importOriginal() as typeof import("@/lib/email"),
  sendBookingRequestQuoteEmail: email.quote,
  sendBookingRequestQuoteAcceptedEmail: vi.fn(async () => {}),
  sendAdminBookingRequestQuoteAcceptedEmail: vi.fn(async () => {}),
  sendAdminSchoolManualInvoiceEmail: vi.fn(async () => {}),
  sendBookingConfirmedEmail: vi.fn(async () => {}),
  sendHutLeaderAssignmentEmail: vi.fn(async () => {}),
}));
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
  let quotes: typeof import("@/lib/booking-request-quotes");
  let approve: typeof import("@/lib/school-booking-request")["approveSchoolBookingRequest"];

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
    quotes = await import("@/lib/booking-request-quotes");
    ({ approveSchoolBookingRequest: approve } = await import("@/lib/school-booking-request"));
    await prisma.lodge.create({ data: { id: "pending-lodge", name: "Test lodge", slug: "pending-lodge" } });
    await prisma.lodgeSettings.create({ data: { id: "pending-lodge", lodgeId: "pending-lodge", capacity: 20 } });
    await prisma.organisation.create({ data: { id: "pending-school", name: "Test school" } });
    await prisma.member.create({ data: { id: "officer", firstName: "Test", lastName: "Officer", email: "officer@example.invalid", passwordHash: "test", role: "ADMIN" } });
  }, 120_000);

  beforeEach(async () => {
    await prisma.member.deleteMany({ where: { id: { in: ["matching-adult", "matching-contact"] } } });
    await prisma.bookingRequest.deleteMany({ where: { id: "pending-request" } });
    await prisma.payment.deleteMany({ where: { bookingId: "pending-hold" } });
    await prisma.booking.deleteMany({ where: { id: "pending-hold" } });
    await prisma.member.deleteMany({ where: { id: "linked-child" } });
    await prisma.booking.create({ data: {
      id: "pending-hold", lodgeId: "pending-lodge", organisationId: "pending-school",
      checkIn, checkOut, status: "AWAITING_REVIEW", totalPriceCents: 601, finalPriceCents: 601,
      guests: { create: { ...teacher, stayStart: checkIn, stayEnd: checkOut, priceCents: 200, isMember: false,
        nights: { create: [checkIn, new Date("2026-08-02T00:00:00.000Z")].map((stayDate) => ({ stayDate, priceCents: 100, priceSource: "EVEN_SPLIT" })) },
      } },
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

  it.each(["FULL", "NON_MEMBER", "SCHOOL"])("uses seasonal %s pricing policy for a login-disabled matching adult", async (key) => {
    const type = await prisma.membershipType.findUniqueOrThrow({ where: { key } });
    // An earlier matching nonmember contact must not hide the genuine member.
    if (key === "FULL") await prisma.member.create({ data: {
      id: "matching-contact", firstName: "Beth", lastName: "Teacher", email: "contact@example.invalid",
      passwordHash: "test", role: "NON_MEMBER", canLogin: false,
    } });
    await prisma.member.create({ data: {
      id: "matching-adult", firstName: "Beth", lastName: "Teacher",
      email: "beth@example.invalid", passwordHash: "test", active: true, canLogin: false, role: key === "SCHOOL" ? "SCHOOL" : "USER",
      seasonalMembershipAssignments: { create: { seasonYear: 2026, membershipTypeId: type.id } },
    } });
    if (key === "FULL") {
      await expect(nameAdult()).rejects.toThrow(/rate and consent/);
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ version: 4, pendingAdultCount: 2 });
      expect(await prisma.bookingGuest.count({ where: { bookingId: "pending-hold" } })).toBe(1);
      expect(await prisma.bookingRequestPendingAdultReservationNight.count({ where: { bookingId: "pending-hold" } })).toBe(2);
    } else {
      await expect(nameAdult()).resolves.toMatchObject({ pendingAdultCount: 1 });
      expect(await prisma.bookingGuest.count({ where: { bookingId: "pending-hold" } })).toBe(2);
    }
  });

  it.each([false, true])("names and approves a nonfirst accepted option with a reused hold: %s", async (requote) => {
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: {
      status: "VERIFIED", heldBookingId: null, acceptedPriceCents: null,
      acceptedQuoteSnapshot: Prisma.JsonNull, schoolName: "Test school", cateringPreference: "QUOTE_BOTH",
    } });
    await prisma.booking.delete({ where: { id: "pending-hold" } });
    const save = (totalCents: number) => quotes.createBookingRequestQuote({
      requestId: "pending-request", adminMemberId: "officer", quote: {
        pricingMode: "OVERALL_TOTAL", options: [
          { id: "NON_CATERED", totalCents: 601, cateringOption: "NON_CATERED" },
          { id: "CATERED", totalCents, cateringOption: "CATERED" },
        ],
      },
    });
    await save(901);
    await quotes.sendBookingRequestQuote({ requestId: "pending-request", adminMemberId: "officer" });
    const firstHold = (await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).heldBookingId!;
    if (requote) {
      await save(1201);
      await quotes.sendBookingRequestQuote({ requestId: "pending-request", adminMemberId: "officer" });
      expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).heldBookingId).toBe(firstHold);
    }
    const sentCall = email.quote.mock.calls.at(-1)! as unknown as [{ token: string }];
    await quotes.respondToBookingRequestQuote({ token: sentCall[0].token, action: "ACCEPT", optionId: "CATERED" });
    const accepted = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } });
    const acceptedTotal = requote ? 1201 : 901;
    expect(accepted.acceptedPriceCents).toBe(acceptedTotal);
    await expect(nameAdult(accepted.version)).resolves.toMatchObject({ pendingAdultCount: 1 });
    await expect(nameAdult(accepted.version + 1, "Cara")).resolves.toMatchObject({ pendingAdultCount: 0 });
    await expect(approve({ requestId: accepted.id, adminMemberId: "officer" })).resolves.toMatchObject({ bookingId: firstHold });
    const confirmed = await prisma.booking.findUniqueOrThrow({ where: { id: firstHold }, include: { guests: { include: { nights: true } } } });
    expect(confirmed).toMatchObject({ status: "CONFIRMED", totalPriceCents: acceptedTotal });
    expect(confirmed.guests.reduce((sum, guest) => sum + guest.priceCents, 0)).toBe(acceptedTotal);
    expect(confirmed.guests.flatMap((guest) => guest.nights).reduce((sum, night) => {
      if (night.priceCents === null) throw new Error("Every confirmed guest night must retain its accepted cents.");
      return sum + night.priceCents;
    }, 0)).toBe(acceptedTotal);
    expect(await prisma.bookingRequestPendingAdultReservationNight.count({ where: { bookingId: firstHold } })).toBe(0);
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: accepted.id } })).acceptedQuoteSnapshot).toEqual(accepted.acceptedQuoteSnapshot);
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

  it.each([false, true])("preserves unequal accepted prices and guest identities through partial naming and approval (linked child: %s)", async (linkedChild) => {
    const child = { firstName: "School Child", lastName: "1", ageTier: "CHILD" as const };
    const childMemberId = linkedChild ? "linked-child" : null;
    if (linkedChild) await prisma.member.create({ data: {
      id: childMemberId!, firstName: "Real", lastName: "Child", email: "child@example.invalid",
      passwordHash: "test", role: "USER", ageTier: "CHILD", canLogin: false,
    } });
    const snapshot = { ...option, guestBreakdown: [
      { kind: "NAMED", ...teacher, guestIndex: 0, totalCents: 201 },
      { kind: "NAMED", ...child, guestIndex: 1, totalCents: 111 },
      { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 2, totalCents: 145 },
      { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 3, totalCents: 144 },
    ].map((entry) => ({ ...entry, isMember: entry.guestIndex === 1 && linkedChild, memberId: entry.guestIndex === 1 ? childMemberId : null, nightCount: 2, rateCents: null })) };
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: {
      guests: [teacher, child], schoolName: "Test school", priceCents: snapshot.totalCents,
      acceptedQuoteSnapshot: snapshot, linkedGuestMembers: linkedChild ? [{ guestIndex: 1, memberId: childMemberId! }] : [],
    } });
    await prisma.bookingGuest.create({ data: { ...child, bookingId: "pending-hold", priceCents: 100, stayStart: checkIn, stayEnd: checkOut,
      memberId: childMemberId, isMember: linkedChild, dietaryRequirements: "Child's stay note",
      ...(linkedChild ? { consentStatus: "CONFIRMED", consentRespondedAt: new Date("2026-07-01T00:00:00.000Z"), consentRespondedByMemberId: "officer" } : {}),
      nights: { create: [checkIn, new Date("2026-08-02T00:00:00.000Z")].map((stayDate) => ({ stayDate, priceCents: 50, priceSource: "EVEN_SPLIT" })) },
    } });
    const original = await prisma.bookingGuest.findMany({ where: { bookingId: "pending-hold" }, include: { nights: true } });
    await nameAdult();
    await nameAdult(5, "Cara");
    const current = await prisma.bookingGuest.findMany({ where: { bookingId: "pending-hold" }, include: { nights: true }, omit: { dietaryRequirements: false } });
    expect(Object.fromEntries(current.map((guest) => [guest.firstName, guest.priceCents]))).toEqual({ Ann: 201, "School Child": 111, Beth: 145, Cara: 144 });
    for (const before of original) {
      const after = current.find((guest) => guest.id === before.id)!;
      expect(after.nights.map((night) => night.id).sort()).toEqual(before.nights.map((night) => night.id).sort());
      expect(after).toMatchObject({ firstName: before.firstName, lastName: before.lastName, ageTier: before.ageTier, memberId: before.memberId, rateMembershipTypeId: before.rateMembershipTypeId });
    }
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).acceptedQuoteSnapshot).toEqual(snapshot);
    expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(0);
    await approve({ requestId: "pending-request", adminMemberId: "officer" });
    const approved = await prisma.bookingGuest.findMany({ where: { bookingId: "pending-hold" }, include: { nights: true }, omit: { dietaryRequirements: false } });
    for (const named of current) {
      const after = approved.find((guest) => guest.firstName === named.firstName && guest.lastName === named.lastName)!;
      expect.soft(after.id, `${named.firstName}'s held guest identity`).toBe(named.id);
      expect.soft(after.priceCents, `${named.firstName}'s accepted cents`).toBe(named.priceCents);
      expect.soft(after.nights.map((night) => night.priceCents).sort(), `${named.firstName}'s accepted night cents`).toEqual(named.nights.map((night) => night.priceCents).sort());
      expect.soft(after).toMatchObject({ memberId: named.memberId, dietaryRequirements: named.dietaryRequirements,
        consentStatus: named.consentStatus, consentRequestedAt: named.consentRequestedAt,
        consentRespondedAt: named.consentRespondedAt, consentExpiresAt: named.consentExpiresAt,
        consentRespondedByMemberId: named.consentRespondedByMemberId });
    }
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).acceptedQuoteSnapshot).toEqual(snapshot);
  });

  it.each([2, 32])("groups proven night writes on a %s-night stay without moving identities or cents", async (nightCount) => {
    const { buildApprovalGuestNights } = await import("@/lib/booking-request-shared");
    const { addDaysDateOnly } = await import("@/lib/date-only");
    const end = addDaysDateOnly(checkIn, nightCount);
    const child = { firstName: "School Child", lastName: "1", ageTier: "CHILD" as const };
    const snapshot = { ...option, guestBreakdown: [
      { kind: "NAMED", ...teacher, guestIndex: 0, totalCents: 201 },
      { kind: "NAMED", ...child, guestIndex: 1, totalCents: 111 },
      { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 2, totalCents: 145 },
      { kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: 3, totalCents: 144 },
    ].map((entry) => ({ ...entry, isMember: false, memberId: null, nightCount, rateCents: null })) };
    await prisma.booking.update({ where: { id: "pending-hold" }, data: { checkOut: end } });
    await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: "pending-hold" } } });
    await prisma.bookingGuest.updateMany({ where: { bookingId: "pending-hold" }, data: { stayEnd: end } });
    const ann = await prisma.bookingGuest.findFirstOrThrow({ where: { bookingId: "pending-hold" } });
    await prisma.bookingGuestNight.createMany({ data: buildApprovalGuestNights({ checkIn, checkOut: end, priceCents: 200 })
      .map((night) => ({ ...night, bookingGuestId: ann.id })) });
    await prisma.bookingGuest.create({ data: { ...child, bookingId: "pending-hold", priceCents: 100, stayStart: checkIn, stayEnd: end,
      nights: { create: buildApprovalGuestNights({ checkIn, checkOut: end, priceCents: 100 }) },
    } });
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: {
      checkOut: end, guests: [teacher, child], acceptedQuoteSnapshot: snapshot,
    } });
    await prisma.bookingRequestPendingAdultReservationNight.deleteMany({ where: { bookingId: "pending-hold" } });
    await reserve({ db: prisma, bookingRequestId: "pending-request", bookingId: "pending-hold",
      lodgeId: "pending-lodge", checkIn, checkOut: end, adultCount: 2 });
    const before = await prisma.bookingGuest.findMany({ where: { bookingId: "pending-hold" }, include: { nights: true } });
    await sql.query(`CREATE TABLE pending_night_update_statements (marker boolean);
      CREATE FUNCTION count_pending_night_updates() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO pending_night_update_statements VALUES (true); RETURN NULL; END $$;
      CREATE TRIGGER count_pending_night_updates AFTER UPDATE ON "BookingGuestNight"
      FOR EACH STATEMENT EXECUTE FUNCTION count_pending_night_updates()`);
    try {
      await nameAdult();
      expect((await sql.query("SELECT COUNT(*)::int AS count FROM pending_night_update_statements")).rows).toEqual([{ count: 4 }]);
      const current = await prisma.bookingGuest.findMany({ where: { bookingId: "pending-hold" }, include: { nights: { orderBy: { stayDate: "asc" } } } });
      expect(Object.fromEntries(current.map((guest) => [guest.firstName, guest.priceCents]))).toEqual({ Ann: 201, "School Child": 111, Beth: 145 });
      for (const guest of current) {
        const expected = buildApprovalGuestNights({ checkIn, checkOut: end, priceCents: guest.priceCents });
        expect(guest.nights.map(({ stayDate, priceCents, priceSource }) => ({ stayDate, priceCents, priceSource }))).toEqual(expected);
        const original = before.find((entry) => entry.firstName === guest.firstName);
        if (original) {
          expect(guest.id).toBe(original.id);
          expect(guest.nights.map((night) => night.id).sort()).toEqual(original.nights.map((night) => night.id).sort());
          for (const night of original.nights) expect(guest.nights.find((entry) => entry.id === night.id)).toMatchObject({ bookingGuestId: guest.id, stayDate: night.stayDate });
        }
      }
      expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(nightCount);
      expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).acceptedQuoteSnapshot).toEqual(snapshot);
    } finally {
      await sql.query('DROP TRIGGER count_pending_night_updates ON "BookingGuestNight"; DROP FUNCTION count_pending_night_updates(); DROP TABLE pending_night_update_statements');
    }
  });

  it.each(["identity", "ordinal", "sum", "night", "pending-night", "partial"])("refuses an ambiguous or inconsistent %s mapping without mutation", async (corruption) => {
    const snapshot = structuredClone(option);
    const firstEntry = snapshot.guestBreakdown[0]!;
    if (corruption === "identity" && "firstName" in firstEntry) firstEntry.firstName = "Different";
    if (corruption === "ordinal") snapshot.guestBreakdown[1]!.guestIndex = 0;
    if (corruption === "sum") snapshot.guestBreakdown[0]!.totalCents += 1;
    if (corruption === "pending-night") snapshot.guestBreakdown[1]!.nightCount = 1;
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: { acceptedQuoteSnapshot: snapshot,
      ...(corruption === "partial" ? { pendingAdultCount: 1 } : {}),
    } });
    if (corruption === "night") await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: "pending-hold" } } });
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    await expect(nameAdult()).rejects.toMatchObject({ status: 409 });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
    expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ version: 4, acceptedQuoteSnapshot: snapshot });
    expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(2);
  });

  it.each(["snapshot", "identity", "ordinal", "sum", "night", "empty-breakdown", "missing-quote-and-snapshot"])("refuses a corrupted %s mapping at approval before conversion effects", async (corruption) => {
    const quote = await prisma.bookingRequestQuote.create({ data: {
      bookingRequestId: "pending-request", version: 1, status: "ACCEPTED", pricingMode: "OVERALL_TOTAL", options: [option],
    } });
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: {
      schoolName: "Test school", priceCents: option.totalCents, acceptedQuoteId: quote.id, acceptedQuoteOptionId: option.id,
    } });
    await nameAdult();
    await nameAdult(5, "Cara");
    const snapshot = structuredClone(option);
    if (corruption === "identity" && "firstName" in snapshot.guestBreakdown[0]!) snapshot.guestBreakdown[0]!.firstName = "Different";
    if (corruption === "ordinal") snapshot.guestBreakdown[1]!.guestIndex = 0;
    if (corruption === "sum") snapshot.guestBreakdown[0]!.totalCents += 1;
    if (corruption === "empty-breakdown") snapshot.guestBreakdown = [];
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: {
      acceptedQuoteSnapshot: corruption === "snapshot" || corruption === "missing-quote-and-snapshot" ? Prisma.JsonNull : snapshot,
    } });
    if (corruption === "missing-quote-and-snapshot") {
      await prisma.bookingRequestQuote.delete({ where: { id: quote.id } });
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } }))
        .toMatchObject({ acceptedQuoteId: null, acceptedPriceCents: option.totalCents, acceptedQuoteOptionId: option.id });
    }
    if (corruption === "night") await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: "pending-hold" } } });
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    const memberCount = await prisma.member.count();
    const contactCount = await prisma.organisationContact.count();
    await expect(approve({ requestId: "pending-request", adminMemberId: "officer" })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
    expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ status: "ACCEPTED", version: 6 });
    expect(await prisma.member.count()).toBe(memberCount);
    expect(await prisma.organisationContact.count()).toBe(contactCount);
    expect(await prisma.payment.count({ where: { bookingId: "pending-hold" } })).toBe(0);
  });

  it.each(["naming", "approval"])("refuses an unpriced held night before %s without filling it from the quote", async (action) => {
    if (action === "approval") {
      await nameAdult();
      await nameAdult(5, "Cara");
      await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: { schoolName: "Test school", priceCents: option.totalCents } });
    }
    const night = await prisma.bookingGuestNight.findFirstOrThrow({ where: { bookingGuest: { bookingId: "pending-hold" } } });
    await prisma.bookingGuestNight.update({ where: { id: night.id }, data: { priceCents: null, priceSource: "UNKNOWN" } });
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    const request = await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } });
    const reservations = await prisma.bookingRequestPendingAdultReservationNight.findMany({ orderBy: { night: "asc" } });
    const memberCount = await prisma.member.count();
    const contactCount = await prisma.organisationContact.count();
    await expect(action === "naming" ? nameAdult() : approve({ requestId: "pending-request", adminMemberId: "officer" }))
      .rejects.toMatchObject({ status: 409 });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
    expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toEqual(request);
    expect(await prisma.bookingRequestPendingAdultReservationNight.findMany({ orderBy: { night: "asc" } })).toEqual(reservations);
    expect(await prisma.member.count()).toBe(memberCount);
    expect(await prisma.organisationContact.count()).toBe(contactCount);
    expect(await prisma.payment.count({ where: { bookingId: "pending-hold" } })).toBe(0);
  });

  it("persists no held-price or guest side effect when the version claim loses", async () => {
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    await sql.query(`CREATE FUNCTION lose_pending_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER lose_pending_claim BEFORE UPDATE ON "BookingRequest"
      FOR EACH ROW EXECUTE FUNCTION lose_pending_claim()`);
    try {
      await expect(nameAdult()).rejects.toMatchObject({ status: 409 });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ version: 4, pendingAdultCount: 2 });
      expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(2);
    } finally {
      await sql.query('DROP TRIGGER lose_pending_claim ON "BookingRequest"; DROP FUNCTION lose_pending_claim()');
    }
  });

  it("rolls every naming effect back if a held night loses its priced proof after the request claim", async () => {
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    await sql.query(`CREATE FUNCTION invalidate_pending_night_price() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE "BookingGuestNight" SET "priceCents" = NULL, "priceSource" = 'UNKNOWN'
      WHERE id = (SELECT id FROM "BookingGuestNight" WHERE "bookingGuestId" IN
        (SELECT id FROM "BookingGuest" WHERE "bookingId" = 'pending-hold') ORDER BY id LIMIT 1);
      RETURN NEW; END $$;
      CREATE TRIGGER invalidate_pending_night_price AFTER UPDATE ON "BookingRequest"
      FOR EACH ROW EXECUTE FUNCTION invalidate_pending_night_price()`);
    try {
      await expect(nameAdult()).rejects.toMatchObject({ status: 409 });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ version: 4, pendingAdultCount: 2, guests: [teacher] });
      expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(2);
    } finally {
      await sql.query('DROP TRIGGER invalidate_pending_night_price ON "BookingRequest"; DROP FUNCTION invalidate_pending_night_price()');
    }
  });

  it("rolls every naming effect back if a proven night update affects fewer rows", async () => {
    const before = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
    await sql.query(`CREATE FUNCTION lose_pending_night_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER lose_pending_night_update BEFORE UPDATE ON "BookingGuestNight"
      FOR EACH ROW EXECUTE FUNCTION lose_pending_night_update()`);
    try {
      await expect(nameAdult()).rejects.toMatchObject({ status: 409 });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } })).toEqual(before);
      expect(await prisma.bookingRequest.findUniqueOrThrow({ where: { id: "pending-request" } })).toMatchObject({ version: 4, pendingAdultCount: 2, guests: [teacher] });
      expect(await prisma.bookingRequestPendingAdultReservationNight.count()).toBe(2);
    } finally {
      await sql.query('DROP TRIGGER lose_pending_night_update ON "BookingGuestNight"; DROP FUNCTION lose_pending_night_update()');
    }
  });

  it("rolls the request claim and guest creation back when a later guest write fails", async () => {
    const snapshot = { ...option, totalCents: 901, guestBreakdown: option.guestBreakdown.map((entry) => ({ ...entry, totalCents: entry.totalCents + 100 })) };
    await prisma.bookingRequest.update({ where: { id: "pending-request" }, data: { acceptedPriceCents: 901, acceptedQuoteSnapshot: snapshot } });
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
      const hold = await prisma.booking.findUniqueOrThrow({ where: { id: "pending-hold" }, include: { guests: { include: { nights: true } } } });
      expect(hold).toMatchObject({ totalPriceCents: 601, finalPriceCents: 601 });
      expect(hold.guests[0]!.priceCents).toBe(200);
      expect(hold.guests[0]!.nights.map((night) => night.priceCents)).toEqual([100, 100]);
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
