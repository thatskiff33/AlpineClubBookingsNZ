/**
 * Real-PostgreSQL proof for #5265: after the owner's apply, the nightly prune
 * deletes exactly the older entries over seven years old, keeps an
 * incident-preserved one until ten, and leaves a keep-for-ever row and every
 * column but `expiresAt` as it was.
 *
 * The backfill is tree-wide by design, so the test reads the live totals with
 * a census first and applies with them, as the owner does; every assertion and
 * the prune itself are scoped to this suite's `race-5265` rows.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own rows.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const REQUEST_ID = "race-5265";
const ACTOR_ID = "race-5265-officer";
const NOW = new Date("2026-07-01T00:00:00.000Z");

const SEEDED = [
  // Over seven years old: deleted at the next prune.
  { id: "race-5265-old", createdAt: new Date("2018-03-04T05:06:07.000Z") },
  // Over seven, under ten, incident-preserved: kept by the ten-year floor.
  { id: "race-5265-preserved", createdAt: new Date("2018-03-04T05:06:07.000Z"), incidentPreserved: true },
  // Over ten years old and preserved: the floor has passed too.
  { id: "race-5265-preserved-old", createdAt: new Date("2015-01-01T00:00:00.000Z"), incidentPreserved: true },
  // Recent: gets a future expiry and stays.
  { id: "race-5265-recent", createdAt: new Date("2024-02-29T12:00:00.000Z") },
  // A class and no expiry: the writer's keep-for-ever. Never selected.
  { id: "race-5265-kept", createdAt: new Date("2015-01-01T00:00:00.000Z"), retentionClass: "critical" },
];

let prisma: PrismaClient;
let backfill: typeof import("@/lib/audit-expiry-backfill");
let retention: typeof import("@/lib/audit-retention");
let runId: string | null = null;

async function clean(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { requestId: REQUEST_ID } });
  await prisma.auditLog.deleteMany({ where: { actorMemberId: ACTOR_ID } });
  await prisma.member.deleteMany({ where: { id: ACTOR_ID } });
}

async function seededRows() {
  return prisma.auditLog.findMany({ where: { requestId: REQUEST_ID }, orderBy: { id: "asc" } });
}

(RUN ? describe : describe.skip)("the older-entry expiry backfill against PostgreSQL (#5265)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Audit expiry backfill");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    backfill = await import("@/lib/audit-expiry-backfill");
    retention = await import("@/lib/audit-retention");
    await clean();
    await prisma.member.create({
      data: {
        id: ACTOR_ID,
        email: "race-5265-officer@example.invalid",
        passwordHash: "not-a-real-password",
        firstName: "Expiry",
        lastName: "Officer",
      },
    });
    await prisma.auditLog.createMany({
      data: SEEDED.map((row) => ({
        action: "FAMILY_GROUP_CREATED",
        category: "family",
        summary: `seeded ${row.id}`,
        ipAddress: "203.0.113.5",
        requestId: REQUEST_ID,
        ...row,
      })),
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    if (runId) await prisma.auditLog.deleteMany({ where: { entityId: runId } });
  });

  it("applies with the census's numbers, then the prune deletes only what seven years allows", async () => {
    const before = await seededRows();
    const census = await backfill.runAuditExpiryBackfill({ mode: "census", db: prisma, now: NOW });
    // Other suites may leave older-shaped rows; this suite's four are among them.
    expect(census.total).toBeGreaterThanOrEqual(4);

    const report = await backfill.runAuditExpiryBackfill({
      mode: "apply",
      db: prisma,
      now: NOW,
      batchSize: 2,
      actorMemberId: ACTOR_ID,
      confirmTotal: census.total,
      allowDelete: census.deletableAtNextPrune,
    });
    runId = report.apply!.runId;
    expect(report.apply!.rowsUpdated).toBe(census.total);

    const after = await seededRows();
    for (const row of after) {
      const was = before.find((candidate) => candidate.id === row.id)!;
      const { expiresAt, ...rest } = row;
      const { expiresAt: wasExpiresAt, ...wasRest } = was;
      // Nothing but the expiry changed, and the class stayed empty.
      expect(rest).toEqual(wasRest);
      expect(expiresAt).toEqual(
        row.id === "race-5265-kept" ? wasExpiresAt : backfill.auditBackfillExpiresAt(row.createdAt),
      );
    }
    expect(after.find((row) => row.id === "race-5265-recent")!.expiresAt).toEqual(
      new Date("2031-03-01T12:00:00.000Z"),
    );

    const entries = await prisma.auditLog.findMany({ where: { entityId: runId } });
    expect(entries.length).toBe(report.apply!.batches.length);
    expect(entries.every((entry) => entry.action === "AUDIT_EXPIRY_BACKFILLED" && entry.category === "admin")).toBe(
      true,
    );

    // The real prune predicate, confined to this suite's rows.
    const scoped = {
      auditLog: {
        deleteMany: (args: Prisma.AuditLogDeleteManyArgs) =>
          prisma.auditLog.deleteMany({ where: { AND: [args.where ?? {}, { requestId: REQUEST_ID }] } }),
      },
    } as unknown as Parameters<typeof retention.pruneExpiredAuditLogs>[0];
    const pruned = await retention.pruneExpiredAuditLogs(scoped, NOW);
    expect(pruned.deleted).toBe(2);
    expect((await seededRows()).map((row) => row.id)).toEqual([
      "race-5265-kept",
      "race-5265-preserved",
      "race-5265-recent",
    ]);

    // A second apply finds nothing and writes nothing.
    const again = await backfill.runAuditExpiryBackfill({ mode: "apply", db: prisma, now: NOW, actorMemberId: ACTOR_ID });
    expect(again.total).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: runId } })).toBe(entries.length);
  });
});
