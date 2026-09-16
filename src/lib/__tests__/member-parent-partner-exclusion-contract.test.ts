import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { jobBlock, stepBlock } from "./helpers/ci-workflow";
import {
  MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
  MEMBER_PARENT_PARTNER_EXCLUSION_STATE_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_STATE_MESSAGE,
} from "@/lib/member-parent-partner-exclusivity";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

const MIGRATION =
  "prisma/migrations/20260929010000_add_member_parent_partner_exclusion/migration.sql";
const ROLLBACK =
  "prisma/migrations/20260929010000_add_member_parent_partner_exclusion/rollback.sql";

function expectOrdered(source: string, fragments: readonly string[]) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    expect(next, `missing ordered fragment: ${fragment}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("parent/partner database backstop contract (#3292)", () => {
  it("pins the TypeScript decoder names to the exact committed SQL", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(`MESSAGE = '${MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE}'`);
    expect(sql).toContain(`CONSTRAINT = '${MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT}'`);
    expect(sql).toContain(
      `MESSAGE = '${MEMBER_PARENT_PARTNER_EXCLUSION_STATE_MESSAGE}'`,
    );
    expect(sql).toContain(
      `CONSTRAINT = '${MEMBER_PARENT_PARTNER_EXCLUSION_STATE_CONSTRAINT}'`,
    );
    expect(sql).toContain('COLLATE "C"');
    expect(sql).not.toContain("pg_advisory");
  });

  it("keeps one explicit transaction around locks, preflight, backfill, and triggers", () => {
    const sql = read(MIGRATION);
    expectOrdered(sql, [
      "BEGIN;",
      'LOCK TABLE "Member", "MemberPartnerLink" IN SHARE ROW EXCLUSIVE MODE;',
      "DO $member_parent_partner_preflight$",
      'CREATE TABLE "MemberParentPartnerExclusion"',
      "WITH relationship_edges AS",
      "CREATE FUNCTION member_parent_partner_apply_delta",
      'CREATE TRIGGER "Member_parent_partner_exclusion_insert"',
      'CREATE TRIGGER "MemberPartnerLink_parent_partner_exclusion_insert"',
      'CREATE CONSTRAINT TRIGGER "MemberParentPartnerExclusion_cleanup_zero_pair"',
      "COMMIT;",
    ]);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("ships a complete reverse for every installed artifact", () => {
    const rollback = read(ROLLBACK);
    expect(rollback.trimStart().includes("BEGIN;")).toBe(true);
    for (const trigger of [
      "Member_parent_partner_exclusion_insert",
      "Member_parent_partner_exclusion_update",
      "Member_parent_partner_exclusion_delete",
      "MemberPartnerLink_parent_partner_exclusion_insert",
      "MemberPartnerLink_parent_partner_exclusion_update",
      "MemberPartnerLink_parent_partner_exclusion_delete",
      "MemberParentPartnerExclusion_cleanup_zero_pair",
    ]) {
      expect(rollback).toContain(`DROP TRIGGER IF EXISTS "${trigger}"`);
    }
    for (const fn of [
      "member_parent_partner_cleanup_zero_pair",
      "member_parent_partner_partner_edges_changed",
      "member_parent_partner_member_edges_changed",
      "member_parent_partner_apply_delta",
    ]) {
      expect(rollback).toContain(`DROP FUNCTION IF EXISTS ${fn}`);
    }
    expect(rollback).toContain('DROP TABLE "MemberParentPartnerExclusion";');
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("keeps the windowed validator and shared rollback boundary operator-visible", () => {
    const runbook = read("docs/PRODUCTION_UPGRADE_RUNBOOK.md");
    expectOrdered(runbook.slice(runbook.indexOf("9(a) **Validate.**")), [
      "20260803010000_contract_subscription_lockout_drop_enabled/migration.sql",
      "20260803020000_add_adult_member_hosting_enforced_and_host_scopes/migration.sql",
      "20260803030000_contract_drop_family_group_member_role/migration.sql",
      "20260803070000_add_hosting_coverage_incidents/migration.sql",
      "20260806000000_add_hosting_notification_delivery_claim/migration.sql",
      "20260806010000_fence_hosting_coverage_delivery_claims/migration.sql",
      "20260913010000_add_booking_guest_night_adjustment/migration.sql",
      "20260913020000_ai_spend_currency_settings/migration.sql",
      "20260913030000_add_payment_transaction_carried_ask_cents/migration.sql",
      "20260923010000_backfill_historical_audit_categories/migration.sql",
      "20260927010000_add_member_lodge_roster/migration.sql",
      // RE-MEASURED on the tenth main-to-epic sync. This list was twelve when
      // #3292 wrote it, which was every pending migration then. Programme
      // #2912 adds six, additive rows included, and a validator run naming
      // twelve of eighteen exits 0 without having looked at six of them — so
      // the list grows with the tree rather than pinning a figure that has
      // stopped being true.
      "20260928010000_add_organisation_record/migration.sql",
      "20260928020000_booking_owner_optional_member/migration.sql",
      "20260928030000_backfill_school_bookings_to_organisations/migration.sql",
      "20260928040000_add_xero_sync_operation_invoice_email_delivery/migration.sql",
      "20260928050000_add_mirotalk_settings/migration.sql",
      "20260928060000_add_issue_report_screenshot_origin/migration.sql",
      "20260929010000_add_member_parent_partner_exclusion/migration.sql",
    ]);
    expect(runbook).toContain(
      "#2543 + #2520 + #2596 + #3369 + #3271 windowed maintenance window",
    );
    expect(runbook).toContain("reversing this migration");
    expect(runbook).toContain(
      "alone does not restore old-runtime compatibility",
    );

    const deployment = read("DEPLOYMENT.md");
    expect(deployment).toContain("Pass all eighteen pending migration files");
    // The #3271 window is no longer the last one in the list, so what this pins
    // is that #3271 is still NAMED and still last in order — not that it is the
    // only thing after the audit backfill.
    expect(deployment).toContain("`20260929010000`");
    expect(deployment).toContain("`20260923010000` and `20260927010000`");

    const rollback = read(ROLLBACK);
    expect(rollback).toContain("every other windowed");
    expect(rollback).toContain("same maintenance window");
  });

  it("routes every existing-id writer through pair rows after advisory locks", () => {
    const partner = read("src/lib/member-partner-link.ts");
    expectOrdered(partner.slice(partner.indexOf("async function lockPartnerMembers")), [
      "await acquireMemberPartnerLinkLocks(tx, memberIds)",
      "await acquireMemberParentPartnerPairLocks(tx, [memberIds])",
    ]);

    for (const [file, sequence] of [
      [
        "src/app/api/admin/members/[id]/dependents/link/route.ts",
        [
          "await acquireMemberLifecycleLocks(tx, [parentId, data.memberId])",
          "await acquireMemberPartnerLinkLocks(tx, [parentId, data.memberId])",
          "await acquireMemberParentPartnerPairLocks(tx",
        ],
      ],
      [
        "src/lib/admin-family-group-requests-service.ts",
        [
          "await acquireMemberLifecycleLocks(tx",
          "await acquireMemberPartnerLinkLocks(tx, parentLinkMemberIds)",
          "await acquireMemberParentPartnerPairLocks(tx",
          "await hasAnyPartnerRelationship(",
        ],
      ],
      [
        "src/lib/nomination.ts",
        [
          "await acquireMemberLifecycleLocks(tx, mapTargetIds)",
          "await acquireMemberPartnerLinkLocks(tx, mapTargetIds)",
          "await acquireMemberParentPartnerPairLocks(",
          "await hasAnyPartnerRelationship(",
        ],
      ],
      [
        "src/lib/member-merge.ts",
        [
          "await acquireMemberLifecycleLocks(tx, [masterId, loserId])",
          "await acquireMemberPartnerLinkLocks(",
          "await acquireMemberParentPartnerPairLocks(",
          "loadPlannedMemberMergeExclusivityTopology(",
        ],
      ],
    ] as const) {
      expectOrdered(read(file), sequence);
    }
  });

  it("runs the named real-PostgreSQL races in required blocking CI", () => {
    const workflow = read(".github/workflows/ci.yml");
    const job = jobBlock(workflow, "migration-drift");
    const step = stepBlock(
      job,
      "Test advisory-lock race protocol against dedicated PostgreSQL",
    );
    expect(job).toContain("image: postgres:16-alpine");
    expect(step).toContain('RUN_CONCURRENCY_RACE_TESTS: "1"');
    expect(step).toContain(
      "CONCURRENCY_RACE_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881",
    );
    expect(step).toContain(
      "npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
    expect(step).not.toContain("continue-on-error");

    const harness = read("src/lib/__tests__/concurrency-lock-races.realdb.test.ts");
    expect(harness).toContain(
      'import "./member-parent-partner-exclusion-races.realdb.test";',
    );
    const races = read(
      "src/lib/__tests__/member-parent-partner-exclusion-races.realdb.test.ts",
    );
    expect(races).toContain(
      'const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";',
    );
    expect(races).toContain(
      'const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";',
    );
    expect(races).toContain('const PREFIX = "race-3292-";');
    expect(races).toContain("(RUN ? describe : describe.skip)(");
    expect(races).toContain(
      'assertSafeRaceDbUrl(RACE_DB_URL, "parent/partner exclusion");',
    );
    for (const name of [
      "lets exactly one application relationship type commit",
      "lets exactly one type commit against direct-SQL bypasses in both directions",
      "makes two direct-SQL writers serialize through the pair primary key",
      "serializes opposing multi-row source statements in canonical pair order",
      "locks opposing raw pair lists in one canonical order without deadlock",
    ]) {
      expect(races).toContain(`it("${name}"`);
    }
  });

  it("tracks the internal model and executes transaction migrations byte-for-byte", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toContain("model MemberParentPartnerExclusion {");
    expect(schema).toContain(
      '@@id([memberAId, memberBId], map: "MemberParentPartnerExclusion_pkey")',
    );

    const runner = read(
      "src/lib/__tests__/data-migration-verification.realdb.test.ts",
    );
    expect(runner).toContain("await caseClient.query(version)");
    // Nothing in the runner may rewrite a migration before running it: the file
    // under test has to be the committed one, or it was never tested (#3292,
    // INV-SSOT-002). #3369's comment-aware envelope reader is what used to do
    // this; it now lives in migration-sql-transaction-control.test.ts as a
    // STATIC check that reads every committed script and executes none of them.
    expect(runner).not.toContain("sqlInsideVerificationTransaction");
    expect(runner).not.toContain("TRANSACTION_CONTROL");
    const envelopeCheck = read(
      "src/lib/__tests__/migration-sql-transaction-control.test.ts",
    );
    expect(envelopeCheck).toContain("transactionControlBeyondOuterEnvelope");
    expect(envelopeCheck).toContain("stripSqlComments");
    const fixture = read(
      "prisma/migration-verification/20260929010000_add_member_parent_partner_exclusion.ts",
    );
    expect(fixture).toContain('executionMode: "isolated_database"');
    expect(fixture).toContain("noDetailOrHint: true");
    // Every fixture whose migration carries an envelope, not just this one.
    for (const enveloped of [
      "20260928010000_add_organisation_record",
      "20260928030000_backfill_school_bookings_to_organisations",
    ]) {
      expect(
        read(`prisma/migration-verification/${enveloped}.ts`),
        `${enveloped} carries a BEGIN/COMMIT envelope, so it must run byte-for-byte`,
      ).toContain('executionMode: "isolated_database"');
    }
  });
});
