import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { jobBlock, stepBlock } from "./helpers/ci-workflow";
import {
  MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
} from "@/lib/member-parent-partner-exclusivity";

const root = process.cwd();
const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

const MIGRATION =
  "prisma/migrations/20260914010000_add_member_parent_partner_exclusion/migration.sql";
const ROLLBACK =
  "prisma/migrations/20260914010000_add_member_parent_partner_exclusion/rollback.sql";

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
    expect(step).toContain("CONCURRENCY_RACE_DATABASE_URL:");
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
    expect(runner).not.toContain("sqlInsideVerificationTransaction");
    const fixture = read(
      "prisma/migration-verification/20260914010000_add_member_parent_partner_exclusion.ts",
    );
    expect(fixture).toContain('executionMode: "isolated_database"');
    expect(fixture).toContain("noDetailOrHint: true");
  });
});
