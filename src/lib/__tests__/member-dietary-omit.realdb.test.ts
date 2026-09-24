/**
 * Real-PostgreSQL proof of the dietary/allergy omission (#2941, #3029,
 * `INV-PRIV-022`).
 *
 * Every other dietary test mocks Prisma, so none of them can show that the
 * application client really leaves `Member.dietaryRequirements` out. This suite
 * uses the REAL `@/lib/prisma` client against a real database and asserts the
 * key is ABSENT (not null, absent) from:
 *
 *  1. a top-level read with no select;
 *  2. a nested relation, through both `include` and `select: { rel: true }`;
 *  3. a read inside an interactive transaction;
 *  4. the rows `create` and `update` hand back;
 *
 * and PRESENT through `src/lib/member-dietary.ts`'s explicit select. #3029
 * repeats every one of those proofs for `BookingGuest.dietaryRequirements`,
 * including the booking→guests nesting every booking reader uses, and proves the
 * booking-admin grant reads and edits it while the profile stays untouched.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own `race-2941-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PARENT_ID = "race-2941-parent";
const CHILD_ID = "race-2941-child";
const VALUE = "Severe peanut allergy";
const BOOKING_ID = "race-3029-booking";
const GUEST_ID = "race-3029-guest";
const GUEST_VALUE = "Coeliac — this trip only";

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeDietaryOmitRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Dietary omit proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run dietary omit proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Dietary omit proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Dietary omit proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let dietary: typeof import("@/lib/member-dietary");

async function clear(): Promise<void> {
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [PARENT_ID, CHILD_ID] } } });
  await prisma.member.deleteMany({ where: { id: CHILD_ID } });
  await prisma.member.deleteMany({ where: { id: PARENT_ID } });
}

function hasKey(row: unknown): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    Object.prototype.hasOwnProperty.call(row, "dietaryRequirements")
  );
}

(RUN ? describe : describe.skip)(
  "the application client omits dietary/allergy data in PostgreSQL itself (#2941, INV-PRIV-022)",
  () => {
    let created: unknown;

    beforeAll(async () => {
      assertSafeDietaryOmitRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      dietary = await import("@/lib/member-dietary");
      await clear();
      created = await prisma.member.create({
        data: {
          id: PARENT_ID,
          email: "race-2941-parent@example.invalid",
          passwordHash: "not-a-real-password",
          canLogin: true,
          firstName: "Dietary",
          lastName: "Parent",
          ageTier: "ADULT",
          dietaryRequirements: VALUE,
        },
      });
      await prisma.member.create({
        data: {
          id: CHILD_ID,
          email: "race-2941-child@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Dietary",
          lastName: "Child",
          ageTier: "CHILD",
          parentMemberId: PARENT_ID,
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clear();
    });

    it("the value really is stored (so absence below is the omission, not an empty row)", async () => {
      const rows = await prisma.$queryRaw<{ value: string | null }[]>`
        SELECT "dietaryRequirements" AS value FROM "Member" WHERE id = ${PARENT_ID}`;
      expect(rows[0]?.value).toBe(VALUE);
    });

    it("a top-level read with no select carries no key", async () => {
      const row = await prisma.member.findUnique({ where: { id: PARENT_ID } });
      expect(row).not.toBeNull();
      expect(hasKey(row)).toBe(false);
      const many = await prisma.member.findMany({ where: { id: PARENT_ID } });
      expect(many.some(hasKey)).toBe(false);
    });

    it("a nested relation carries no key, through include and through select", async () => {
      const included = await prisma.member.findUnique({
        where: { id: CHILD_ID },
        include: { parent: true },
      });
      expect(included?.parent?.id).toBe(PARENT_ID);
      expect(hasKey(included?.parent)).toBe(false);

      const selected = await prisma.member.findUnique({
        where: { id: CHILD_ID },
        select: { id: true, parent: true },
      });
      expect(selected?.parent?.id).toBe(PARENT_ID);
      expect(hasKey(selected?.parent)).toBe(false);
    });

    it("a read inside an interactive transaction carries no key", async () => {
      const row = await prisma.$transaction(async (tx) =>
        tx.member.findUnique({ where: { id: PARENT_ID } }),
      );
      expect(row?.id).toBe(PARENT_ID);
      expect(hasKey(row)).toBe(false);
    });

    it("the rows create and update hand back carry no key", async () => {
      expect(hasKey(created)).toBe(false);
      const updated = await prisma.member.update({
        where: { id: PARENT_ID },
        data: { lastName: "Parent" },
      });
      expect(updated.id).toBe(PARENT_ID);
      expect(hasKey(updated)).toBe(false);
    });

    it("the one door's explicit select returns the value", async () => {
      await expect(
        dietary.readMemberDietaryRequirements(
          dietary.grantSelfDietaryAccess({ user: { id: PARENT_ID } }),
          PARENT_ID,
        ),
      ).resolves.toBe(VALUE);
      // The membership grant reads the ACTOR's own row and roles from the
      // database; the parent is given a membership-view role for this.
      await prisma.memberAccessRole.create({
        data: { memberId: PARENT_ID, role: "ADMIN_READONLY" },
      });
      const grant = await dietary.grantMembershipAdminDietaryAccess(
        { ok: true, session: { user: { id: PARENT_ID } } },
        "view",
      );
      // The child holds no admin role, so its row grants nothing.
      await expect(
        dietary.grantMembershipAdminDietaryAccess(
          { ok: true, session: { user: { id: CHILD_ID } } },
          "view",
        ),
      ).resolves.toBeNull();
      expect(grant).not.toBeNull();
      const values = await dietary.readMemberDietaryRequirementsByIds(grant!, [
        PARENT_ID,
        CHILD_ID,
      ]);
      expect(values.get(PARENT_ID)).toBe(VALUE);
      expect(values.get(CHILD_ID)).toBeNull();
    });
  },
);

(RUN ? describe : describe.skip)(
  "the application client omits booking-guest dietary/allergy data in PostgreSQL itself (#3029, INV-PRIV-022)",
  () => {
    let createdBooking: { guests: unknown[] } | undefined;

    beforeAll(async () => {
      assertSafeDietaryOmitRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      dietary = await import("@/lib/member-dietary");
      await clear();
      await prisma.member.create({
        data: {
          id: PARENT_ID,
          email: "race-2941-parent@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Dietary",
          lastName: "Parent",
          ageTier: "ADULT",
          dietaryRequirements: VALUE,
        },
      });
      createdBooking = await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: PARENT_ID,
          checkIn: new Date("2026-08-01T00:00:00.000Z"),
          checkOut: new Date("2026-08-03T00:00:00.000Z"),
          totalPriceCents: 0,
          finalPriceCents: 0,
          guests: {
            create: [
              {
                id: GUEST_ID,
                firstName: "Dietary",
                lastName: "Parent",
                ageTier: "ADULT",
                isMember: true,
                memberId: PARENT_ID,
                stayStart: new Date("2026-08-01T00:00:00.000Z"),
                stayEnd: new Date("2026-08-03T00:00:00.000Z"),
                priceCents: 0,
                dietaryRequirements: GUEST_VALUE,
              },
            ],
          },
        },
        include: { guests: true },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clear();
    });

    it("the value really is stored", async () => {
      const rows = await prisma.$queryRaw<{ value: string | null }[]>`
        SELECT "dietaryRequirements" AS value FROM "BookingGuest" WHERE id = ${GUEST_ID}`;
      expect(rows[0]?.value).toBe(GUEST_VALUE);
    });

    it("a top-level guest read with no select carries no key", async () => {
      const row = await prisma.bookingGuest.findUnique({ where: { id: GUEST_ID } });
      expect(row?.id).toBe(GUEST_ID);
      expect(hasKey(row)).toBe(false);
    });

    it("booking -> guests carries no key, through include, a nested select and a transaction", async () => {
      const included = await prisma.booking.findUnique({
        where: { id: BOOKING_ID },
        include: { guests: true },
      });
      expect(included?.guests).toHaveLength(1);
      expect(included!.guests.some(hasKey)).toBe(false);

      const selected = await prisma.booking.findUnique({
        where: { id: BOOKING_ID },
        select: { id: true, guests: true },
      });
      expect(selected!.guests.some(hasKey)).toBe(false);

      const inTx = await prisma.$transaction(async (tx) =>
        tx.booking.findUnique({ where: { id: BOOKING_ID }, include: { guests: true } }),
      );
      expect(inTx!.guests.some(hasKey)).toBe(false);
    });

    it("the rows create and update hand back carry no key", async () => {
      expect(createdBooking!.guests.some(hasKey)).toBe(false);
      const updated = await prisma.bookingGuest.update({
        where: { id: GUEST_ID },
        data: { lastName: "Parent" },
      });
      expect(hasKey(updated)).toBe(false);
    });

    it("the booking-admin grant reads and edits it, and the profile is never touched (INV-MOD-059)", async () => {
      await prisma.memberAccessRole.create({
        data: { memberId: PARENT_ID, role: "ADMIN" },
      });
      const viewGrant = await dietary.grantBookingAdminDietaryAccess(
        { ok: true, session: { user: { id: PARENT_ID } } },
        "view",
        { enabled: true },
      );
      expect(viewGrant).not.toBeNull();
      const values = await dietary.readBookingGuestDietaryForAdmin(viewGrant!, BOOKING_ID);
      expect(values.get(GUEST_ID)).toBe(GUEST_VALUE);

      const editGrant = await dietary.grantBookingAdminDietaryAccess(
        { ok: true, session: { user: { id: PARENT_ID } } },
        "edit",
        { enabled: true },
      );
      await expect(
        dietary.updateBookingGuestDietaryRequirements(editGrant!, {
          bookingId: BOOKING_ID,
          guestId: GUEST_ID,
          value: "  Vegetarian  ",
        }),
      ).resolves.toMatchObject({ status: "updated", changed: true, value: "Vegetarian" });
      // A guest id paired with the wrong booking matches no row.
      await expect(
        dietary.updateBookingGuestDietaryRequirements(editGrant!, {
          bookingId: "race-3029-other",
          guestId: GUEST_ID,
          value: "x",
        }),
      ).resolves.toEqual({ status: "not-found" });
      const profile = await prisma.$queryRaw<{ value: string | null }[]>`
        SELECT "dietaryRequirements" AS value FROM "Member" WHERE id = ${PARENT_ID}`;
      expect(profile[0]?.value).toBe(VALUE);
    });
  },
);
