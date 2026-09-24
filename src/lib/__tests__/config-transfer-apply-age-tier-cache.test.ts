import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backup", () => ({ runDatabaseBackup: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(async () => undefined) }));

import type { PrismaClient } from "@prisma/client";

import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import { applyConfigImport } from "@/lib/config-transfer/apply";
import { buildBundle } from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ReadDb } from "@/lib/config-transfer/import-types";

// #2200 — the apply route drops the in-process age-tier cache only when the
// age-tier entity actually changed. applyConfigImport surfaces that signal in
// `appliedEntities`; this proves it is present for an age-tier-changing import
// and ABSENT for one that carries no age tiers, which is exactly what the route
// gates invalidateAgeTierCache() on.

const GENERATED_AT = "2026-07-23T00:00:00.000Z";
const AGE_TIERS_FILE = "membership-fees/age-tiers.csv";

const DURABLE_BACKUP: BackupResult = {
  success: true,
  filename: "x.sql.gz",
  filepath: "/tmp/x.sql.gz",
  uploadedToS3: true,
  s3Key: "s3/x.sql.gz",
  s3ReadbackVerified: true,
  sizeBytes: 2048,
};

// A full four-tier partition. ADULT's label differs from the target below, so
// the import updates exactly one tier (action != unchanged).
const AGE_TIER_CSV =
  "tier,minAge,maxAge,label,subscriptionRequiredForBooking,familyGroupRequestCreateMemberAllowed,sortOrder\n" +
  "INFANT,0,4,Infant (under 5),false,true,0\n" +
  "CHILD,5,9,Child (5-9),false,true,1\n" +
  "YOUTH,10,17,Youth (10-17),true,false,2\n" +
  "ADULT,18,,Adult (18+),true,false,3\n";

function ageTierBundle(): Uint8Array {
  return buildBundle({
    entries: [
      { path: AGE_TIERS_FILE, category: "membership-fees", rowCount: 4, bytes: strToU8(AGE_TIER_CSV) },
    ],
    appVersion: "0.14.0",
    prismaMigration: null,
    includedCategories: ["membership-fees"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

function committeeBundle(): Uint8Array {
  return buildBundle({
    entries: [
      {
        path: "committee/roles.csv",
        category: "committee",
        rowCount: 1,
        bytes: strToU8("key,name,description,contactEmail,isActive,sortOrder\npresident,President,,,true,1\n"),
      },
    ],
    appVersion: "0.14.0",
    prismaMigration: null,
    includedCategories: ["committee"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

// Target already has the four tiers, but ADULT's label is stale → one update.
function currentTiers() {
  return [
    { id: "t-infant", tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
    { id: "t-child", tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 1 },
    { id: "t-youth", tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2 },
    { id: "t-adult", tier: "ADULT", minAge: 18, maxAge: null, label: "Adults", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 3 },
  ];
}

/** DB double covering the delegates the membership-fees category planners read. */
function feesReadDelegates() {
  return {
    ageTierSetting: { findMany: vi.fn(async () => currentTiers()) },
    membershipType: { findMany: vi.fn(async () => []) },
    joiningFee: { findMany: vi.fn(async () => []) },
    membershipAnnualFee: { findMany: vi.fn(async () => []) },
  };
}

function ageTierPlanDb(): ReadDb {
  return feesReadDelegates() as unknown as ReadDb;
}

function ageTierPrisma(): PrismaClient {
  const tx = {
    ...feesReadDelegates(),
    ageTierSetting: {
      findMany: vi.fn(async () => currentTiers()),
      create: vi.fn(async () => ({ id: "new" })),
      update: vi.fn(async () => ({ id: "t-adult" })),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
  return { ...tx, $transaction } as unknown as PrismaClient;
}

function committeePrisma(): PrismaClient {
  const committeeRole = {
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  };
  const tx = { committeeRole, $executeRaw: vi.fn(async () => 0) };
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
  return { committeeRole, $transaction } as unknown as PrismaClient;
}

describe("#2200 applyConfigImport surfaces the age-tier change signal", () => {
  beforeEach(() => {
    vi.mocked(runDatabaseBackup).mockReset();
    vi.mocked(runDatabaseBackup).mockResolvedValue(DURABLE_BACKUP);
  });

  it("includes 'age-tier' in appliedEntities when an import changes a tier", async () => {
    const zip = ageTierBundle();
    const plan = await buildImportPlan(ageTierPlanDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors).toEqual([]);

    const result = await applyConfigImport({
      format: CLUB_FORMAT_TEST,
      prisma: ageTierPrisma(),
      bundleBytes: zip,
      actorMemberId: "admin-1",
      expectedFingerprint: plan.fingerprint,
      mode: "merge",
    });
    // The route drops the age-tier cache precisely on this signal.
    expect(result.appliedEntities).toContain("age-tier");
    expect(result.totals.updated).toBe(1);
  });

  it("does NOT include 'age-tier' for an import that carries no age tiers", async () => {
    const zip = committeeBundle();
    const plan = await buildImportPlan(
      { committeeRole: { findMany: vi.fn(async () => []) } } as unknown as ReadDb,
      zip,
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    const result = await applyConfigImport({
      format: CLUB_FORMAT_TEST,
      prisma: committeePrisma(),
      bundleBytes: zip,
      actorMemberId: "admin-1",
      expectedFingerprint: plan.fingerprint,
      mode: "merge",
    });
    expect(result.appliedEntities).not.toContain("age-tier");
    // Sanity: it DID change something (the committee role), so the empty age-tier
    // result is the gate working, not a no-op import.
    expect(result.appliedEntities).toContain("committee-role");
  });
});
