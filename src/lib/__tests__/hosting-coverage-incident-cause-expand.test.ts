import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { describeHostingCoverageIncidentCause } from "@/lib/adult-member-hosting-coverage-incidents";

import { stripComments } from "./support/strip-comments";

/**
 * `INV-HOST-052` — a two-release enum addition, and what is left to hold once
 * both halves have landed (#3232 D3, #3241).
 *
 * WHY THE TWO RELEASES. A production deploy runs migrations BEFORE the new
 * colour takes traffic, while the previous colour is still serving requests
 * against the same database (`docs/BLUE_GREEN_MIGRATION_POLICY.md`). That
 * colour's generated Prisma client knew `HostingCoverageIncidentCause` with two
 * labels and could not deserialize a third, and the label is selected by the
 * incident writer's OWN fold read — so a row carrying the new value during the
 * drain would have broken every re-evaluation drain, not merely a screen.
 * Registering the label was safe; writing it was not. So one release registered
 * it while nothing wrote it, and #3241 added the writer.
 *
 * THE WRITER-BAN CENSUS IS THEREFORE GONE, DELIBERATELY. It failed the build on
 * any `cause:` naming the label anywhere under `src/`, which is exactly what
 * #3241 had to do; keeping it would have made that change unmergeable, and
 * deleting it in a separate change would have dropped the guard while the wait
 * was still real.
 *
 * WHAT REPLACES IT, AND WHY THERE IS STILL A CENSUS HERE. The property worth
 * holding now is that the label has EXACTLY ONE writer. "A member was asked and
 * declined" is a different fact from every automatic change `SYSTEM_CHANGE`
 * holds, and a second producer — a system cancellation, a policy tightening, a
 * merge fan-out reaching for the more specific-sounding label — would quietly
 * put an automatic change back into the count a club judges its own supervision
 * setting by, which is the whole reason the value exists. That is a property of
 * the tree held by whoever next edits the hosting engine, so it is the kind of
 * promise a comment does not keep, and the compiler cannot help: the value is a
 * legal member of the union, so it will accept a writer anywhere.
 *
 * IT SCANS `src/` FROM DISK, so it has no import edge to the files it reads and
 * `npm run test:related` structurally cannot select it (`docs/TESTING.md`). Run
 * it by name.
 */

const REPO_ROOT = process.cwd();

/** The declined offer's own cause. */
const DECLINED_CAUSE = "OWNER_DECLINED_LINKED_MOVE";

/** The expand migration that registered it, one release before #3241's writer. */
const EXPAND_MIGRATION =
  "20260909010000_add_owner_declined_linked_move_incident_cause";

/**
 * The module that declares the mirror union and holds the single officer-facing
 * wording. It names the label; it must not write it.
 */
const DECLARING_MODULE = "src/lib/adult-member-hosting-coverage-incidents.ts";

/**
 * The ONE arm allowed to write it: the owner-declined branch of
 * `hostingCoverageActorOptions` (#3241). Nothing else under `src/` may produce
 * the label, and nothing else may name it either — a screen that branched on it
 * would be the two-wordings drift starting again (`INV-SSOT-001`). Widening
 * either list is a deliberate change to `INV-HOST-052`, not a test fix.
 */
const WRITER_MODULE = "src/lib/adult-member-hosting-review.ts";

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
const WRITE_SHAPE = new RegExp(`cause\\s*:\\s*["']?${DECLINED_CAUSE}`);

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

