/**
 * The audit-writer census SCANNER, exercised against synthetic trees (#2581).
 *
 * WHY THIS FILE EXISTS SEPARATELY from `audit-writer-census.test.ts`. That file
 * is the CONTRACT: it scans the real repository and compares the answer against
 * the reviewed manifest. It can only ever prove things about writers that exist.
 * It cannot prove the walk would NOTICE a writer that does not exist yet — and
 * that is the whole claim #2581's documentation makes to operators ("a new one
 * can no longer forget").
 *
 * A review of this branch tested that claim by running the shipped scanner over
 * a synthetic tree and got a CLEAN report for six different writers that each
 * produce a real, unreadable, kept-forever audit row. Every one of those six is
 * a fixture below. They are the reason the scanner grew delegate-alias
 * tracking, element-access handling, raw-SQL detection, whole-array
 * `createMany` resolution, a schema-qualified table pattern, and a NULL check on
 * the category column.
 *
 * WHAT EACH TEST WOULD CATCH: reverting any one of those six changes turns its
 * fixture from "reported" back to "invisible", and only this file notices —
 * the real-tree contract stays green either way, because the real tree contains
 * none of these shapes. That is precisely the false assurance this file removes.
 *
 * The last test states the opposite direction, and it matters just as much: a
 * scanner that flagged the Diagnostics packs' raw `SELECT … FROM "AuditLog"`
 * reads would be turned off within a week.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUDIT_CENSUS_TSV_COLUMNS,
  describeCategory,
  describeMemberDisclosure,
  renderCensusTsv,
  scanAuditWriterCensus,
} from "../../../scripts/audit/audit-writer-census";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A minimal repository: the three roots the census walks, plus whichever files
 * the fixture needs. Anything not written stays empty, so a fixture's report
 * contains only what the fixture put there.
 */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "audit-census-"));
  roots.push(root);
  for (const dir of ["src", "scripts", "prisma"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return scanAuditWriterCensus(root);
}

function report(census: ReturnType<typeof scanAuditWriterCensus>) {
  return [...census.sites, ...census.nonProducingDml].map((site) => ({
    sink: site.sink,
    category: describeCategory(site.category),
  }));
}

describe("audit writer census scanner: the bypasses a review demonstrated (#2581)", () => {
  it("counts a delegate parked in a local (`const log = tx.auditLog`)", () => {
    // Bypass 1. The receiver is `log`, not `<something>.auditLog`, so the
    // property-access check alone saw nothing at all.
    const census = tree({
      "src/lane.ts": `
        export async function write(tx: any) {
          const log = tx.auditLog;
          await log.create({ data: { action: "aliased.write" } });
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "auditLog.create", category: "(absent)" },
    ]);
    expect(census.uncategorised).toHaveLength(1);
  });

  it("counts a delegate renamed out of a destructure (`const { auditLog: log } = tx`)", () => {
    const census = tree({
      "src/lane.ts": `
        export async function write(tx: any) {
          const { auditLog: log } = tx;
          await log.create({ data: { action: "renamed.write" } });
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "auditLog.create", category: "(absent)" },
    ]);
  });

  it("counts a delegate reached by element access (`tx[\"auditLog\"]`)", () => {
    // Bypass 2.
    const census = tree({
      "src/lane.ts": `
        export async function write(tx: any) {
          await tx["auditLog"].create({ data: { action: "bracket.write" } });
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "auditLog.create", category: "(absent)" },
    ]);
  });

  it("counts raw SQL DML from TypeScript, which the migration walk never sees", () => {
    // Bypass 3, in both the forms Prisma offers: a tagged template and an
    // `Unsafe` string argument. The migration arm only walks `prisma/**/*.sql`,
    // so before this a route could INSERT audit rows and the census reported the
    // tree clean.
    const census = tree({
      "src/lane.ts": `
        export async function write(prisma: any) {
          await prisma.$executeRawUnsafe(
            'INSERT INTO "AuditLog" ("id", "action") VALUES ($1, $2)',
          );
          await prisma.$executeRaw\`DELETE FROM "AuditLog" WHERE "id" = \${1}\`;
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "raw.$executeRawUnsafe", category: "(absent)" },
      { sink: "raw.$executeRaw", category: "(absent)" },
    ]);
    // The INSERT produces rows, so it lands in the uncategorised gate; the
    // DELETE mutates existing evidence, so it lands in the approved-DML gate.
    // Both fail closed — neither can be added to the tree without a declaration.
    expect(census.uncategorised).toHaveLength(1);
    expect(census.uncategorised[0].sink).toBe("raw.$executeRawUnsafe");
    expect(census.nonProducingDml).toHaveLength(1);
    expect(census.nonProducingDml[0].sink).toBe("raw.$executeRaw");
  });

  it("reads EVERY element of a createMany array, not just the first", () => {
    // Bypass 4. A categorised first element used to vouch for every row after
    // it, which is the most easily-written of the six.
    const census = tree({
      "src/lane.ts": `
        export async function write(prisma: any) {
          await prisma.auditLog.createMany({
            data: [
              { action: "bulk.first", category: "admin" },
              { action: "bulk.second" },
            ],
          });
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "auditLog.createMany", category: "(absent)" },
    ]);
  });

  it("reports a createMany whose elements disagree as a conditional, not a literal", () => {
    // The same walk, one step weaker: every row IS categorised, but the site
    // writes into two different permission gates, which is the shape the owner's
    // domain rule refuses. It must not read as a single literal.
    const census = tree({
      "src/lane.ts": `
        export async function write(prisma: any) {
          await prisma.auditLog.createMany({
            data: [
              { action: "bulk.first", category: "admin" },
              { action: "bulk.second", category: "lodge" },
            ],
          });
        }
      `,
    });

    expect(report(census)).toEqual([
      { sink: "auditLog.createMany", category: "conditional:admin|lodge" },
    ]);
  });

  it("matches a schema-qualified migration INSERT", () => {
    // Bypass 5. Postgres executes `"public"."AuditLog"` identically; the
    // unqualified pattern did not match it at all.
    const census = tree({
      "prisma/migrations/20260101000000_x/migration.sql": `
        INSERT INTO "public"."AuditLog" ("id", "action") VALUES ('a', 'b');
      `,
    });

    expect(census.sqlStatements).toHaveLength(1);
    expect(census.sqlStatements[0].producesRow).toBe(true);
    expect(census.sqlStatements[0].namesCategory).toBe(false);
  });

  it("refuses a migration INSERT that names \"category\" and then supplies NULL", () => {
    // Bypass 6. Naming the column was the whole check, so this passed while
    // writing exactly the row the check exists to refuse.
    const census = tree({
      "prisma/migrations/20260101000000_x/migration.sql": `
        INSERT INTO "AuditLog" ("id", "action", "category")
        VALUES ('a', 'b', 'admin'), ('c', 'd', NULL);
      `,
    });

    expect(census.sqlStatements[0].namesCategory).toBe(false);
  });

  it("accepts a migration INSERT that supplies a real category, in either source form", () => {
    // The other direction, so the NULL check cannot be satisfied by refusing
    // everything. The SELECT form is the one the committed email-override
    // migration uses, brackets and all.
    const census = tree({
      "prisma/migrations/20260101000000_values/migration.sql": `
        INSERT INTO "AuditLog" ("id", "action", "category")
        VALUES (gen_random_uuid()::text, 'x', 'admin');
      `,
      "prisma/migrations/20260101000001_select/migration.sql": `
        INSERT INTO "AuditLog" ("id", "action", "category")
        SELECT gen_random_uuid()::text, changed."name", 'admin' FROM changed;
      `,
    });

    expect(census.sqlStatements.map((s) => s.namesCategory)).toEqual([
      true,
      true,
    ]);
  });

  it("leaves raw SELECTs against AuditLog alone, so the Diagnostics packs stay quiet", () => {
    // The inverse claim, and the one that decides whether the gate survives
    // contact with the codebase: the correlation packs read the table with
    // `$queryRaw`, and a census that flagged reads as writes would be disabled.
    // `"AuditLogArchive"` is a different table and must not match either.
    const census = tree({
      "src/lane.ts": `
        export async function read(prisma: any) {
          await prisma.$queryRaw\`SELECT "id" FROM "AuditLog" WHERE "category" = ANY(\${[]})\`;
          await prisma.$executeRaw\`INSERT INTO "AuditLogArchive" ("id") VALUES ('a')\`;
        }
      `,
    });

    expect(report(census)).toEqual([]);
  });
});

/**
 * The same claim, for the #2695 member-disclosure column.
 *
 * The population that matters here is the INVERSE of the category one, and the
 * difference is what these tests are about. For `category`, the dangerous
 * reading is `absent` and the census PINS it, so a site the walk cannot read
 * lands in a set somebody has to explain. For `memberDisclosure`, `absent` is
 * the SAFE answer — the reader publishes nothing without a declared sentence —
 * so `absent` is deliberately unpinned. That makes "measured as absent" the one
 * outcome a real declaration must never produce: the site would be in neither
 * the pinned member-facing set nor the pinned forwarded set, invisible to the
 * census, while the runtime reader honoured it and the member read the text.
 */
describe("audit writer census scanner: a declaration the walk cannot name (#2695)", () => {
  function disclosures(census: ReturnType<typeof scanAuditWriterCensus>) {
    return census.sites.map((site) => describeMemberDisclosure(site.memberDisclosure));
  }

  it("treats a COMPUTED property key as unreadable rather than as an absent one", () => {
    // Both objects declare member-facing text at run time; neither names the key
    // in a form `propertyName` can resolve. The walk used to SKIP a property it
    // could not name, so the object measured as though the key were not there.
    const census = tree({
      "src/lane.ts": `
        const KEY = "memberDisclosure";
        export async function write(logAudit: any, note: string) {
          logAudit({
            action: "member.deletion_rejected",
            category: "privacy",
            [KEY]: { visibility: "member-facing", text: note },
          });
          logAudit({
            action: "member.credit.adjustment.approve",
            category: "payment",
            ["memberDisclosure"]: { visibility: "member-facing", text: note },
          });
        }
      `,
    });

    expect(disclosures(census)).toEqual([
      "forwarded:unreadable keys",
      "forwarded:unreadable keys",
    ]);
    // Neither is in the member-facing set — the walk genuinely cannot read the
    // declaration — but neither is silently absent either, which is the point:
    // both land in the population the manifest pins and a reviewer sees.
    expect(census.memberFacing).toHaveLength(0);
    expect(census.memberDisclosureForwarded).toHaveLength(2);
  });

  it("treats a GETTER as unreadable too, and the same for the category column", () => {
    // The second form of the same hole. A getter names the key plainly and
    // holds no initialiser expression, so the walk skipped it — and it skipped
    // it for `category` as well, which reported an omission that is not one.
    const census = tree({
      "src/lane.ts": `
        export async function write(logAudit: any, note: string) {
          logAudit({
            action: "member.deletion_rejected",
            get category() { return "privacy"; },
            get memberDisclosure() {
              return { visibility: "member-facing" as const, text: note };
            },
          });
        }
      `,
    });

    expect(disclosures(census)).toEqual(["forwarded:unreadable keys"]);
    expect(report(census)).toEqual([
      { sink: "logAudit", category: "forwarded:unreadable keys" },
    ]);
    // And NOT counted as a writer that forgot its category, which is the
    // failure a reviewer would otherwise have to chase to a getter.
    expect(census.uncategorised).toHaveLength(0);
  });

  it("still reads an ordinary declaration, so failing closed has not become failing always", () => {
    const census = tree({
      "src/lane.ts": `
        export async function write(logAudit: any, note: string) {
          logAudit({
            action: "member.credit.adjustment.approve",
            category: "payment",
            memberDisclosure: { visibility: "member-facing", text: note },
          });
          logAudit({
            action: "member.deletion_rejected",
            category: "privacy",
            memberDisclosure: { visibility: "internal" },
          });
          logAudit({ action: "member.updated", category: "account" });
        }
      `,
    });

    expect(disclosures(census)).toEqual([
      "member-facing",
      "internal",
      "(absent)",
    ]);
    expect(census.memberDisclosureForwarded).toHaveLength(0);
  });
});

/**
 * The census FILE a human reads, as opposed to the census a test reads.
 *
 * #2695's acceptance criterion is "re-census every event currently rendered to
 * members", and this TSV is the artifact that is done with. Nothing tested the
 * renderer, so three columns were added to both row builders and to neither the
 * header: the ninth column read `omitsRetentionInputs` and carried a
 * disclosure, and three columns had no name at all.
 */
describe("audit writer census TSV (#2695)", () => {
  it("names every column each row actually carries", () => {
    const census = tree({
      "src/lane.ts": `
        export async function write(logAudit: any, prisma: any, note: string) {
          logAudit({
            action: "member.credit.adjustment.approve",
            category: "payment",
            summary: "Credit adjusted",
            details: \`for \${note}\`,
            memberDisclosure: { visibility: "member-facing", text: note },
          });
          await prisma.auditLog.updateMany({ where: {}, data: { archivedAt: new Date() } });
        }
      `,
      "prisma/migrations/20260101000000_x/migration.sql": `
        INSERT INTO "AuditLog" ("id", "action", "category") VALUES ('a', 'b', 'admin');
      `,
    });

    const lines = renderCensusTsv(census).split("\n");
    const header = lines[0]?.split("\t") ?? [];

    expect(header).toEqual(AUDIT_CENSUS_TSV_COLUMNS);
    // A write site, a non-row-producing DML statement and a migration SQL row
    // all share the table, so all three row shapes are counted against it.
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1)) {
      expect(line.split("\t")).toHaveLength(header.length);
    }

    // The column that carried a disclosure under the wrong name, read by name.
    const site = lines[1]?.split("\t") ?? [];
    expect(site[header.indexOf("memberDisclosure")]).toBe("member-facing");
    expect(site[header.indexOf("detailsText")]).toBe("dynamic");
    expect(site[header.indexOf("detailsShape")]).toBe("text");
    expect(site[header.indexOf("summaryText")]).toBe("constant");
    expect(site[header.indexOf("omitsRetentionInputs")]).toBe("true");
  });
});

