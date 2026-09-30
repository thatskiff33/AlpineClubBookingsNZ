#!/usr/bin/env -S pnpm exec tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ACCESS_ROLE_CLEANUP_MIGRATION =
  "20260629160000_access_roles_membership_type_cleanup";
const USER_ROLE_RENAME_MIGRATION = "20260630120000_rename_member_role_to_user";
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

type GuardResult =
  | { ok: true; databaseName: string; host: string }
  | { ok: false; reason: string };

export type AuditSnapshot = {
  memberRoles: Record<string, number>;
  financeAccessLevels: Record<string, number>;
  accessRoles: Record<string, number>;
  membershipTypes: Record<string, number>;
  seasonalAssignments: Record<string, number>;
  xeroRulesByMode: Record<string, number>;
  xeroRulesByAgeTier: Record<string, number>;
  // `familyGroupRoles` was REMOVED by #2520, for the same reason and by the same
  // pattern as #2130's `managedAgeTierSettings` (see the note in collectSnapshot's
  // `metrics` block): this script is retired and never executes, so the snapshot
  // loses no live coverage, and dropping it stopped dead code naming a
  // FamilyGroupMember column that 20260803030000 has since dropped outright.
  metrics: Record<string, number>;
};

export type AuditCheck = {
  label: string;
  expected: number;
  actual: number;
  ok: boolean;
};

export type AuditEvaluation = {
  checks: AuditCheck[];
  warnings: string[];
};

type PsqlOptions = {
  databaseUrl: string;
  sql?: string;
  file?: string;
  capture?: boolean;
};

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DISPOSABLE_DATABASE_NAME_PATTERN =
  /(audit|scratch|test|tmp|temp|disposable|rehearsal)/i;

function asCount(value: number | undefined): number {
  return value ?? 0;
}

function addCheck(
  checks: AuditCheck[],
  label: string,
  expected: number,
  actual: number,
): void {
  checks.push({
    label,
    expected,
    actual,
    ok: expected === actual,
  });
}

export function checkDisposableLocalDatabaseUrl(
  databaseUrl: string | undefined,
): GuardResult {
  if (!databaseUrl) {
    return { ok: false, reason: "DATABASE_URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a valid URL." };
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    return {
      ok: false,
      reason: "DATABASE_URL must use the postgresql:// protocol.",
    };
  }

  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `Refusing to run against non-local database host ${host}.`,
    };
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!databaseName) {
    return { ok: false, reason: "DATABASE_URL must include a database name." };
  }

  if (databaseName === "postgres") {
    return {
      ok: false,
      reason: "Refusing to reset the default postgres maintenance database.",
    };
  }

  if (!DISPOSABLE_DATABASE_NAME_PATTERN.test(databaseName)) {
    return {
      ok: false,
      reason:
        "Database name must include audit, scratch, test, tmp, temp, disposable, or rehearsal.",
    };
  }

  return { ok: true, databaseName, host };
}

export function parseKeyCountRows(stdout: string): Record<string, number> {
  const rows: Record<string, number> = {};

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const [key, countText] = line.split("\t");
    const count = Number.parseInt(countText ?? "", 10);

    if (!key || !Number.isFinite(count)) {
      throw new Error(`Unexpected psql count row: ${line}`);
    }

    rows[key] = count;
  }

  return rows;
}

