import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  scanMemberParentWriterSources,
  scanMemberPartnerWriterSources,
  type MeasuredMemberParentWriterSite,
  type MeasuredMemberPartnerWriterSite,
} from "./support/member-parent-writer-census";

type Classification =
  | "guarded-existing-id"
  | "newly-generated-child-id"
  | "topology-preserving"
  | "demo-test-only";

type ReviewedSite = MeasuredMemberParentWriterSite & {
  classification: Classification;
  note: string;
};

type PartnerClassification =
  | "guarded-existing-id"
  | "new-id-only"
  | "removal-only"
  | "demo-test-only";

type ReviewedPartnerSite = MeasuredMemberPartnerWriterSite & {
  classification: PartnerClassification;
  note: string;
};

// Filled from the scanner's first run below. Keeping the whole reviewed tuple,
// rather than a count or per-file allowlist, makes concurrent additions conflict
// visibly and forces every new writer to explain why INV-LIFE-024 remains true.
const REVIEWED_PARENT_WRITER_MANIFEST: readonly ReviewedSite[] = [
  {
    file: "prisma/demo-seed.ts",
    site: "main/member.create/scalar:parentMemberId#1",
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note: "Demo child row under Alice; never used as live or production input.",
  },
  {
    file: "prisma/demo-seed.ts",
    site: "main/member.create/scalar:parentMemberId#2",
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note: "Demo youth row under Pat; never used as live or production input.",
  },
  {
    file: "prisma/demo-seed.ts",
    site: "main/member.create/scalar:parentMemberId#3",
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note: "Demo infant row under Pat; never used as live or production input.",
  },
  ...Array.from({ length: 7 }, (_, index): ReviewedSite => ({
    file:
      "prisma/migration-verification/20260813010000_add_member_email_inheritance_choice.ts",
    site: `module/member.fixture/scalar:parentMemberId#${index + 1}`,
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note: "Sanitized migration-verification fixture, not an application writer.",
  })),
  {
    file:
      "prisma/migration-verification/20260914010000_add_member_parent_partner_exclusion.ts",
    site:
      "preExistingOverlapCase/raw-sql-update:dynamic-parent-column",
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note:
      "The typed parent-column interpolation expands sanitized migration-verification fixtures only; it is not an application writer.",
  },
  ...[
    "parentMemberId#1",
    "secondaryParentId#1",
    "parentMemberId#2",
    "secondaryParentId#2",
    "parentMemberId#3",
    "secondaryParentId#3",
  ].map((site): ReviewedSite => ({
    file:
      "prisma/migration-verification/20260914010000_add_member_parent_partner_exclusion.ts",
    site: `module/raw-sql-update:${site}`,
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note:
      "Sanitized migration-verification seed/mutant SQL for a disposable database; not an application writer.",
  })),
  {
    file: "scripts/audit-access-role-membership-cleanup.ts",
    site: "buildRepresentativeSeedSql/raw-sql-update:parentMemberId",
    persistence: "demo-test-fixture",
    classification: "demo-test-only",
    note: "Retired cleanup-audit command emits a sanitized disposable-database fixture; it is not an application or deployment writer.",
  },
  {
    file: "src/app/api/admin/members/[id]/dependents/[dependentId]/route.ts",
    site: "DELETE/member.update/relation:parent.connect:parentMemberId",
    persistence: "member-persistence",
    classification: "topology-preserving",
    note:
      "Unlinking the primary parent promotes the already-linked secondary parent into the primary column; it creates no new pair.",
  },
  {
    file: "src/app/api/admin/members/[id]/dependents/link/route.ts",
    site: "POST/member.update/relation:parent.connect:parentMemberId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Admin existing-member primary-parent link runs after lifecycle and sorted partner locks and the any-status partner guard.",
  },
  {
    file: "src/app/api/admin/members/[id]/dependents/link/route.ts",
    site: "POST/member.update/relation:secondaryParent.connect:secondaryParentId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Admin existing-member secondary-parent link shares the primary branch's locks, re-read, and partner guard.",
  },
  {
    file: "src/lib/admin-family-group-requests-service.ts",
    site:
      "reviewAdminFamilyGroupRequest/member.create/scalar:parentMemberId",
    persistence: "member-persistence",
    classification: "newly-generated-child-id",
    note:
      "CHILD_REQUEST create allocates the child Member id in this transaction, so no partner row can already name it.",
  },
  {
    file: "src/lib/admin-family-group-requests-service.ts",
    site:
      "reviewAdminFamilyGroupRequest/member.update/relation:secondaryParent.connect:secondaryParentId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Existing CHILD_REQUEST secondary-parent link is re-read after lifecycle and sorted partner locks and refuses any partner row.",
  },
  {
    file: "src/lib/admin-family-group-requests-service.ts",
    site:
      "reviewAdminFamilyGroupRequest/member.update/relation:parent.connect:parentMemberId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Existing CHILD_REQUEST primary-parent link shares the secondary branch's authoritative guard.",
  },
  {
    file: "src/lib/admin-members-service.ts",
    site: "createAdminMember/member.create/scalar:parentMemberId",
    persistence: "member-persistence",
    classification: "newly-generated-child-id",
    note:
      "Admin create allocates the child Member id in the same create, so it cannot already own a partner link.",
  },
  {
    file: "src/lib/member-merge-relations.ts",
    site: "MEMBER_MERGE_RELATION_SPECS/dynamic-move:parent.parentMemberId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Merge pre-derives the final topology and locks/re-reads every participant before the table-driven primary-parent move.",
  },
  {
    file: "src/lib/member-merge-relations.ts",
    site:
      "MEMBER_MERGE_RELATION_SPECS/dynamic-move:secondaryParent.secondaryParentId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "The same merge topology guard covers the table-driven secondary-parent move.",
  },
  {
    file: "src/lib/nomination.ts",
    site: "approveMemberApplication/member.update/scalar:parentMemberId",
    persistence: "member-persistence",
    classification: "guarded-existing-id",
    note:
      "Application mapping to an existing member locks all affected ids once, re-reads, and refuses any partner row before assignment.",
  },
  {
    file: "src/lib/nomination.ts",
    site: "approveMemberApplication/member.create/scalar:parentMemberId",
    persistence: "member-persistence",
    classification: "newly-generated-child-id",
    note:
      "Nomination dependent-create allocates the child Member id in this transaction, so no partner link can pre-exist.",
  },
  {
    file: "src/lib/xero-member-import.ts",
    site:
      "importMembersFromXeroGroups/createdDependents.push/runtime-result:parentMemberId",
    persistence: "runtime-representation",
    classification: "newly-generated-child-id",
    note:
      "Result metadata names the existing primary beside the just-created member; this is not a Prisma/database parent-column write.",
  },
];

