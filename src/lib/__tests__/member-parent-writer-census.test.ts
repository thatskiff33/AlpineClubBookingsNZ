import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  scanMemberParentWriterSources,
  type MeasuredMemberParentWriterSite,
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
  });

  it("recognises scalar, nested-connect, computed merge, and non-runtime forms", () => {
    const measured = scanMemberParentWriterSources(
      new Map([
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
          "src/nested.ts",
          `async function nested(tx: any) {
             const data = { secondaryParent: { connect: { id: parent.id } } };
             await tx.member.update({ data });
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
        file: "src/assigned.ts",
        site: "assigned/member.update/scalar:secondaryParentId",
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
        file: "src/nested.ts",
        site: "nested/member.update/relation:secondaryParent.connect:secondaryParentId",
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
});
