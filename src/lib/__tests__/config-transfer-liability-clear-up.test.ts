import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backup", () => ({ runDatabaseBackup: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(), logAudit: vi.fn() }));
const clearUp = vi.hoisted(() => ({ clearStaleNotRequiredRows: vi.fn() }));
vi.mock("@/lib/member-subscription-defaults", async (importOriginal) => ({
  clearedRowsAuditMetadata: (
    (await importOriginal()) as typeof import("@/lib/member-subscription-defaults")
  ).clearedRowsAuditMetadata,
  clearStaleNotRequiredRows: (...a: unknown[]) => clearUp.clearStaleNotRequiredRows(...a),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

import type { PrismaClient } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import { applyConfigImport } from "@/lib/config-transfer/apply";
import { buildBundle } from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ReadDb } from "@/lib/config-transfer/import-types";
import {
  SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS,
  SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
} from "@/lib/subscription-billing-season-lock";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #5190: a configuration import is the second way a club opts in to a
 * subscription-liability rule, so once it commits it runs the same clear-up the
 * admin route runs — in its own transaction, never nested in the import's.
 */

const DURABLE_BACKUP: BackupResult = {
  success: true,
  filename: "x.sql.gz",
  filepath: "/tmp/x.sql.gz",
  uploadedToS3: true,
  s3Key: "s3/x.sql.gz",
  s3ReadbackVerified: true,
  sizeBytes: 2048,
};

const STORED = {
  mode: "HARD_BLOCK",
  financialYearEndMonthOverride: null,
  textFallbackEnabled: true,
  useFeeScheduleItemCodes: false,
  requiredTypeAgeRule: "NOT_CHOSEN",
  liabilityAgeSource: "NOT_CHOSEN",
};

function bundle(settings: Record<string, unknown>): Uint8Array {
  return buildBundle({
    entries: [
      {
        path: "club-settings/membership-lockout-settings.json",
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(JSON.stringify(settings)),
      },
    ],
    appVersion: "0.14.0",
    prismaMigration: null,
    includedCategories: ["club-settings"],
    doorCodesIncluded: false,
    generatedAt: "2026-09-27T00:00:00.000Z",
  });
}

function store() {
  let row: Record<string, unknown> = { id: "default", ...STORED };
  const membershipLockoutSettings = {
    findUnique: vi.fn(async () => ({ ...row })),
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
      row = { ...row, ...update };
      return { ...row };
    }),
  };
  const tx = { membershipLockoutSettings, $executeRaw: vi.fn(async () => 0) };
  // The second parameter types the transaction options the tests read back.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, _options?: unknown) => fn(tx));
  return {
    tx,
    $transaction,
    readDb: { membershipLockoutSettings } as unknown as ReadDb,
    prisma: { membershipLockoutSettings, $transaction } as unknown as PrismaClient,
    membershipLockoutSettings,
  };
}

async function importIt(settings: Record<string, unknown>) {
  const db = store();
  const zip = bundle(settings);
  const plan = await buildImportPlan(db.readDb, zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
  expect(plan.errors).toEqual([]);
  const result = await applyConfigImport({
    format: CLUB_FORMAT_TEST,
    prisma: db.prisma,
    bundleBytes: zip,
    actorMemberId: "admin-1",
    expectedFingerprint: plan.fingerprint,
    mode: "merge",
    resolutions: [],
  });
  return Object.assign(db, { result });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runDatabaseBackup).mockResolvedValue(DURABLE_BACKUP);
  clearUp.clearStaleNotRequiredRows.mockResolvedValue({ clearedCount: 0, clearedMemberIds: [] });
});

describe("config-transfer import of the subscription-liability rule (#5190)", () => {
  it("runs the clear-up for the club's season in a second transaction after the import commits", async () => {
    const db = await importIt({
      ...STORED,
      requiredTypeAgeRule: "ALWAYS_OWES",
      liabilityAgeSource: "SEASON_END",
    });

    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(clearUp.clearStaleNotRequiredRows).toHaveBeenCalledTimes(1);
    // The frozen test clock is 1 July 2026: season 2026.
    expect(clearUp.clearStaleNotRequiredRows).toHaveBeenCalledWith(db.tx, 2026);
    // The clear-up waits on the billing season key, which a confirm may hold
    // for its whole budget, so its transaction outlasts confirm's.
    expect(db.$transaction.mock.calls[1]![1]).toEqual({
      timeout: SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS,
    });
    expect(SUBSCRIPTION_BILLING_SEASON_WAITER_TIMEOUT_MS).toBeGreaterThan(
      SUBSCRIPTION_BILLING_CONFIRM_TIMEOUT_MS,
    );
    // The import's own write landed before the clear-up began.
    expect(db.membershipLockoutSettings.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      clearUp.clearStaleNotRequiredRows.mock.invocationCallOrder[0]!,
    );
  });

  it("audits the members the clear-up moved, bounded, and writes no extra row when it moved none", async () => {
    clearUp.clearStaleNotRequiredRows.mockResolvedValueOnce({
      clearedCount: 2,
      clearedMemberIds: ["m1", "m2"],
    });
    await importIt({ ...STORED, requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_END" });
    const clearUpAudit = vi
      .mocked(createAuditLog)
      .mock.calls.map(([entry]) => entry)
      .find((entry) => entry.action === "configuration.imported.liability_clear_up");
    expect(clearUpAudit?.metadata).toMatchObject({
      clearedStaleNotRequiredRows: { seasonYear: 2026, total: 2, memberIds: ["m1", "m2"], memberIdsTruncated: false },
    });

    vi.mocked(createAuditLog).mockClear();
    await importIt({ ...STORED, requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_END" });
    expect(
      vi.mocked(createAuditLog).mock.calls.map(([entry]) => entry.action),
    ).not.toContain("configuration.imported.liability_clear_up");
  });

  it("runs no clear-up when the import leaves the lockout settings unchanged", async () => {
    const db = await importIt(STORED);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(clearUp.clearStaleNotRequiredRows).not.toHaveBeenCalled();
  });

  it("reports whether the clear-up ran", async () => {
    expect((await importIt(STORED)).result.liabilityClearUp).toBe("not-run");
    expect(
      (await importIt({ ...STORED, requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_END" }))
        .result.liabilityClearUp,
    ).toBe("done");
  });

  // #5190 review: the import has committed by the time the clear-up runs, so
  // a clear-up failure must not turn it into a refused import.
  it("a failing clear-up still returns the committed import, flagged, with a failure audit", async () => {
    clearUp.clearStaleNotRequiredRows.mockRejectedValueOnce(
      Object.assign(new Error("timed out"), { code: "P2028" }),
    );
    const db = await importIt({ ...STORED, requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "SEASON_END" });
    expect(db.result.liabilityClearUp).toBe("failed");
    // The import's own write and success row stand.
    expect(db.membershipLockoutSettings.upsert).toHaveBeenCalled();
    const entries = vi.mocked(createAuditLog).mock.calls.map(([entry]) => entry);
    expect(entries.map((entry) => entry.action)).toContain("configuration.imported");
    const failure = entries.find(
      (entry) => entry.action === "configuration.imported.liability_clear_up",
    );
    expect(failure).toMatchObject({ outcome: "failure", metadata: { seasonYear: 2026 } });
    expect(failure?.summary).toMatch(/next membership lockout settings save re-runs it/);
    expect((failure?.metadata as { bundleSha256?: string }).bundleSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