const REVIEWED_PARTNER_WRITER_MANIFEST: readonly ReviewedPartnerSite[] = [
  ...[
    "preExistingOverlapCase/raw-sql-insert",
    "module/raw-sql-insert",
  ].map((site): ReviewedPartnerSite => ({
    file:
      "prisma/migration-verification/20260914010000_add_member_parent_partner_exclusion.ts",
    site,
    persistence: "demo-test-fixture",
    operation: "create-or-move",
    classification: "demo-test-only",
    note:
      "Sanitized migration-verification seed SQL for a disposable database; not an application writer.",
  })),
  {
    file: "src/lib/member-merge.ts",
    site: "resolvePartnerLinks/memberPartnerLink.deleteMany",
    persistence: "member-persistence",
    operation: "remove",
    classification: "removal-only",
    note: "Merge deletes discarded links under its complete topology lock set.",
  },
  {
    file: "src/lib/member-merge.ts",
    site: "resolvePartnerLinks/memberPartnerLink.update",
    persistence: "member-persistence",
    operation: "create-or-move",
    classification: "guarded-existing-id",
    note:
      "Merge re-points endpoints only after lifecycle, partner, and pair-row locks plus the authoritative topology re-read.",
  },
  {
    file: "src/lib/member-partner-link.ts",
    site: "pruneOtherPendingLinks/memberPartnerLink.deleteMany",
    persistence: "member-persistence",
    operation: "remove",
    classification: "removal-only",
    note: "Pending-link pruning removes relationship edges and cannot create an overlap.",
  },
  {
    file: "src/lib/member-partner-link.ts",
    site: "requestPartnerLink/memberPartnerLink.create",
    persistence: "member-persistence",
    operation: "create-or-move",
    classification: "guarded-existing-id",
    note: "Request creation runs through lockPartnerMembers and the direct-parent re-read.",
  },
  {
    file: "src/lib/member-partner-link.ts",
    site: "respondToPartnerLink/memberPartnerLink.deleteMany",
    persistence: "member-persistence",
    operation: "remove",
    classification: "removal-only",
    note: "Decline/removal deletes the pending relationship and cannot create an overlap.",
  },
  {
    file: "src/lib/member-partner-link.ts",
    site: "respondToPartnerLink/memberPartnerLink.updateMany",
    persistence: "member-persistence",
    operation: "create-or-move",
    classification: "guarded-existing-id",
    note: "Confirmation re-reads direct parentage after the pair's locks are held.",
  },
  {
    file: "src/lib/member-partner-link.ts",
    site: "removeOwnPartnerLink/memberPartnerLink.deleteMany",
    persistence: "member-persistence",
    operation: "remove",
    classification: "removal-only",
    note: "Member dissolution removes the relationship under the existing partner locks.",
  },
  ...[
    "adminAssignPartnerLink/memberPartnerLink.update",
    "adminAssignPartnerLink/memberPartnerLink.create",
  ].map((site): ReviewedPartnerSite => ({
    file: "src/lib/member-partner-link.ts",
    site,
    persistence: "member-persistence",
    operation: "create-or-move",
    classification: "guarded-existing-id",
    note:
      "Admin assignment locks the pair and re-reads direct parentage before promotion or creation.",
  })),
  {
    file: "src/lib/member-partner-link.ts",
    site: "adminRemovePartnerLink/memberPartnerLink.deleteMany",
    persistence: "member-persistence",
    operation: "remove",
    classification: "removal-only",
    note: "Admin removal deletes the relationship under the existing partner locks.",
  },
  ...[
    "formPartnerLinkOnClaim/memberPartnerLink.update",
    "formPartnerLinkOnClaim/memberPartnerLink.create",
  ].map((site): ReviewedPartnerSite => ({
    file: "src/lib/member-partner-link.ts",
    site,
    persistence: "member-persistence",
    operation: "create-or-move",
    classification: "guarded-existing-id",
    note:
      "Invite-token claim locks the pair and re-reads direct parentage before its optional partner write.",
  })),
];