/**
 * RE-CENSUSING THE DETAIL SHAPES (#2704).
 *
 * The issue asks for the legacy and current `details` shapes to be re-censused,
 * and this is the column that makes that reproducible instead of a hand count:
 * a payload written as `JSON.stringify(…)` is governed by the structural
 * reduction, a sentence keeps the honest text clip, and the two are now
 * distinguishable in the artifact a human reads.
 *
 * PINNED AS BEHAVIOUR, NOT AS A POPULATION, and that is a deliberate choice.
 * The reduction lives at the write boundary and covers every site
 * automatically, so a new payload writer needs no per-site review — an exact
 * 104-entry pin would cost every future lane a manifest edit and buy nothing.
 * It would also mint one more count for two branches to collide on
 * byte-identically, which the manifest records happening five separate times.
 * What has to be true is that the scanner can TELL the shapes apart, and these
 * fixtures are what says so.
 *
 * Measured on this tree the day it was written: 104 payload sites, 167 text,
 * 195 absent, 8 unreadable. The 104 agrees with an independent
 * `grep -c "details: JSON.stringify"` over `src/` and `scripts/`, which is the
 * point of measuring it two ways.
 */
describe("audit writer census detail shapes (#2704)", () => {
  it("tells a JSON payload apart from a sentence, and from no details at all", () => {
    const census = tree({
      "src/lane.ts": `
        export async function write(logAudit: any, note: string, payload: any) {
          logAudit({
            action: "booking.period.update",
            category: "booking",
            details: JSON.stringify({ before: 1, after: 2 }),
          });
          logAudit({
            action: "booking.review.reject",
            category: "booking",
            details: \`Declined. \${note}\`,
          });
          logAudit({
            action: "booking.confirm_pending_guests",
            category: "booking",
            summary: "Confirmed",
          });
          logAudit({
            action: "booking.forwarded",
            category: "booking",
            details: payload,
          });
        }
      `,
    });

    const shapeByAction = new Map(
      census.sites.map((site) => [site.action, site.detailsShape.kind]),
    );

    expect(shapeByAction.get("booking.period.update")).toBe("payload");
    expect(shapeByAction.get("booking.review.reject")).toBe("text");
    expect(shapeByAction.get("booking.confirm_pending_guests")).toBe("absent");
    // A payload assembled elsewhere reads as `text`. That UNDER-counts, which is
    // the safe direction for a measurement nobody gates on: it can understate
    // how many payload writers exist and can never invent one.
    expect(shapeByAction.get("booking.forwarded")).toBe("text");
  });
});
