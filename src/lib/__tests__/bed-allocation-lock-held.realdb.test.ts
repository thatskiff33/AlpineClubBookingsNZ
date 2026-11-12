import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

describe.skipIf(!RUN)("bed allocation lock preconditions in PostgreSQL", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Bed allocation lock preconditions");
    const [{ PrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"), import("@/lib/prisma-adapter"),
    ]);
    db = new PrismaClient({ adapter: createPrismaPgAdapter(URL) });
  });
  afterAll(async () => { await db?.$disconnect(); });

  it("recognises signed bigint lodge keys, the right backend and transaction lifetime", async () => {
    const { acquireLodgeCapacityLock, assertLodgeCapacityLockHeld } = await import("@/lib/lodge-capacity-lock");
    // These inputs exercise both halves of PostgreSQL's signed hash range.
    const signs = new Set<boolean>();
    for (const lodgeId of ["lock-proof-a", "lock-proof-b", "lock-proof-c", "lock-proof-d"]) {
      await db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ key: bigint }[]>`SELECT hashtextextended(${lodgeId}, 0) AS key`;
        signs.add(row!.key < 0n);
        await acquireLodgeCapacityLock(tx, lodgeId);
        await expect(assertLodgeCapacityLockHeld(tx, lodgeId, "proof")).resolves.toBeUndefined();
        await expect(assertLodgeCapacityLockHeld(tx, "other-lodge", "proof")).rejects.toMatchObject({ name: "LodgeCapacityLockNotHeldError" });
        await db.$transaction(async (other) => {
          await expect(assertLodgeCapacityLockHeld(other, lodgeId, "proof")).rejects.toMatchObject({ name: "LodgeCapacityLockNotHeldError" });
        });
      });
      await db.$transaction(async (tx) => {
        await expect(assertLodgeCapacityLockHeld(tx, lodgeId, "proof")).rejects.toMatchObject({ name: "LodgeCapacityLockNotHeldError" });
      });
    }
    expect(signs).toEqual(new Set([true, false]));
  });

  it("refuses reconciliation without global or lodge, and accepts both", async () => {
    const { reconcileBedAllocationsForBookingWithLodgeLockHeld } = await import("@/lib/bed-allocation-lifecycle");
    const { acquireLodgeCapacityLock } = await import("@/lib/lodge-capacity-lock");
    // Roll the fixture back, even after the successful call.
    const rollback = new Error("fixture rollback");
    await expect(db.$transaction(async (tx) => {
      const lodge = await tx.lodge.create({ data: { name: "Lock proof", slug: "lock-held-proof" } });
      const member = await tx.member.create({ data: {
        email: "lock-held-proof@example.test", passwordHash: "unused-test-hash",
        firstName: "Lock", lastName: "Proof",
      } });
      const booking = await tx.booking.create({ data: {
        memberId: member.id, lodgeId: lodge.id, status: "CANCELLED",
        checkIn: new Date("2026-07-02T00:00:00.000Z"),
        checkOut: new Date("2026-07-03T00:00:00.000Z"),
        totalPriceCents: 0, finalPriceCents: 0,
      } });
      const run = () => reconcileBedAllocationsForBookingWithLodgeLockHeld({ db: tx, bookingId: booking.id });
      await expect(run()).rejects.toMatchObject({ name: "GlobalLockNotHeldError" });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await expect(run()).rejects.toMatchObject({ name: "LodgeCapacityLockNotHeldError" });
      await acquireLodgeCapacityLock(tx, lodge.id);
      await expect(run()).resolves.toMatchObject({ deletedCount: 0, createdCount: 0 });
      throw rollback;
    }, { timeout: 15_000 })).rejects.toBe(rollback);
  });
});