const REPO_ROOT = process.cwd();
const SOURCE_ROOTS = ["src", "prisma", "scripts"] as const;

function walk(relative: string): string[] {
  const absolute = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") return [];
      return walk(child);
    }
    return /\.[cm]?tsx?$/.test(entry.name) ? [child] : [];
  });
}

function repositorySources(): Map<string, string> {
  return new Map(
    SOURCE_ROOTS.flatMap(walk)
      .filter(
        (file) =>
          !file.includes("/__tests__/") &&
          !/\.(?:test|spec)\.[cm]?tsx?$/.test(file),
      )
      .map((file) => [file, fs.readFileSync(path.join(REPO_ROOT, file), "utf8")]),
  );
}

function key(site: MeasuredMemberParentWriterSite): string {
  return `${site.file}\t${site.site}\t${site.persistence}`;
}

function classifiedKey(
  site: MeasuredMemberParentWriterSite & { classification: string },
): string {
  return `${key(site)}\t${site.classification}`;
}

function partnerKey(site: MeasuredMemberPartnerWriterSite): string {
  return `${site.file}\t${site.site}\t${site.persistence}\t${site.operation}`;
}

function classifiedPartnerKey(
  site: MeasuredMemberPartnerWriterSite & { classification: string },
): string {
  return `${partnerKey(site)}\t${site.classification}`;
}

