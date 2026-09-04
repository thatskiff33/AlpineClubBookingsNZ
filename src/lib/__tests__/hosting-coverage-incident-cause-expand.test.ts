import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { describeHostingCoverageIncidentCause } from "@/lib/adult-member-hosting-coverage-incidents";

import { stripComments } from "./support/strip-comments";

/**
 * `INV-HOST-052` — the expand half of a two-release enum addition, and the rule
 * that the halves stay in different releases (#3232 D3).
 *
 * WHAT THIS EXISTS TO CATCH. A production deploy runs migrations BEFORE the new
 * colour takes traffic, while the previous colour is still serving requests
 * against the same database (`docs/BLUE_GREEN_MIGRATION_POLICY.md`). That
 * colour's generated Prisma client knows `HostingCoverageIncidentCause` with two
 * labels and cannot deserialize a third, and the label is selected by the
 * incident writer's OWN fold read — so a row carrying the new value during the
 * drain breaks every re-evaluation drain, not merely a screen. Registering the
 * label is safe; writing it is not. So this release registers it and the release
 * after it starts writing it.
 *
 * WHY A CENSUS RATHER THAN A NOTE. "Nothing writes this yet" is a property of
 * the whole tree, held over a release boundary, by whoever next edits the
 * hosting engine — which is exactly the kind of promise a comment does not keep.
 * The value is now a legal member of the TypeScript union (it has to be, so the
 * officer-facing reader can name it), which means the compiler will happily
 * accept a writer that produces it. This is the thing that will not.
 *
 * IT SCANS `src/` FROM DISK, so it has no import edge to the files it reads and
 * `npm run test:related` structurally cannot select it (`docs/TESTING.md`). Run
 * it by name.
 */

const REPO_ROOT = process.cwd();

/** The registered-but-unwritten label. */
const PENDING_CAUSE = "OWNER_DECLINED_LINKED_MOVE";

/** The expand migration that registers it. */
const EXPAND_MIGRATION =
  "20260909010000_add_owner_declined_linked_move_incident_cause";

/**
 * The one module allowed to NAME the label this release: it declares the mirror
 * union and holds the single officer-facing wording. Naming is not writing, and
 * the write-shape assertion below still applies to this file.
 */
const DECLARING_MODULE = "src/lib/adult-member-hosting-coverage-incidents.ts";

/** The two officer surfaces that render a cause. */
const OFFICER_SURFACES = [
  "src/app/(admin)/admin/bookings/page.tsx",
  "src/lib/stuck-state-dashboard.ts",
];

/**
 * A write of the cause, in the only shape the tree can express one.
 *
 * Every cause reaches both the queue item and the incident row through
 * `HostingCoverageChangeContext.cause`, so a writer has to name the label at
 * some `cause:` property. Matching that shape rather than the bare token is what
 * lets `DECLARING_MODULE` keep its union member and its `case` label.
 */
const WRITE_SHAPE = new RegExp(`cause\\s*:\\s*["']?${PENDING_CAUSE}`);

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** Every non-test TypeScript file under `src/`, as repo-relative POSIX paths. */
function everySourceFile(): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(REPO_ROOT, relative), {
      withFileTypes: true,
    })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(child);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(child);
    }
  };
  walk("src");
  return found;
}

