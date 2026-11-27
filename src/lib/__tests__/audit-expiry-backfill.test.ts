/**
 * #5265: older audit entries with no class and no expiry get seven years from
 * the day each was recorded, applied by the owner after reading the counts.
 * The store below evaluates every `where` through the shared `matchesWhere`, so
 * the selector is tested as PostgreSQL would read it, not as a mock assumes.
 * `audit-expiry-backfill.realdb.test.ts` proves the same against PostgreSQL,
 * with the nightly prune.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { getAuditRetentionExpiresAt } from "@/lib/audit";
import {
  AUDIT_EXPIRY_BACKFILL_ACTION,
  AuditExpiryBackfillRefusal,
  formatAuditExpiryBackfillReport,
  runAuditExpiryBackfill,
  type AuditExpiryBackfillDb,
} from "@/lib/audit-expiry-backfill";

const NOW = new Date("2026-07-01T00:00:00.000Z");

type Row = {
  id: string;
  action: string;
  category: string | null;
  severity: string | null;
  createdAt: Date;
  retentionClass: string | null;
  expiresAt: Date | null;
  incidentPreserved: boolean;
  [column: string]: unknown;
};

function row(overrides: Partial<Row> & Pick<Row, "id" | "createdAt">): Row {
  return {
    action: "FAMILY_GROUP_CREATED",
    category: "family",
    severity: null,
    retentionClass: null,
    expiresAt: null,
    incidentPreserved: false,
    ...overrides,
  };
}

function compare(a: Row, b: Row): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

function makeDb(initial: Row[], options: { canUpdateExpiresAt?: boolean; members?: string[] } = {}) {
  const rows = initial.map((r) => ({ ...r }));
  const created: Record<string, unknown>[] = [];
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  const pick = (where: unknown) =>
    rows.filter((r) => matchesWhere(r, where as Record<string, unknown>));
  const auditLog = {
    findMany: vi.fn(async (args: { where: unknown; take?: number; select: Record<string, boolean> }) =>
      pick(args.where)
        .sort(compare)
        .slice(0, args.take ?? Infinity)
        .map((r) => Object.fromEntries(Object.keys(args.select).map((key) => [key, r[key]]))),
    ),
    count: vi.fn(async (args: { where: unknown }) => pick(args.where).length),
    updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      updates.push(args);
      const hit = pick(args.where);
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data);
      rows.push({ id: `created-${created.length}`, createdAt: NOW, ...(args.data as object) } as Row);
      return args.data;
    }),
  };
  const members = new Set(options.members ?? ["officer-1"]);
  const db = {
    auditLog,
    member: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        members.has(args.where.id) ? { id: args.where.id } : null,
      ),
    },
    $queryRaw: vi.fn(async () => [{ allowed: options.canUpdateExpiresAt ?? true }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ auditLog })),
  };
  return { db: db as unknown as AuditExpiryBackfillDb, rows, created, updates, raw: db };
}

const OLD = new Date("2018-03-04T05:06:07.000Z"); // over seven years before NOW
const LEAP = new Date("2020-02-29T12:00:00.000Z");
const RECENT = new Date("2025-11-01T00:00:00.000Z");

function fixture(): Row[] {
  return [
    row({ id: "old", createdAt: OLD }),
    row({ id: "leap", createdAt: LEAP }),
    row({ id: "recent", createdAt: RECENT, action: "admin.member.view", category: "admin" }),
    row({ id: "preserved", createdAt: OLD, incidentPreserved: true, action: "LODGE_CAPACITY_HOLD" }),
    // Never selected: a class with no expiry is the writer's keep-for-ever.
    row({ id: "kept", createdAt: OLD, retentionClass: "critical" }),
    // Never selected: already has an expiry.
    row({ id: "has-expiry", createdAt: OLD, expiresAt: new Date("2030-01-01T00:00:00.000Z") }),
  ];
}

describe("runAuditExpiryBackfill (#5265)", () => {
  let store: ReturnType<typeof makeDb>;

  beforeEach(() => {
    store = makeDb(fixture());
  });

  it("selects only rows with neither a class nor an expiry, and counts the keep-for-ever rows apart", async () => {
    const report = await runAuditExpiryBackfill({ mode: "census", db: store.db, now: NOW });

    expect(report.total).toBe(4);
    expect(report.keptForeverWithClass).toBe(1);
    expect(report.kinds.map((kind) => kind.action).sort()).toEqual(
      ["FAMILY_GROUP_CREATED", "LODGE_CAPACITY_HOLD", "admin.member.view"].sort(),
    );
    // "old" is past seven years and goes at the next prune; "preserved" is past
    // seven years but held by the ten-year floor.
    expect(report.alreadyExpired).toBe(2);
    expect(report.deletableAtNextPrune).toBe(1);
    expect(report.incidentPreserved).toEqual({ count: 1, heldByTenYearFloor: 1 });
  });

  it("gives each row the writer's own seven-year expiry from its recorded date, leap day included", async () => {
    await runAuditExpiryBackfill({
      mode: "apply",
      db: store.db,
      now: NOW,
      actorMemberId: "officer-1",
      confirmTotal: 4,
      allowDelete: 1,
    });

    const byId = Object.fromEntries(store.rows.map((r) => [r.id, r]));
    for (const id of ["old", "leap", "recent", "preserved"]) {
      expect(byId[id]!.expiresAt).toEqual(getAuditRetentionExpiresAt("critical", byId[id]!.createdAt));
      expect(byId[id]!.retentionClass).toBeNull();
    }
    expect(byId.leap!.expiresAt).toEqual(new Date("2027-03-01T12:00:00.000Z"));
    expect(byId.kept!.expiresAt).toBeNull();
    expect(byId["has-expiry"]!.expiresAt).toEqual(new Date("2030-01-01T00:00:00.000Z"));
    // Every write names the selector, so a row that changed since it was read is left alone.
    for (const update of store.updates) {
      expect(update.where).toMatchObject({ retentionClass: null, expiresAt: null });
      expect(Object.keys(update.data)).toEqual(["expiresAt"]);
    }
  });

  it("lists a kind classed shorter today on its own, yet still gives it seven years", async () => {
    const report = await runAuditExpiryBackfill({ mode: "census", db: store.db, now: NOW });

    expect(report.shorterClassKinds).toEqual([
      expect.objectContaining({
        action: "admin.member.view",
        writerRetentionClass: "sensitive_access",
        writerRetentionPeriod: "2 years",
      }),
    ]);
    const viewLine = report.kinds.find((kind) => kind.action === "admin.member.view")!;
    expect(viewLine.latestNewExpiresAt).toBe("2032-11-01T00:00:00.000Z");
    expect(formatAuditExpiryBackfillReport(report)).toContain(
      "as decided, these older ones still get seven years",
    );
  });

  it.each(["census", "dry-run"] as const)("%s writes nothing", async (mode) => {
    await runAuditExpiryBackfill({ mode, db: store.db, now: NOW });

    expect(store.raw.auditLog.updateMany).not.toHaveBeenCalled();
    expect(store.raw.auditLog.create).not.toHaveBeenCalled();
    expect(store.raw.$transaction).not.toHaveBeenCalled();
  });

  it("dry run prints the exact apply command for what it read", async () => {
    const report = await runAuditExpiryBackfill({ mode: "dry-run", db: store.db, now: NOW, batchSize: 3 });

    expect(report.plannedBatches).toBe(2);
    expect(report.applyCommand).toBe(
      "pnpm run audit:expiry-backfill -- --apply --actor <your-member-id> --confirm-total 4 --allow-delete 1 --batch-size 3",
    );
  });

  it("records one admin audit entry per batch, and a second apply changes nothing", async () => {
    const report = await runAuditExpiryBackfill({
      mode: "apply",
      db: store.db,
      now: NOW,
      batchSize: 3,
      actorMemberId: "officer-1",
      confirmTotal: 4,
      allowDelete: 1,
    });

    expect(report.apply?.batches).toEqual([
      { batchNumber: 1, rowsUpdated: 3 },
      { batchNumber: 2, rowsUpdated: 1 },
    ]);
    expect(store.created).toHaveLength(2);
    expect(store.created[0]).toMatchObject({
      action: AUDIT_EXPIRY_BACKFILL_ACTION,
      category: "admin",
      entityType: "AuditLog",
      entityId: report.apply!.runId,
      actorMemberId: "officer-1",
      retentionClass: "critical",
      metadata: {
        runId: report.apply!.runId,
        batchNumber: 1,
        rowsUpdated: 3,
        // Oldest first: both 2018 rows, then the leap-day row.
        countsByAction: { FAMILY_GROUP_CREATED: 2, LODGE_CAPACITY_HOLD: 1 },
        createdFrom: OLD.toISOString(),
        createdTo: LEAP.toISOString(),
        alreadyExpired: 2,
        source: "#5265",
      },
    });

    store.raw.auditLog.updateMany.mockClear();
    const again = await runAuditExpiryBackfill({
      mode: "apply",
      db: store.db,
      now: NOW,
      actorMemberId: "officer-1",
      confirmTotal: 4,
      allowDelete: 1,
    });
    expect(again.total).toBe(0);
    expect(again.apply).toBeNull();
    expect(store.raw.auditLog.updateMany).not.toHaveBeenCalled();
    expect(store.created).toHaveLength(2);
  });

  it.each([
    ["no actor", { actorMemberId: null, confirmTotal: 4, allowDelete: 1 }, /--actor/],
    ["an actor who is not a member", { actorMemberId: "nobody", confirmTotal: 4, allowDelete: 1 }, /No member/],
    ["no confirmed total", { actorMemberId: "officer-1", allowDelete: 1 }, /live total, 4/],
    ["a stale total", { actorMemberId: "officer-1", confirmTotal: 3, allowDelete: 1 }, /live total, 4/],
    ["no deletion count when rows would be deleted", { actorMemberId: "officer-1", confirmTotal: 4 }, /deleted for good/],
    ["a wrong deletion count", { actorMemberId: "officer-1", confirmTotal: 4, allowDelete: 2 }, /deleted for good/],
  ])("refuses %s and writes nothing", async (_label, options, message) => {
    await expect(
      runAuditExpiryBackfill({ mode: "apply", db: store.db, now: NOW, ...options }),
    ).rejects.toThrow(message);

    expect(store.raw.auditLog.updateMany).not.toHaveBeenCalled();
    expect(store.raw.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a connection that may not change an expiry, naming the operator connection", async () => {
    store = makeDb(fixture(), { canUpdateExpiresAt: false });

    const run = runAuditExpiryBackfill({
      mode: "apply",
      db: store.db,
      now: NOW,
      actorMemberId: "officer-1",
      confirmTotal: 4,
      allowDelete: 1,
    });
    await expect(run).rejects.toBeInstanceOf(AuditExpiryBackfillRefusal);
    await expect(run).rejects.toThrow(/operator connection/);
    expect(store.raw.auditLog.updateMany).not.toHaveBeenCalled();
    expect(store.raw.auditLog.create).not.toHaveBeenCalled();
  });

  it("asks for no deletion count when nothing is past seven years", async () => {
    store = makeDb([row({ id: "recent", createdAt: RECENT })]);

    const report = await runAuditExpiryBackfill({
      mode: "apply",
      db: store.db,
      now: NOW,
      actorMemberId: "officer-1",
      confirmTotal: 1,
    });

    expect(report.apply?.rowsUpdated).toBe(1);
  });
});
