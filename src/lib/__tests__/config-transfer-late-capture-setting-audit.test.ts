import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backup", () => ({ runDatabaseBackup: vi.fn() }));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn(), logAudit: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => audit.createAuditLog(...a),
  logAudit: (...a: unknown[]) => audit.logAudit(...a),
}));

import type { PrismaClient } from "@prisma/client";
import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import { applyConfigImport } from "@/lib/config-transfer/apply";
import { buildBundle } from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ReadDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3639 (delta D8): a configuration import that switches the club between
 * automatic late-capture refunds and treasurer approval writes the SAME
 * payment-category audit entry the Cancellation page does, so a treasurer
 * filtering the audit log by payment sees every switch however it was made.
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
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 7,
  waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
  linkedMoveChargesBothChangeFees: true,
  lateCaptureRefundNeedsApproval: false,
};

function bundle(lateCaptureRefundNeedsApproval: boolean): Uint8Array {
  const json = JSON.stringify({ ...STORED, lateCaptureRefundNeedsApproval });
  return buildBundle({
    entries: [
      {
        path: "club-settings/booking-defaults.json",
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(json),
      },
    ],
    appVersion: "0.14.0",
    prismaMigration: null,
    includedCategories: ["club-settings"],
    doorCodesIncluded: false,
    generatedAt: "2026-09-27T00:00:00.000Z",
  });
}

/** A one-row BookingDefaults the import reads, writes and reads back. */
function store() {
  let row: Record<string, unknown> = { id: "default", ...STORED };
  const bookingDefaults = {
    findUnique: vi.fn(async () => ({ ...row })),
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
      row = { ...row, ...update };
      return { ...row };
    }),
  };
  const tx = { bookingDefaults, $executeRaw: vi.fn(async () => 0) };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
  return {
    readDb: { bookingDefaults } as unknown as ReadDb,
    prisma: { bookingDefaults, $transaction } as unknown as PrismaClient,
  };
}

async function importIt(lateCaptureRefundNeedsApproval: boolean) {
  const db = store();
  const zip = bundle(lateCaptureRefundNeedsApproval);
  const plan = await buildImportPlan(db.readDb, zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
  expect(plan.errors).toEqual([]);
  await applyConfigImport({
    format: CLUB_FORMAT_TEST,
    prisma: db.prisma,
    bundleBytes: zip,
    actorMemberId: "admin-1",
    expectedFingerprint: plan.fingerprint,
    mode: "merge",
    resolutions: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runDatabaseBackup).mockResolvedValue(DURABLE_BACKUP);
});

describe("config-transfer import of the late-capture refund setting (#3639 delta D8)", () => {
  it("writes the payment-category entry when the import switches it", async () => {
    await importIt(true);

    expect(audit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-defaults.late_capture_refund_approval.changed",
        category: "payment",
        memberId: "admin-1",
        details: JSON.stringify({
          before: "refund_automatically",
          after: "treasurer_approves",
          via: "configuration-import",
        }),
      }),
    );
  });

  it("writes nothing extra when the import leaves it as it was", async () => {
    await importIt(false);

    expect(audit.logAudit).not.toHaveBeenCalled();
  });
});