export function evaluateAuditSnapshots(
  before: AuditSnapshot,
  after: AuditSnapshot,
): AuditEvaluation {
  const checks: AuditCheck[] = [];
  const warnings: string[] = [];

  const expectedUserMembers =
    asCount(before.memberRoles.MEMBER) +
    asCount(before.memberRoles.ASSOCIATE) +
    asCount(before.memberRoles.LIFE);
  addCheck(checks, "Member.role USER after cleanup", expectedUserMembers, asCount(after.memberRoles.USER));
  addCheck(checks, "Legacy Member.role MEMBER removed", 0, asCount(after.memberRoles.MEMBER));
  addCheck(checks, "Legacy Member.role ASSOCIATE removed", 0, asCount(after.memberRoles.ASSOCIATE));
  addCheck(checks, "Legacy Member.role LIFE removed", 0, asCount(after.memberRoles.LIFE));

  addCheck(checks, "AccessRole USER backfill", expectedUserMembers, asCount(after.accessRoles.USER));
  addCheck(checks, "AccessRole ADMIN backfill", asCount(before.memberRoles.ADMIN), asCount(after.accessRoles.ADMIN));
  addCheck(checks, "AccessRole LODGE backfill", asCount(before.memberRoles.LODGE), asCount(after.accessRoles.LODGE));
  addCheck(
    checks,
    "AccessRole FINANCE_USER backfill",
    asCount(before.financeAccessLevels.VIEWER),
    asCount(after.accessRoles.FINANCE_USER),
  );
  addCheck(
    checks,
    "AccessRole FINANCE_ADMIN backfill",
    asCount(before.financeAccessLevels.MANAGER),
    asCount(after.accessRoles.FINANCE_ADMIN),
  );
  addCheck(
    checks,
    "AccessRole ORG school login backfill",
    asCount(before.metrics.schoolLoginMembers),
    asCount(after.accessRoles.ORG),
  );

  addCheck(checks, "SCHOOL MembershipType seeded", 1, asCount(after.membershipTypes.SCHOOL));
  addCheck(checks, "NON_MEMBER MembershipType seeded", 1, asCount(after.membershipTypes.NON_MEMBER));
  addCheck(checks, "FAMILY MembershipType seeded", 1, asCount(after.membershipTypes.FAMILY));
  addCheck(checks, "RESERVE MembershipType removed", 0, asCount(after.membershipTypes.RESERVE));

  const expectedAssociateAssignments =
    asCount(before.seasonalAssignments.ASSOCIATE) +
    asCount(before.seasonalAssignments.RESERVE);
  addCheck(
    checks,
    "RESERVE assignments merged into ASSOCIATE",
    expectedAssociateAssignments,
    asCount(after.seasonalAssignments.ASSOCIATE),
  );
  addCheck(checks, "RESERVE assignments removed", 0, asCount(after.seasonalAssignments.RESERVE));
  addCheck(
    checks,
    "RESERVE migrated sourceDetail rows",
    asCount(before.seasonalAssignments.RESERVE),
    asCount(after.metrics.reserveSourceDetailRows),
  );

  addCheck(
    checks,
    "SCHOOL current-season assignments moved from FULL",
    asCount(before.metrics.schoolFullAssignments),
    asCount(after.metrics.schoolSchoolAssignments),
  );
  addCheck(
    checks,
    "NON_MEMBER current-season assignments moved from FULL",
    asCount(before.metrics.nonMemberFullAssignments),
    asCount(after.metrics.nonMemberNonMemberAssignments),
  );
  addCheck(
    checks,
    "Legacy non-member sourceDetail rows",
    asCount(before.metrics.schoolFullAssignments) +
      asCount(before.metrics.nonMemberFullAssignments),
    asCount(after.metrics.legacyNonMemberSourceDetailRows),
  );

  addCheck(
    checks,
    "MembershipType age-tier rows seeded",
    17,
    asCount(after.metrics.membershipTypeAgeTierRows),
  );
  // The "Managed Xero age-tier rules backfilled" check was REMOVED by #2130.
  // Decisive reason: this whole script is already RETIRED and never executes —
  // main() returns immediately once the 20260720120000 contraction migration
  // exists, and it shipped in v0.12.2 (see RETIRING_CONTRACTION_MIGRATION
  // below). evaluateAuditSnapshots is unreachable outside its unit test, so no
  // live audit coverage is lost. Removing the check simply stops the retired
  // script's SQL naming AgeTierSetting."xeroContactGroupId" at all, ahead of
  // the #2130 STEP 2 contract migration that drops it. (Secondary: the check
  // could not have been re-sourced from XeroContactGroupRule anyway — the
  // dropped column was the backfill's own input and the "before" snapshot
  // predates that table.) The ACCEPTED half below is unaffected: it reads the
  // separate AgeTierXeroAcceptedContactGroup fixture.
  addCheck(
    checks,
    "Accepted Xero age-tier rules backfilled",
    asCount(before.metrics.acceptedAgeTierGroups),
    asCount(after.xeroRulesByMode.ACCEPTED),
  );
  addCheck(
    checks,
    "Family-group join rows preserved",
    asCount(before.metrics.familyGroupMemberRows),
    asCount(after.metrics.familyGroupMemberRows),
  );
  // The "FamilyGroupMember group-local MEMBER labels preserved" check was
  // REMOVED by #2520, exactly as #2130 removed the "Managed Xero age-tier rules
  // backfilled" check above and for the same reasons. The script is retired and
  // unreachable outside its unit test (main() returns immediately once the
  // 20260720120000 contraction migration exists, shipped in v0.12.2), so no live
  // audit coverage is lost; removing it stopped the retired script's SQL naming
  // a FamilyGroupMember column that 20260803030000 has since dropped. The
  // "Family-group join rows preserved" check above is the one that mattered —
  // it counts the join ROWS, which is the fact the cleanup could have damaged.
  // The role labels never carried a grant at all (#2284).

  if (
    asCount(before.seasonalAssignments.RESERVE) > 0 &&
    asCount(before.seasonalAssignments.ASSOCIATE) > 0
  ) {
    warnings.push(
      "Both RESERVE and ASSOCIATE had assignments before cleanup. Assignments are preserved, but the single ASSOCIATE built-in cannot retain two display labels; review operator-facing Reserve wording before production.",
    );
  }

  return { checks, warnings };
}

