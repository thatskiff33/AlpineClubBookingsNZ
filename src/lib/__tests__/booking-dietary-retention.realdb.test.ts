import type { PrismaClient, PrivacyRetentionSettings } from "@prisma/client";
import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const PREFIX = "race-4916-";
let db: PrismaClient;
let previous: PrivacyRetentionSettings | null;
let run: typeof import("@/lib/privacy-retention-jobs").runBookingDietaryClearJob;

(RUN ? describe : describe.skip)("after-stay dietary retention in PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Booking dietary retention");
    process.env.DATABASE_URL = URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    ({ runBookingDietaryClearJob: run } = await import("@/lib/privacy-retention-jobs"));
    previous = await db.privacyRetentionSettings.findUnique({ where: { id: "default" } });
    const { DEFAULT_PRIVACY_RETENTION_SETTINGS } = await import("@/lib/privacy-retention-shared");
    await db.privacyRetentionSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...DEFAULT_PRIVACY_RETENTION_SETTINGS },
      update: { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, bookingDietaryClearStartedAt: null },
    });
    await db.member.create({ data: {
      id: PREFIX + "member", firstName: "Fixture", lastName: "Member",
      email: "dietary-retention@example.invalid", passwordHash: "not-a-password", dietaryRequirements: "Profile fixture",
    } });
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      await db.booking.create({ data: {
        id: PREFIX + status, memberId: PREFIX + "member", status,
        checkIn: new Date("2026-05-01"), checkOut: new Date("2026-08-02"),
        totalPriceCents: 0, finalPriceCents: 0,
      } });
    }
    for (const member of [false, true]) {
      for (const [label, stayEnd] of [
        ["expired", "2026-05-31"], ["boundary", "2026-06-01"], ["inside", "2026-06-02"],
        ["today", "2026-07-01"], ["future", "2026-08-02"], ["cancelled", "2026-05-31"],
      ]) {
        await db.bookingGuest.create({ data: {
          id: `${PREFIX}${member}-${label}`, bookingId: PREFIX + (label === "cancelled" ? "CANCELLED" : "COMPLETED"),
          firstName: "Fixture", lastName: "Guest", ageTier: "ADULT", priceCents: 0,
          isMember: member, memberId: member ? PREFIX + "member" : null,
          stayStart: new Date(label === "future" ? "2026-08-01" : "2026-05-01"),
          stayEnd: new Date(stayEnd!), dietaryRequirements: "Stay fixture",
        } });
      }
    }
  }, 30_000);
  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { action: "privacy.retention.booking_dietary_cleared", createdAt: NOW } });
    await db.bookingGuest.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.booking.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.member.deleteMany({ where: { id: PREFIX + "member" } });
    if (previous) await db.privacyRetentionSettings.update({ where: { id: "default" }, data: previous });
    else await db.privacyRetentionSettings.deleteMany({ where: { id: "default" } });
  });
  it("keeps the exact cutoff, today's and future stays, clears both guest types and cancelled stays, and reruns idempotently", async () => {
    const { getPrivacyRetentionPreview } = await import("@/lib/privacy-retention");
    expect((await getPrivacyRetentionPreview({ db, now: NOW, includeMembers: false })).clearedBookingDietary).toBe(4);
    expect(await run({ db, now: NOW })).toMatchObject({ clearedBookingDietary: 4 });
    const rows = await db.bookingGuest.findMany({
      where: { id: { startsWith: PREFIX } }, select: { id: true, dietaryRequirements: true, firstName: true, priceCents: true },
    });
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.dietaryRequirements).toBe(/-(expired|cancelled)$/.test(row.id) ? null : "Stay fixture");
      expect(row).toMatchObject({ firstName: "Fixture", priceCents: 0 });
    }
    expect(await db.member.findUnique({ where: { id: PREFIX + "member" }, select: { dietaryRequirements: true } }))
      .toEqual({ dietaryRequirements: "Profile fixture" });
    expect(await run({ db, now: NOW })).toMatchObject({ clearedBookingDietary: 0 });
    const audits = await db.auditLog.findMany({ where: { action: "privacy.retention.booking_dietary_cleared" }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits.every(row => row.category === "privacy")).toBe(true);
    expect(audits.map(row => row.metadata)).toEqual(expect.arrayContaining([{ count: 4 }, { count: 0 }]));
    expect(JSON.stringify(audits)).not.toContain("Stay fixture");
  });
  it("writes nothing with the independent switch off", async () => {
    await db.privacyRetentionSettings.update({ where: { id: "default" }, data: { bookingDietaryClearEnabled: false } });
    await db.bookingGuest.update({ where: { id: PREFIX + "false-expired" }, data: { dietaryRequirements: "Re-entered fixture" } });
    expect(await run({ db, now: NOW })).toMatchObject({ skipped: "disabled", clearedBookingDietary: 0 });
    expect(await db.bookingGuest.findUnique({ where: { id: PREFIX + "false-expired" }, select: { dietaryRequirements: true } }))
      .toEqual({ dietaryRequirements: "Re-entered fixture" });
  });
});
