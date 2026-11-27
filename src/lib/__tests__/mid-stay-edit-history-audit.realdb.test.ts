import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "race-5242-";
const ZONE = requireClubTimeZone("Pacific/Auckland");
const BOOKED_AT = new Date("2026-06-01T00:00:00.000Z");
// 12 July in Auckland: the middle of a 10-15 July stay.
const MID_STAY = new Date("2026-07-12T00:00:00.000Z");
const NAME = { firstName: "Privatename", lastName: "Fixturesurname" };
let db: PrismaClient;
let audit: typeof import("@/lib/mid-stay-edit-history-audit").auditMidStayEditHistory;

/** The pre-fix batch service's row, as it stored it (`git show 555113fb3^:src/lib/booking-batch-modification-service.ts`). */
function oldWriterRow(
  bookingId: string,
  options: { type?: string; previous?: Record<string, unknown>; next?: Record<string, unknown> } = {},
) {
  const dates = { checkIn: "2026-07-10", checkOut: "2026-07-15" };
  return {
    id: `${PREFIX}mod-${bookingId}`,
    bookingId: PREFIX + bookingId,
    memberId: PREFIX + "officer",
    modificationType: options.type ?? "BATCH_MODIFY",
    createdAt: MID_STAY,
    previousData: {
      ...dates,
      guestCount: 1,
      totalPriceCents: 50000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: 50000,
      removedGuests: [],
      updatedGuests: [],
      ...options.previous,
    },
    newData: {
      ...dates,
      guestCount: 1,
      addedGuests: [],
      updatedGuests: [],
      totalPriceCents: 50000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: 50000,
      ...options.next,
    },
  };
}

const BOOKINGS: Record<string, string> = {
  rebilled: "steady",
  added: "steady",
  officer: "steady",
  unreadable: "steady",
  clean: "steady",
  name_edit: "steady",
  typo_fix: "steady",
  repriced: "repriced",
};

(RUN ? describe : describe.skip)("mid-stay edit history audit in PostgreSQL (#5242)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Mid-stay edit history audit");
    process.env.DATABASE_URL = URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    ({ auditMidStayEditHistory: audit } = await import("@/lib/mid-stay-edit-history-audit"));

    // Two lodges of its own, so another suite's seasons cannot read as a rate change here.
    for (const lodge of ["steady", "repriced"]) {
      await db.lodge.create({ data: { id: PREFIX + lodge, name: `Fixture ${lodge}`, slug: PREFIX + lodge } });
      await db.season.create({
        data: {
          lodgeId: PREFIX + lodge,
          name: "Fixture winter",
          type: "WINTER",
          startDate: new Date("2026-06-01"),
          endDate: new Date("2026-10-31"),
          createdAt: new Date("2026-05-01T00:00:00Z"),
          // The repriced lodge's season was edited after its booking was made.
          updatedAt: new Date(lodge === "repriced" ? "2026-06-20T00:00:00Z" : "2026-05-01T00:00:00Z"),
        },
      });
    }
    await db.member.create({
      data: {
        id: PREFIX + "member",
        firstName: "Fixture",
        lastName: "Member",
        email: "mid-stay-edit-audit@example.invalid",
        passwordHash: "not-a-password",
      },
    });
    for (const [booking, lodge] of Object.entries(BOOKINGS)) {
      await db.booking.create({
        data: {
          id: PREFIX + booking,
          memberId: PREFIX + "member",
          lodgeId: PREFIX + lodge,
          status: "CONFIRMED",
          checkIn: new Date("2026-07-10"),
          checkOut: new Date("2026-07-15"),
          totalPriceCents: 50000,
          finalPriceCents: 50000,
          createdAt: BOOKED_AT,
        },
      });
    }
    // The guest the "added" edit created, priced at $150, two seconds after the edit row.
    await db.bookingGuest.create({
      data: {
        bookingId: PREFIX + "added",
        ...NAME,
        ageTier: "ADULT",
        stayStart: new Date("2026-07-13"),
        stayEnd: new Date("2026-07-15"),
        priceCents: 15000,
        createdAt: new Date(MID_STAY.getTime() + 2_000),
      },
    });
    await db.bookingModification.createMany({
      data: [
        oldWriterRow("rebilled", { next: { totalPriceCents: 60000, finalPriceCents: 60000 } }),
        oldWriterRow("added", { next: { guestCount: 2, addedGuests: [NAME], totalPriceCents: 70000 } }),
        oldWriterRow("officer", {
          type: "DATE_CHANGE",
          next: { checkOut: "2026-07-13", totalPriceCents: 38000, pricingMode: "recalculate", capacityOverridden: false },
        }),
        oldWriterRow("unreadable", { previous: { totalPriceCents: null } }),
        oldWriterRow("repriced", { next: { checkOut: "2026-07-13", totalPriceCents: 42000 } }),
        oldWriterRow("clean", { next: { checkOut: "2026-07-13", totalPriceCents: 30000 } }),
        // A name edit made before #1099 still ran the pricing; a paid booking's spelling fix never did.
        oldWriterRow("name_edit", { type: "GUEST_UPDATE", next: { totalPriceCents: 60000 } }),
        oldWriterRow("typo_fix", { type: "GUEST_TYPO_FIX", next: { totalPriceCents: 60000 } }),
      ],
    });
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    await db.bookingModification.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.booking.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.member.deleteMany({ where: { id: PREFIX + "member" } });
    await db.season.deleteMany({ where: { lodgeId: { startsWith: PREFIX } } });
    await db.lodge.deleteMany({ where: { id: { startsWith: PREFIX } } });
  });

  it("lists each pre-fix mid-stay edit by its shape, a name edit included, and leaves the spelling fix out", async () => {
    const result = await audit({ db, zone: ZONE });

    // Cut off by this database's own record of the marker migration.
    expect(result.cutOff.source).toBe("migration");
    expect(result.cutOff.markerFinishedAt).not.toBeNull();
    expect(result.cutOff.instant.getTime() - result.cutOff.markerFinishedAt!.getTime()).toBe(24 * 60 * 60 * 1000);

    const ours = result.examined.filter((edit) => edit.bookingId.startsWith(PREFIX));
    expect(
      Object.fromEntries(
        ours.map((edit) => [
          edit.bookingId.slice(PREFIX.length),
          edit.findings.map((finding) => [finding.shape, finding.atStakeCents]),
        ]),
      ),
    ).toEqual({
      rebilled: [["rebilled-nothing-bought", 10000]],
      added: [["added-guests-excess", 5000]],
      officer: [["officer-recalculated", 12000]],
      unreadable: [["unreadable", null]],
      repriced: [["give-back-repriced", 8000]],
      clean: [],
      name_edit: [["rebilled-nothing-bought", 10000]],
    });
    expect(ours.every((edit) => edit.memberId === PREFIX + "member" && edit.editedOn === "2026-07-12")).toBe(true);
    expect(JSON.stringify(ours)).not.toContain(NAME.firstName);
  });

  it("examines nothing created at or after an operator's --before", async () => {
    const result = await audit({ db, zone: ZONE, before: MID_STAY });
    expect(result.cutOff.source).toBe("operator");
    expect(result.examined.filter((edit) => edit.bookingId.startsWith(PREFIX))).toEqual([]);
  });
});