function runPsql({ databaseUrl, sql, file, capture = false }: PsqlOptions): string {
  const args = [
    "--dbname",
    databaseUrl,
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--quiet",
  ];

  if (capture) {
    args.push("--tuples-only", "--no-align", "--field-separator", "\t");
  }

  if (sql) {
    args.push("--command", sql);
  }

  if (file) {
    args.push("--file", file);
  }

  const result = spawnSync("psql", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        "psql command failed.",
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function queryCounts(databaseUrl: string, sql: string): Record<string, number> {
  return parseKeyCountRows(runPsql({ databaseUrl, sql, capture: true }));
}

function queryNumber(databaseUrl: string, sql: string): number {
  const output = runPsql({ databaseUrl, sql, capture: true }).trim();
  return Number.parseInt(output || "0", 10);
}

function tableExists(databaseUrl: string, tableName: string): boolean {
  const escapedTableName = tableName.replace(/'/g, "''");
  return (
    runPsql({
      databaseUrl,
      sql: `SELECT CASE WHEN to_regclass('"${escapedTableName}"') IS NULL THEN '0' ELSE '1' END;`,
      capture: true,
    }).trim() === "1"
  );
}

function columnExists(databaseUrl: string, tableName: string, columnName: string): boolean {
  const escapedTableName = tableName.replace(/'/g, "''");
  const escapedColumnName = columnName.replace(/'/g, "''");
  return (
    runPsql({
      databaseUrl,
      sql: `
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = '${escapedTableName}'
            AND column_name = '${escapedColumnName}'
        ) THEN '1' ELSE '0' END;
      `,
      capture: true,
    }).trim() === "1"
  );
}

function listMigrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function applyMigration(databaseUrl: string, migrationName: string): void {
  const migrationFile = path.join(MIGRATIONS_DIR, migrationName, "migration.sql");
  if (!fs.existsSync(migrationFile)) {
    throw new Error(`Migration file not found: ${migrationFile}`);
  }

  runPsql({ databaseUrl, file: migrationFile });
}

function resetPublicSchema(databaseUrl: string): void {
  runPsql({
    databaseUrl,
    sql: `
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
    `,
  });
}

function buildRepresentativeSeedSql(): string {
  return `
    INSERT INTO "MembershipLockoutSettings" (
      "id",
      "enabled",
      "financialYearEndMonthOverride",
      "textFallbackEnabled",
      "updatedAt"
    ) VALUES (
      'default',
      true,
      3,
      true,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id") DO UPDATE
    SET
      "financialYearEndMonthOverride" = 3,
      "updatedAt" = CURRENT_TIMESTAMP;

    -- #2130 runtime-prep: this fixture no longer seeds the legacy
    -- "xeroContactGroupId"/"xeroContactGroupName" columns. Nothing forced the
    -- removal — this replay database never receives the STEP 2 drop migration
    -- (main() applies only migrations < 20260629160000 plus two named ones), so
    -- the columns survive here regardless. The real reason is that the script
    -- is already RETIRED and never runs: main() returns immediately because the
    -- 20260720120000 contraction migration shipped in v0.12.2. This is
    -- defensive cleanup so the dead fixture SQL stops naming a column the
    -- #2130 STEP 2 contract migration drops. The paired "Managed Xero age-tier
    -- rules backfilled" check went with it (see evaluateAuditSnapshots).
    INSERT INTO "AgeTierSetting" (
      "id",
      "tier",
      "minAge",
      "maxAge",
      "label",
      "subscriptionRequiredForBooking",
      "familyGroupRequestCreateMemberAllowed",
      "sortOrder",
      "updatedAt"
    ) VALUES
      (
        'audit-age-tier-infant',
        'INFANT',
        0,
        4,
        'Infant (under 5)',
        false,
        true,
        0,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-age-tier-child',
        'CHILD',
        5,
        9,
        'Child (5-9)',
        false,
        true,
        1,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-age-tier-youth',
        'YOUTH',
        10,
        17,
        'Youth (10-17)',
        true,
        false,
        2,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-age-tier-adult',
        'ADULT',
        18,
        NULL,
        'Adult (18+)',
        true,
        false,
        3,
        CURRENT_TIMESTAMP
      )
    ON CONFLICT ("tier") DO UPDATE
    SET
      "minAge" = EXCLUDED."minAge",
      "maxAge" = EXCLUDED."maxAge",
      "label" = EXCLUDED."label",
      "subscriptionRequiredForBooking" = EXCLUDED."subscriptionRequiredForBooking",
      "familyGroupRequestCreateMemberAllowed" = EXCLUDED."familyGroupRequestCreateMemberAllowed",
      "sortOrder" = EXCLUDED."sortOrder",
      "updatedAt" = CURRENT_TIMESTAMP;

    INSERT INTO "AgeTierXeroAcceptedContactGroup" (
      "id",
      "ageTierSettingId",
      "groupId",
      "groupName",
      "updatedAt"
    ) VALUES
      (
        'audit-age-tier-child-accepted',
        'audit-age-tier-child',
        'xero-group-child-accepted',
        'Children Accepted',
        CURRENT_TIMESTAMP
      ),
      (
        'audit-age-tier-adult-accepted',
        'audit-age-tier-adult',
        'xero-group-adult-accepted',
        'Adults Accepted',
        CURRENT_TIMESTAMP
      )
    ON CONFLICT ("groupId") DO UPDATE
    SET
      "ageTierSettingId" = EXCLUDED."ageTierSettingId",
      "groupName" = EXCLUDED."groupName",
      "updatedAt" = CURRENT_TIMESTAMP;

    INSERT INTO "Member" (
      "id",
      "email",
      "passwordHash",
      "firstName",
      "lastName",
      "role",
      "financeAccessLevel",
      "ageTier",
      "active",
      "canLogin",
      "updatedAt"
    ) VALUES
      (
        'audit-full-member',
        'audit-full@example.test',
        'audit-hash',
        'Full',
        'Member',
        'MEMBER',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-family-child',
        'audit-full@example.test',
        'audit-hash',
        'Family',
        'Child',
        'MEMBER',
        'NONE',
        'CHILD',
        true,
        false,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-associate-member',
        'audit-associate@example.test',
        'audit-hash',
        'Associate',
        'Member',
        'ASSOCIATE',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-life-member',
        'audit-life@example.test',
        'audit-hash',
        'Life',
        'Member',
        'LIFE',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-reserve-member',
        'audit-reserve@example.test',
        'audit-hash',
        'Reserve',
        'Member',
        'MEMBER',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-admin-member',
        'audit-admin@example.test',
        'audit-hash',
        'Admin',
        'Member',
        'ADMIN',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-lodge-member',
        'audit-lodge@example.test',
        'audit-hash',
        'Lodge',
        'Manager',
        'LODGE',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-finance-viewer',
        'audit-finance-viewer@example.test',
        'audit-hash',
        'Finance',
        'Viewer',
        'MEMBER',
        'VIEWER',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-finance-manager',
        'audit-finance-manager@example.test',
        'audit-hash',
        'Finance',
        'Manager',
        'MEMBER',
        'MANAGER',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-school-login',
        'audit-school-login@example.test',
        'audit-hash',
        'School',
        'Login',
        'SCHOOL',
        'NONE',
        'ADULT',
        true,
        true,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-school-contact',
        'audit-school-contact@example.test',
        'audit-hash',
        'School',
        'Contact',
        'SCHOOL',
        'NONE',
        'ADULT',
        true,
        false,
        CURRENT_TIMESTAMP
      ),
      (
        'audit-non-member',
        'audit-non-member@example.test',
        'audit-hash',
        'Non',
        'Member',
        'NON_MEMBER',
        'NONE',
        'ADULT',
        true,
        false,
        CURRENT_TIMESTAMP
      );

    UPDATE "Member"
    SET
      "parentMemberId" = 'audit-full-member',
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'audit-family-child';

    INSERT INTO "FamilyGroup" ("id", "name", "updatedAt")
    VALUES ('audit-family-group', 'Audit Family Group', CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING;

    -- #2520: this fixture does not seed the retired role column (deliberately
    -- named here without SQL quoting, so the retirement guard's raw-SQL scan does
    -- not read this comment as a live reference), mirroring the #2130 cleanup of
    -- the AgeTierSetting fixture above.
    -- Nothing forced the removal, and nothing has since: this replay database
    -- never receives the CONTRACT drop migration
    -- (20260803030000_contract_drop_family_group_member_role) because main()
    -- applies only migrations < 20260629160000 plus two named ones, so the column
    -- is still THERE in this replay database even though production no longer has
    -- it. The real reason for the cleanup is that the script is already RETIRED
    -- and never runs: main() returns immediately because the 20260720120000
    -- contraction migration shipped in v0.12.2. The paired
    -- "FamilyGroupMember group-local MEMBER labels preserved" check and the
    -- familyGroupRoles snapshot metric went with it (see evaluateAuditSnapshots
    -- and collectSnapshot). In this replay database the column keeps its
    -- NOT NULL DEFAULT 'MEMBER', so the two rows below still store 'MEMBER'
    -- without naming it.
    INSERT INTO "FamilyGroupMember" (
      "id",
      "familyGroupId",
      "memberId",
      "joinedAt"
    ) VALUES
      (
        'audit-family-group-admin',
        'audit-family-group',
        'audit-full-member',
        CURRENT_TIMESTAMP
      ),
      (
        'audit-family-group-child',
        'audit-family-group',
        'audit-family-child',
        CURRENT_TIMESTAMP
      )
    ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;

    WITH current_membership_season AS (
      SELECT
        CASE
          WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int >= ((3 % 12) + 1)
            THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
          ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1
        END AS season_year
    ),
    assignment_seed(member_id, type_key) AS (
      VALUES
        ('audit-full-member', 'FULL'),
        ('audit-family-child', 'FULL'),
        ('audit-associate-member', 'ASSOCIATE'),
        ('audit-life-member', 'LIFE'),
        ('audit-reserve-member', 'RESERVE'),
        ('audit-admin-member', 'FULL'),
        ('audit-lodge-member', 'FULL'),
        ('audit-finance-viewer', 'FULL'),
        ('audit-finance-manager', 'FULL'),
        ('audit-school-login', 'FULL'),
        ('audit-school-contact', 'FULL'),
        ('audit-non-member', 'FULL')
    )
    INSERT INTO "SeasonalMembershipAssignment" (
      "id",
      "memberId",
      "seasonYear",
      "membershipTypeId",
      "updatedAt"
    )
    SELECT
      'audit-seasonal-membership-' || assignment_seed.member_id,
      assignment_seed.member_id,
      current_membership_season.season_year,
      membership_type."id",
      CURRENT_TIMESTAMP
    FROM assignment_seed
    CROSS JOIN current_membership_season
    JOIN "MembershipType" membership_type ON membership_type."key" = assignment_seed.type_key
    ON CONFLICT ("memberId", "seasonYear") DO UPDATE
    SET
      "membershipTypeId" = EXCLUDED."membershipTypeId",
      "updatedAt" = CURRENT_TIMESTAMP;
  `;
}

function seedRepresentativeData(databaseUrl: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-access-role-audit-"));
  const seedFile = path.join(tempDir, "representative-seed.sql");
  fs.writeFileSync(seedFile, buildRepresentativeSeedSql(), "utf8");

  try {
    runPsql({ databaseUrl, file: seedFile });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function collectSnapshot(databaseUrl: string): AuditSnapshot {
  const hasAccessRoles = tableExists(databaseUrl, "MemberAccessRole");
  const hasXeroRules = tableExists(databaseUrl, "XeroContactGroupRule");
  const hasMembershipTypeAgeTiers = tableExists(databaseUrl, "MembershipTypeAgeTier");
  const hasSourceDetail = columnExists(
    databaseUrl,
    "SeasonalMembershipAssignment",
    "sourceDetail",
  );

  return {
    memberRoles: queryCounts(
      databaseUrl,
      'SELECT "role"::text, COUNT(*) FROM "Member" GROUP BY 1 ORDER BY 1;',
    ),
    financeAccessLevels: queryCounts(
      databaseUrl,
      'SELECT "financeAccessLevel"::text, COUNT(*) FROM "Member" GROUP BY 1 ORDER BY 1;',
    ),
    accessRoles: hasAccessRoles
      ? queryCounts(
          databaseUrl,
          'SELECT "role"::text, COUNT(*) FROM "MemberAccessRole" GROUP BY 1 ORDER BY 1;',
        )
      : {},
    membershipTypes: queryCounts(
      databaseUrl,
      'SELECT "key", COUNT(*) FROM "MembershipType" GROUP BY 1 ORDER BY 1;',
    ),
    seasonalAssignments: queryCounts(
      databaseUrl,
      `
        SELECT membership_type."key", COUNT(*)
        FROM "SeasonalMembershipAssignment" assignment
        JOIN "MembershipType" membership_type ON membership_type."id" = assignment."membershipTypeId"
        GROUP BY 1
        ORDER BY 1;
      `,
    ),
    xeroRulesByMode: hasXeroRules
      ? queryCounts(
          databaseUrl,
          'SELECT "mode"::text, COUNT(*) FROM "XeroContactGroupRule" GROUP BY 1 ORDER BY 1;',
        )
      : {},
    xeroRulesByAgeTier: hasXeroRules
      ? queryCounts(
          databaseUrl,
          `
            SELECT COALESCE("ageTier"::text, 'NO_AGE_TIER'), COUNT(*)
            FROM "XeroContactGroupRule"
            GROUP BY 1
            ORDER BY 1;
          `,
        )
      : {},
    // familyGroupRoles was dropped by #2520 along with its check and its two
    // report lines, the same way #2130 dropped managedAgeTierSettings below.
    // This script is retired and never executes, so removing the snapshot read
    // loses no live coverage; it just stopped dead code naming a
    // FamilyGroupMember column that 20260803030000 has since dropped. The
    // metrics.familyGroupMemberRows count below is the one that mattered, and it
    // names no retired column.
    metrics: {
      schoolLoginMembers: queryNumber(
        databaseUrl,
        `SELECT COUNT(*) FROM "Member" WHERE "role"::text = 'SCHOOL' AND "canLogin" = true;`,
      ),
      schoolFullAssignments: queryNumber(
        databaseUrl,
        `
          SELECT COUNT(*)
          FROM "SeasonalMembershipAssignment" assignment
          JOIN "Member" member ON member."id" = assignment."memberId"
          JOIN "MembershipType" membership_type ON membership_type."id" = assignment."membershipTypeId"
          WHERE member."role"::text = 'SCHOOL'
            AND membership_type."key" = 'FULL';
        `,
      ),
      schoolSchoolAssignments: queryNumber(
        databaseUrl,
        `
          SELECT COUNT(*)
          FROM "SeasonalMembershipAssignment" assignment
          JOIN "Member" member ON member."id" = assignment."memberId"
          JOIN "MembershipType" membership_type ON membership_type."id" = assignment."membershipTypeId"
          WHERE member."role"::text = 'SCHOOL'
            AND membership_type."key" = 'SCHOOL';
        `,
      ),
      nonMemberFullAssignments: queryNumber(
        databaseUrl,
        `
          SELECT COUNT(*)
          FROM "SeasonalMembershipAssignment" assignment
          JOIN "Member" member ON member."id" = assignment."memberId"
          JOIN "MembershipType" membership_type ON membership_type."id" = assignment."membershipTypeId"
          WHERE member."role"::text = 'NON_MEMBER'
            AND membership_type."key" = 'FULL';
        `,
      ),
      nonMemberNonMemberAssignments: queryNumber(
        databaseUrl,
        `
          SELECT COUNT(*)
          FROM "SeasonalMembershipAssignment" assignment
          JOIN "Member" member ON member."id" = assignment."memberId"
          JOIN "MembershipType" membership_type ON membership_type."id" = assignment."membershipTypeId"
          WHERE member."role"::text = 'NON_MEMBER'
            AND membership_type."key" = 'NON_MEMBER';
        `,
      ),
      // managedAgeTierSettings was dropped by #2130 along with its check. This
      // script is retired and never executes (main() returns early — the
      // 20260720120000 contraction shipped in v0.12.2), so removing the metric
      // loses no live coverage; it just stops dead code naming
      // AgeTierSetting."xeroContactGroupId" before STEP 2 drops it.
      acceptedAgeTierGroups: queryNumber(
        databaseUrl,
        'SELECT COUNT(*) FROM "AgeTierXeroAcceptedContactGroup";',
      ),
      membershipTypeAgeTierRows: hasMembershipTypeAgeTiers
        ? queryNumber(databaseUrl, 'SELECT COUNT(*) FROM "MembershipTypeAgeTier";')
        : 0,
      familyGroupMemberRows: queryNumber(
        databaseUrl,
        'SELECT COUNT(*) FROM "FamilyGroupMember";',
      ),
      reserveSourceDetailRows: hasSourceDetail
        ? queryNumber(
            databaseUrl,
            `
              SELECT COUNT(*)
              FROM "SeasonalMembershipAssignment"
              WHERE "sourceDetail" = 'Migrated from RESERVE built-in membership type.';
            `,
          )
        : 0,
      legacyNonMemberSourceDetailRows: hasSourceDetail
        ? queryNumber(
            databaseUrl,
            `
              SELECT COUNT(*)
              FROM "SeasonalMembershipAssignment"
              WHERE "sourceDetail" = 'Migrated from legacy non-member Role category.';
            `,
          )
        : 0,
    },
  };
}

function renderCountMap(label: string, rows: Record<string, number>): string[] {
  const entries = Object.entries(rows);
  if (entries.length === 0) {
    return [`${label}: none`];
  }

  return [`${label}:`, ...entries.map(([key, count]) => `  ${key}: ${count}`)];
}

function renderAuditReport(
  before: AuditSnapshot,
  after: AuditSnapshot,
  evaluation: AuditEvaluation,
): string {
  const failedChecks = evaluation.checks.filter((check) => !check.ok);

  return [
    "# Access-role membership cleanup migration audit",
    "",
    "## Before cleanup",
    ...renderCountMap("Member.role", before.memberRoles),
    ...renderCountMap("financeAccessLevel", before.financeAccessLevels),
    ...renderCountMap("MembershipType", before.membershipTypes),
    ...renderCountMap("SeasonalMembershipAssignment by type", before.seasonalAssignments),
    "",
    "## After cleanup",
    ...renderCountMap("Member.role", after.memberRoles),
    ...renderCountMap("MemberAccessRole", after.accessRoles),
    ...renderCountMap("MembershipType", after.membershipTypes),
    ...renderCountMap("SeasonalMembershipAssignment by type", after.seasonalAssignments),
    ...renderCountMap("XeroContactGroupRule by mode", after.xeroRulesByMode),
    ...renderCountMap("XeroContactGroupRule by age tier", after.xeroRulesByAgeTier),
    "",
    "## Checks",
    ...evaluation.checks.map(
      (check) =>
        `${check.ok ? "PASS" : "FAIL"} ${check.label}: expected ${check.expected}, got ${check.actual}`,
    ),
    "",
    "## Warnings",
    ...(evaluation.warnings.length > 0
      ? evaluation.warnings.map((warning) => `WARN ${warning}`)
      : ["none"]),
    "",
    failedChecks.length === 0
      ? "Result: PASS"
      : `Result: FAIL (${failedChecks.length} failed checks)`,
  ].join("\n");
}

function parseArgs(argv: string[]): { yes: boolean } {
  return { yes: argv.includes("--yes") };
}

// #1939 (E13 contraction): this audit's fixture SQL targets the retired
// AgeTierXeroAcceptedContactGroup table, which the contraction migration
// drops — replaying the full migration tree then seeding those fixtures can
// no longer work. The audit was a one-shot harness for two already-executed
// 2026-06 migrations, so it is retired rather than ported.
const RETIRING_CONTRACTION_MIGRATION =
  "20260720120000_contract_drop_entrance_fee_and_agetier_xero_group";

function main(): void {
  if (
    fs.existsSync(path.join(MIGRATIONS_DIR, RETIRING_CONTRACTION_MIGRATION))
  ) {
    console.log(
      `This audit is retired: the ${RETIRING_CONTRACTION_MIGRATION} contraction ` +
        "drops the AgeTierXeroAcceptedContactGroup table its fixtures seed. " +
        "The audited 2026-06 migrations were verified before the contraction " +
        "landed (#1939); nothing remains to audit.",
    );
    return;
  }

  const { yes } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const guard = checkDisposableLocalDatabaseUrl(databaseUrl);

  if (!guard.ok) {
    throw new Error(guard.reason);
  }

  if (!yes && process.env.ACCESS_ROLE_AUDIT_CONFIRM !== "1") {
    throw new Error(
      "This resets the public schema. Re-run with --yes or ACCESS_ROLE_AUDIT_CONFIRM=1 after confirming the database is disposable.",
    );
  }

  const migrationNames = listMigrationNames();
  const preCleanupMigrations = migrationNames.filter(
    (migrationName) => migrationName < ACCESS_ROLE_CLEANUP_MIGRATION,
  );

  if (!migrationNames.includes(ACCESS_ROLE_CLEANUP_MIGRATION)) {
    throw new Error(`Missing required migration ${ACCESS_ROLE_CLEANUP_MIGRATION}.`);
  }
  if (!migrationNames.includes(USER_ROLE_RENAME_MIGRATION)) {
    throw new Error(`Missing required migration ${USER_ROLE_RENAME_MIGRATION}.`);
  }

  console.log(
    `Resetting local disposable database ${guard.databaseName} on ${guard.host}.`,
  );
  resetPublicSchema(databaseUrl);

  console.log(`Applying ${preCleanupMigrations.length} pre-cleanup migrations.`);
  for (const migrationName of preCleanupMigrations) {
    applyMigration(databaseUrl, migrationName);
  }

  console.log("Seeding representative legacy membership data.");
  seedRepresentativeData(databaseUrl);

  const before = collectSnapshot(databaseUrl);

  console.log(`Applying ${ACCESS_ROLE_CLEANUP_MIGRATION}.`);
  applyMigration(databaseUrl, ACCESS_ROLE_CLEANUP_MIGRATION);
  console.log(`Applying ${USER_ROLE_RENAME_MIGRATION}.`);
  applyMigration(databaseUrl, USER_ROLE_RENAME_MIGRATION);

  const after = collectSnapshot(databaseUrl);
  const evaluation = evaluateAuditSnapshots(before, after);
  const report = renderAuditReport(before, after, evaluation);

  console.log("");
  console.log(report);

  if (evaluation.checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