describe("member parent writer closed-world census", () => {
  it("equals the reviewed (file, site, classification) inventory", () => {
    const measured = scanMemberParentWriterSources(repositorySources());
    const reviewByMeasuredSite = new Map(
      REVIEWED_PARENT_WRITER_MANIFEST.map((site) => [key(site), site]),
    );
    const classified = measured.map((site) => ({
      ...site,
      classification:
        reviewByMeasuredSite.get(key(site))?.classification ?? "UNREVIEWED",
      note: reviewByMeasuredSite.get(key(site))?.note ?? "UNREVIEWED",
    }));
    expect(classified.map(classifiedKey)).toEqual(
      REVIEWED_PARENT_WRITER_MANIFEST.map(classifiedKey),
    );
  }, 30_000);

  it("recognises scalar, nested-connect, computed merge, and non-runtime forms", () => {
    const measured = scanMemberParentWriterSources(
      new Map([
        [
          "src/aliased-delegate.ts",
          `async function aliasedDelegate(tx: any, parentMemberId: string) {
             const members = tx.member;
             await members.update({ data: { parentMemberId } });
           }`,
        ],
        [
          "src/scalar.ts",
          `async function scalar(tx: any) {
             await tx.member.update({ data: { parentMemberId: parent.id } });
           }`,
        ],
        [
          "src/shorthand.ts",
          `async function shorthand(tx: any, parentMemberId: string) {
             await tx.member.createMany({ data: { parentMemberId } });
           }`,
        ],
        [
          "src/relation-shorthand.ts",
          `async function relationShorthand(tx: any, parent: object) {
             await tx.member.upsert({
               where: { id: "child" },
               create: { parent },
               update: { parent },
             });
           }`,
        ],
        [
          "src/assigned.ts",
          `async function assigned(tx: any) {
             const dependentUpdate = {};
             dependentUpdate.secondaryParentId = parent.id;
             await tx.member.update({ data: dependentUpdate });
           }`,
        ],
        [
          "src/indirect.ts",
          `async function indirect(tx: any, parentMemberId: string) {
             const base = { parentMemberId };
             const data = { ...base };
             const args = { data };
             await tx.member.update(args);
           }`,
        ],
        [
          "src/nested.ts",
          `async function nested(tx: any) {
             const data = { secondaryParent: { connect: { id: parent.id } } };
             await tx.member.update({ data });
           }`,
        ],
        [
          "src/nested-member.ts",
          `async function nestedMember(tx: any, parentMemberId: string) {
             await tx.familyGroupMember.update({
               data: { member: { update: { parentMemberId } } },
             });
           }`,
        ],
        [
          "src/nested-indirect.ts",
          `async function nestedIndirect(tx: any, parentMemberId: string) {
             const nestedData = { member: { update: { parentMemberId } } };
             await tx.familyGroupMember.update({ data: nestedData });
           }`,
        ],
        [
          "src/raw.ts",
          `function rawSql() {
             return String.raw\`UPDATE "Member"
               SET "secondaryParentId" = 'parent', "updatedAt" = CURRENT_TIMESTAMP
               WHERE "id" = 'child';\`;
           }`,
        ],
        [
          "src/raw-tagged.ts",
          `async function taggedRaw(tx: any, parentMemberId: string) {
             await tx.$executeRaw\`UPDATE "Member"
               SET "parentMemberId" = \${parentMemberId}
               WHERE "id" = 'child'\`;
           }`,
        ],
        [
          "src/raw-dynamic-column.ts",
          `async function rawDynamicColumn(
             tx: any,
             column: "parentMemberId" | "secondaryParentId",
             value: string,
           ) {
             await tx.$executeRaw\`UPDATE "Member"
               SET "\${column}" = \${value}
               WHERE "id" = 'child'\`;
           }`,
        ],
        [
          "src/lib/member-merge-relations.ts",
          `const rows = [
             spec("Member", "parent", "parentMemberId", "move"),
             spec("Member", "secondaryParent", "secondaryParentId", "move"),
           ];`,
        ],
        [
          "src/lib/member-merge.ts",
          `async function applyMoves(delegate: any, s: any) {
             await delegate.updateMany({ data: { [s.column]: masterId } });
           }`,
        ],
        [
          "prisma/demo-seed.ts",
          `async function seed(prisma: any) {
             await prisma.member.create({ data: { parentMemberId: "parent" } });
           }`,
        ],
        [
          "prisma/migration-verification/fixture.ts",
          `const seed = member({ secondaryParentId: "parent" });`,
        ],
        [
          "src/lib/xero-member-import.ts",
          `function importMembersFromXeroGroups() {
             createdDependents.push({ parentMemberId: existingPrimary.id });
           }`,
        ],
      ]),
    );

    expect(measured).toEqual([
      {
        file: "prisma/demo-seed.ts",
        site: "seed/member.create/scalar:parentMemberId",
        persistence: "demo-test-fixture",
      },
      {
        file: "prisma/migration-verification/fixture.ts",
        site: "module/member.fixture/scalar:secondaryParentId",
        persistence: "demo-test-fixture",
      },
      {
        file: "src/aliased-delegate.ts",
        site: "aliasedDelegate/member.update/scalar-shorthand:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/assigned.ts",
        site: "assigned/member.update/scalar:secondaryParentId",
        persistence: "member-persistence",
      },
      {
        file: "src/indirect.ts",
        site: "indirect/member.update/scalar-shorthand:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/lib/member-merge-relations.ts",
        site: "MEMBER_MERGE_RELATION_SPECS/dynamic-move:parent.parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/lib/member-merge-relations.ts",
        site:
          "MEMBER_MERGE_RELATION_SPECS/dynamic-move:secondaryParent.secondaryParentId",
        persistence: "member-persistence",
      },
      {
        file: "src/lib/xero-member-import.ts",
        site:
          "importMembersFromXeroGroups/createdDependents.push/runtime-result:parentMemberId",
        persistence: "runtime-representation",
      },
      {
        file: "src/nested-indirect.ts",
        site: "nestedIndirect/member.update/scalar-shorthand:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/nested-member.ts",
        site: "nestedMember/member.update/scalar-shorthand:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/nested.ts",
        site: "nested/member.update/relation:secondaryParent.connect:secondaryParentId",
        persistence: "member-persistence",
      },
      {
        file: "src/raw-dynamic-column.ts",
        site: "rawDynamicColumn/raw-sql-update:dynamic-parent-column",
        persistence: "member-persistence",
      },
      {
        file: "src/raw-tagged.ts",
        site: "taggedRaw/raw-sql-update:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/raw.ts",
        site: "rawSql/raw-sql-update:secondaryParentId",
        persistence: "member-persistence",
      },
      {
        file: "src/relation-shorthand.ts",
        site:
          "relationShorthand/member.upsert/relation:parent.shorthand:parentMemberId#1",
        persistence: "member-persistence",
      },
      {
        file: "src/relation-shorthand.ts",
        site:
          "relationShorthand/member.upsert/relation:parent.shorthand:parentMemberId#2",
        persistence: "member-persistence",
      },
      {
        file: "src/scalar.ts",
        site: "scalar/member.update/scalar:parentMemberId",
        persistence: "member-persistence",
      },
      {
        file: "src/shorthand.ts",
        site: "shorthand/member.createMany/scalar-shorthand:parentMemberId",
        persistence: "member-persistence",
      },
    ]);
  });

  it("ignores null clears plus comment and string decoys", () => {
    const measured = scanMemberParentWriterSources(
      new Map([
        [
          "src/decoys.ts",
          `async function decoys(tx: any) {
             // tx.member.update({ data: { parentMemberId: hidden.id } });
             const prose = "secondaryParent: { connect: { id: hidden.id } }";
             await tx.member.update({ data: { parentMemberId: null } });
           }`,
        ],
      ]),
    );
    expect(measured).toEqual([]);
  });

  it("does not treat a computed merge WHERE as proof of the DATA-side move", () => {
    const measured = scanMemberParentWriterSources(
      new Map([
        [
          "src/lib/member-merge-relations.ts",
          `const rows = [
             spec("Member", "parent", "parentMemberId", "move"),
             spec("Member", "secondaryParent", "secondaryParentId", "move"),
           ];`,
        ],
        [
          "src/lib/member-merge.ts",
          `async function applyMoves(delegate: any, s: any) {
             await delegate.updateMany({
               where: { [s.column]: loserId },
               data: { updatedAt: now },
             });
           }`,
        ],
      ]),
    );

    expect(measured).toEqual([]);
  });
});