describe("INV-HOST-052: the declined-linked-move cause is registered, not yet written (#3232 D3)", () => {
  it("registers the label in the schema, appended and never reordered", () => {
    const schema = read("prisma/schema.prisma");
    const block = /enum HostingCoverageIncidentCause \{([^}]*)\}/.exec(schema);
    expect(block, "the enum must still exist under this name").not.toBeNull();

    const values = (block?.[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));

    // ORDER IS PART OF THE ASSERTION. PostgreSQL cannot remove or re-sort an
    // enum label, so a reordering here would be a migration that cannot exist.
    expect(values).toEqual(["OFFICER_OVERRIDE", "SYSTEM_CHANGE", PENDING_CAUSE]);
  });

  it("registers it by an additive migration that writes no row", () => {
    const migration = read(`prisma/migrations/${EXPAND_MIGRATION}/migration.sql`);
    // A LINE FILTER, not a comment scanner: `stripComments` is the canonical
    // JavaScript stripper (`INV-SSOT-004`) and knows nothing about SQL's `--`,
    // and writing a SQL one here would be the second scanner that rule exists to
    // stop. Every comment in this migration is a whole line, which is the house
    // shape for a migration header.
    const statements = migration
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    expect(statements).toEqual([
      `ALTER TYPE "HostingCoverageIncidentCause" ADD VALUE IF NOT EXISTS '${PENDING_CAUSE}'`,
    ]);
    // No DML, so every existing row is byte-identical afterwards and the
    // data-migration verification gate has nothing to demand.
    expect(statements.join(" ")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("declares the expand and its deploy order where a deployer reads them", () => {
    const row = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${EXPAND_MIGRATION}\t`));
    expect(row, `${EXPAND_MIGRATION} must have a safety-ledger row`).toBeTruthy();

    const [, phase, previousExpand, compatible, plan] = (row ?? "").split("\t");
    expect(phase).toBe("expand");
    expect(previousExpand).toBe("n/a");
    expect(compatible).toBe("yes");
    // The ordering is the whole decision, so the plan an operator reads has to
    // carry both halves rather than leaving them to the pull-request body.
    expect(plan).toMatch(/RELEASE 1/);
    expect(plan).toMatch(/RELEASE 2/);
    expect(plan).toContain("hosting-coverage-incident-cause-expand.test.ts");
  });

  it("finds no writer of the label anywhere under src/", () => {
    const files = everySourceFile();
    // A census that scanned nothing would pass vacuously, and an empty result is
    // exactly the shape that hides that. 2184 files at the time of writing.
    expect(
      files.length,
      "the walk found almost no source files, so every result below is vacuous",
    ).toBeGreaterThan(1500);

    const offenders: string[] = [];
    let sawTheLabelSomewhere = false;
    for (const file of files) {
      const code = stripComments(read(file));
      if (code.includes(PENDING_CAUSE)) sawTheLabelSomewhere = true;
      if (WRITE_SHAPE.test(code)) {
        offenders.push(`${file} (writes it)`);
        continue;
      }
      if (file !== DECLARING_MODULE && code.includes(PENDING_CAUSE)) {
        offenders.push(`${file} (names it outside ${DECLARING_MODULE})`);
      }
    }

    // Proof the scan reaches real code with the right spelling: the declaring
    // module names the label in its union and in its wording switch, and that
    // survives comment-stripping.
    expect(
      sawTheLabelSomewhere,
      `no file under src/ mentions ${PENDING_CAUSE} at all, so the token has been renamed or the scan is broken`,
    ).toBe(true);

    expect(
      offenders,
      [
        `${PENDING_CAUSE} is REGISTERED BUT NOT YET WRITABLE (INV-HOST-052, #3232 D3).`,
        `Migration ${EXPAND_MIGRATION} is the expand half: it registers the label so`,
        "the database will accept it. But the previously deployed colour is still serving",
        "during a deploy and its Prisma client cannot deserialize a third label, and the",
        "incident writer's own fold read selects `cause` — so a row carrying this value",
        "breaks every re-evaluation drain, not merely a screen.",
        "",
        "WHAT TO DO INSTEAD: wait for the FOLLOWING release. Until then a declined linked",
        "move is stored as SYSTEM_CHANGE and the member's decision is recorded in words in",
        "the incident's audit history, which is what an officer reads. When that release",
        "comes, delete this assertion in the same change that starts writing the value.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("would notice a writer — the detector is not blind", () => {
    // The assertion above is an empty-list assertion, so the detector is exercised
    // against content that SHOULD trip it. Without this, a broken regex and a
    // clean tree are indistinguishable.
    expect(WRITE_SHAPE.test(`cause: "${PENDING_CAUSE}",`)).toBe(true);
    expect(WRITE_SHAPE.test(`cause: ${PENDING_CAUSE},`)).toBe(true);
    expect(WRITE_SHAPE.test(`  cause:   "${PENDING_CAUSE}"`)).toBe(true);
    // And not against the two shapes the declaring module legitimately holds.
    expect(WRITE_SHAPE.test(`  | "${PENDING_CAUSE}";`)).toBe(false);
    expect(WRITE_SHAPE.test(`    case "${PENDING_CAUSE}":`)).toBe(false);
  });

  it("has the officer's wording ready for the value in THIS release", () => {
    // The stored value waits; the words do not. When the runtime half lands it
    // changes a writer, not a writer plus two screens.
    const declined = describeHostingCoverageIncidentCause(PENDING_CAUSE);
    expect(declined).toMatch(/chose not to move/);

    const system = describeHostingCoverageIncidentCause("SYSTEM_CHANGE");
    const override = describeHostingCoverageIncidentCause("OFFICER_OVERRIDE");
    expect(new Set([declined, system, override]).size).toBe(3);

    // The corrected wording. "qualification changed" was asserted for every
    // non-override incident, including an administrative cancellation, a data
    // correction and — until the runtime half lands — a member who declined the
    // linked move. The phrase has to be true of everything the value holds.
    expect(system).not.toMatch(/qualification/i);
    // And it must not claim cover was REMOVED either, which was the same mistake
    // in a new direction: a club tightening its own policy removed nothing (the
    // rule moved), and an officer confirming pending guests ADDED people the
    // existing cover no longer stretches to.
    expect(system).not.toMatch(/removed/i);
    expect(system).toMatch(/no longer covered/);

    // An unrecognised label describes itself rather than crashing a queue.
    expect(describeHostingCoverageIncidentCause("SOMETHING_ELSE")).toMatch(
      /not recognised/,
    );
  });

  it("keeps that wording in ONE home, on both officer surfaces", () => {
    for (const surface of OFFICER_SURFACES) {
      const code = stripComments(read(surface));
      expect(
        code,
        `${surface} must render a cause through describeHostingCoverageIncidentCause`,
      ).toContain("describeHostingCoverageIncidentCause(");
      // The two surfaces had drifted into two different wordings for one stored
      // value ("qualification changed" here, "system change" there). A literal
      // label in either file is that drift starting again (INV-SSOT-001).
      expect(
        code,
        `${surface} must not branch on a cause label of its own`,
      ).not.toContain("OFFICER_OVERRIDE");
    }
  });
});