describe("INV-HOST-052: the declined-linked-move cause, registered one release before its one writer (#3232 D3, #3241)", () => {
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
    expect(values).toEqual(["OFFICER_OVERRIDE", "SYSTEM_CHANGE", DECLINED_CAUSE]);
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
      `ALTER TYPE "HostingCoverageIncidentCause" ADD VALUE IF NOT EXISTS '${DECLINED_CAUSE}'`,
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

  it("has exactly one writer of the label under src/, and it is the declined arm", () => {
    const files = everySourceFile();
    // A census that scanned nothing would pass vacuously, and an empty offender
    // list is exactly the shape that hides that. 2184 files at the time of
    // writing.
    expect(
      files.length,
      "the walk found almost no source files, so every result below is vacuous",
    ).toBeGreaterThan(1500);

    const writers: string[] = [];
    const namers: string[] = [];
    for (const file of files) {
      const code = stripComments(read(file));
      if (WRITE_SHAPE.test(code)) writers.push(file);
      else if (code.includes(DECLINED_CAUSE)) namers.push(file);
    }

    // THE POSITIVE HALF FIRST, because it is what proves the scan reaches real
    // code with the right spelling. A renamed label, a moved arm or a broken
    // regex all show up here rather than as a silently clean sweep.
    expect(
      writers,
      [
        `${DECLINED_CAUSE} must be written by exactly one arm (INV-HOST-052, #3241):`,
        `the owner-declined branch in ${WRITER_MODULE}.`,
        "",
        "AN EMPTY LIST means the writer has been renamed, moved or removed — a",
        "declined offer would be back to filing itself as SYSTEM_CHANGE, silently,",
        "since no other test reads the tree.",
        "",
        "A SECOND ENTRY means some other change now files itself as a member's",
        "decision. `SYSTEM_CHANGE` covers every automatic change — an administrative",
        "cancellation, a lifecycle transition, a data correction, a club tightening",
        "its own policy, an officer confirming guests — and this label exists to keep",
        "a member's own prompted choice OUT of that count, which is the number a club",
        "judges its supervision setting by. Widening this is a change to INV-HOST-052.",
      ].join("\n"),
    ).toEqual([WRITER_MODULE]);

    // And naming it without writing it stays confined to the module that
    // declares the union and owns the one officer-facing phrase. A screen
    // branching on the label is the two-wordings drift starting again
    // (`INV-SSOT-001`), which the surfaces test below guards from the other end.
    expect(
      namers,
      `only ${DECLARING_MODULE} may name ${DECLINED_CAUSE} without writing it`,
    ).toEqual([DECLARING_MODULE]);
  });

  it("would notice a writer — the detector is not blind", () => {
    // Both assertions above turn on this regex, and one of them is an exact-list
    // assertion. Without this, a broken regex and a correct tree are
    // indistinguishable: the writer would drop out of `writers` and into
    // `namers`, and both lists would be wrong in a way that reads as a rename.
    expect(WRITE_SHAPE.test(`cause: "${DECLINED_CAUSE}",`)).toBe(true);
    expect(WRITE_SHAPE.test(`cause: ${DECLINED_CAUSE},`)).toBe(true);
    expect(WRITE_SHAPE.test(`  cause:   "${DECLINED_CAUSE}"`)).toBe(true);
    // And not against the two shapes the declaring module legitimately holds.
    expect(WRITE_SHAPE.test(`  | "${DECLINED_CAUSE}";`)).toBe(false);
    expect(WRITE_SHAPE.test(`    case "${DECLINED_CAUSE}":`)).toBe(false);
  });

  it("gives each recorded cause its own true officer-facing phrase", () => {
    // The wording landed with the EXPAND, one release ahead of the writer, which
    // is why #3241 changed a writer rather than a writer plus two screens — and
    // why an officer was never shown a value with no phrase for it.
    const declined = describeHostingCoverageIncidentCause(DECLINED_CAUSE);
    expect(declined).toMatch(/chose not to move/);

    const system = describeHostingCoverageIncidentCause("SYSTEM_CHANGE");
    const override = describeHostingCoverageIncidentCause("OFFICER_OVERRIDE");
    expect(new Set([declined, system, override]).size).toBe(3);

    // The corrected wording. "qualification changed" was asserted for every
    // non-override incident, including an administrative cancellation, a data
    // correction and — while the two labels were shared — a member who declined
    // the linked move. The phrase has to be true of everything the value holds,
    // which is now the automatic changes and nothing else.
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