describe("member partner writer closed-world census", () => {
  it("equals the reviewed runtime/test and operation inventory", () => {
    const measured = scanMemberPartnerWriterSources(repositorySources());
    const reviewByMeasuredSite = new Map(
      REVIEWED_PARTNER_WRITER_MANIFEST.map((site) => [partnerKey(site), site]),
    );
    const classified = measured.map((site) => ({
      ...site,
      classification:
        reviewByMeasuredSite.get(partnerKey(site))?.classification ??
        "UNREVIEWED",
      note:
        reviewByMeasuredSite.get(partnerKey(site))?.note ?? "UNREVIEWED",
    }));
    expect(classified.map(classifiedPartnerKey)).toEqual(
      REVIEWED_PARTNER_WRITER_MANIFEST.map(classifiedPartnerKey),
    );
  }, 30_000);

  it("recognises direct, aliased, nested, interpolated SQL, and removal forms", () => {
    const measured = scanMemberPartnerWriterSources(
      new Map([
        [
          "src/aliased.ts",
          `async function aliased(tx: any) {
             const links = tx.memberPartnerLink;
             await links.create({ data: { memberAId: "a", memberBId: "b" } });
           }`,
        ],
        [
          "src/direct.ts",
          `async function direct(tx: any) {
             await tx.memberPartnerLink.update({
               where: { id: "link" },
               data: { status: "CONFIRMED" },
             });
           }`,
        ],
        [
          "src/nested.ts",
          `async function nested(tx: any) {
             await tx.member.update({
               where: { id: "a" },
               data: { partnerLinksAsMemberA: { create: { memberBId: "b" } } },
             });
           }`,
        ],
        [
          "src/nested-indirect.ts",
          `async function nestedIndirect(tx: any) {
             const nestedData = {
               partnerLinksAsMemberA: { create: { memberBId: "b" } },
             };
             await tx.member.update({ data: nestedData });
           }`,
        ],
        [
          "src/raw.ts",
          `async function raw(tx: any, memberAId: string, memberBId: string) {
             await tx.$executeRaw\`INSERT INTO "MemberPartnerLink"
               ("memberAId", "memberBId") VALUES (\${memberAId}, \${memberBId})\`;
           }`,
        ],
        [
          "src/remove.ts",
          `async function remove(tx: any) {
             await tx.memberPartnerLink.deleteMany({ where: { memberAId: "a" } });
           }`,
        ],
      ]),
    );

    expect(measured).toEqual([
      {
        file: "src/aliased.ts",
        site: "aliased/memberPartnerLink.create",
        persistence: "member-persistence",
        operation: "create-or-move",
      },
      {
        file: "src/direct.ts",
        site: "direct/memberPartnerLink.update",
        persistence: "member-persistence",
        operation: "create-or-move",
      },
      {
        file: "src/nested-indirect.ts",
        site: "nestedIndirect/memberPartnerLink.update",
        persistence: "member-persistence",
        operation: "create-or-move",
      },
      {
        file: "src/nested.ts",
        site: "nested/memberPartnerLink.update",
        persistence: "member-persistence",
        operation: "create-or-move",
      },
      {
        file: "src/raw.ts",
        site: "raw/raw-sql-insert",
        persistence: "member-persistence",
        operation: "create-or-move",
      },
      {
        file: "src/remove.ts",
        site: "remove/memberPartnerLink.deleteMany",
        persistence: "member-persistence",
        operation: "remove",
      },
    ]);
  });
});
