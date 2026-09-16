import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2926 — `HutLeaderAssignment.source` must be written once and never updated.
 *
 * The whole point of the column is that a membership edit cannot flip it. That
 * property is what lets the overlap carve-out key on the ROW's provenance rather
 * than on `Member.role`, which is derived from admin-writable access roles and
 * moves whenever somebody edits a member.
 *
 * But immutability was true by CONVENTION only: three writers stamp it at insert
 * and nothing updates it, and nothing said so. A fourth writer, or an `update`
 * that included `source`, would silently reopen exactly the hole the column was
 * added to close, and no other test in the tree would notice.
 *
 * This scans the source tree from disk, so it has no import edge to the files it
 * reads and `vitest related` cannot reach it — that is deliberate and matches the
 * other census tests here. It is CI-caught by design.
 */

const SRC = path.resolve(__dirname, "..", "..");

/** Every tracked .ts/.tsx file under src/, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = sourceFiles(SRC);

/** Repo-relative, forward-slashed, so failure messages are copy-pasteable. */
function rel(file: string): string {
  return path.relative(path.resolve(SRC, ".."), file).split(path.sep).join("/");
}

/**
 * Does this file STAMP the column, as opposed to reading it?
 *
 * #3369 added a `where: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING }` —
 * the school-member classification census asking whether a member is a school
 * booking's hut leader — and the original whole-file substring scan called that
 * a fourth writer. Filtering on a column is not stamping it, and a census that
 * cannot tell the two apart either grows an allowlist of readers or gets dodged
 * by renaming a variable, which is worse than both.
 *
 * So the `where` CLAUSE is removed and what is left is matched. The first cut
 * skipped the whole LINE instead, which is a different rule and a weaker one: a
 * single-line write — `updateMany({ where: { id }, data: { source: … } })`,
 * which is how a one-liner is written and how a formatter leaves a short call —
 * carries both words on one line and was invisible to it. The fixture below
 * proves all three directions: a real stamp is caught, a read is not, and a
 * stamp sharing its line with a filter is still a stamp.
 */
function withoutWhereClauses(line: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = line.indexOf("where:", cursor);
    if (at === -1) return out + line.slice(cursor);
    out += line.slice(cursor, at);
    const open = line.indexOf("{", at);
    if (open === -1) return out + line.slice(at + "where:".length);
    // Brace-balanced, so a nested filter goes with its parent — and a clause
    // that OPENS on this line and closes on a later one takes the rest of this
    // line with it, which is correct: everything after it on this line is
    // inside the filter.
    let depth = 0;
    let index = open;
    for (; index < line.length; index += 1) {
      if (line[index] === "{") depth += 1;
      else if (line[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
    }
    cursor = index;
  }
}

function stampsTheColumn(source: string): boolean {
  return source
    .split("\n")
    .some((line) =>
      withoutWhereClauses(line).includes("source: HutLeaderAssignmentSource."),
    );
}

describe("#2926 — HutLeaderAssignment.source is write-once", () => {
  it("is stamped by exactly the three known writers, and no others", () => {
    const EXPECTED = [
      // An officer deliberately assigning a leader.
      "src/app/api/admin/hut-leaders/route.ts",
      // The nightly sole-adult rule.
      "src/lib/cron-hut-leader-auto-assign.ts",
      // One row per teacher when a school request is approved.
      "src/lib/school-booking-request.ts",
    ].sort();

    const found = FILES.filter((file) =>
      stampsTheColumn(readFileSync(file, "utf8")),
    )
      .map(rel)
      .sort();

    expect(
      found,
      "a writer of HutLeaderAssignment.source was added or removed. If it is a " +
        "new legitimate insert, add it here with a comment saying what creates " +
        "the row. If it is an UPDATE, do not add it: the column is write-once, " +
        "and the overlap carve-out in findHutLeaderOverlapRefusal depends on it.",
    ).toEqual(EXPECTED);
  });

  it("is never included in a hutLeaderAssignment update", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      let index = text.indexOf("hutLeaderAssignment.update");
      while (index !== -1) {
        // Read the call's argument object: from the call to the first balanced
        // close. A window is enough here and avoids a parser for one pattern.
        const window = text.slice(index, index + 600);
        if (/\bsource\s*:/.test(window)) offenders.push(`${rel(file)} :: update`);
        index = text.indexOf("hutLeaderAssignment.update", index + 1);
      }
    }

    expect(
      offenders,
      "an update writes HutLeaderAssignment.source. The column is write-once " +
        "BECAUSE the teacher carve-out keys on it: if an update can change it, " +
        "a row can be moved in or out of the overlap check after the fact, " +
        "which is the Member.role hole #2926 exists to avoid.",
    ).toEqual([]);
  });

  it("tells a stamp from a read, so narrowing it did not blind it", () => {
    // A real insert, in the shape all three writers use.
    expect(
      stampsTheColumn(
        [
          "await tx.hutLeaderAssignment.create({",
          "  data: {",
          "    memberId,",
          "    source: HutLeaderAssignmentSource.SCHOOL_BOOKING,",
          "  },",
          "});",
        ].join("\n"),
      ),
    ).toBe(true);

    // The #3369 read — the same words, filtering rather than writing.
    expect(
      stampsTheColumn(
        [
          "hutLeaderAssignments: {",
          "  where: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING },",
          "  take: 1,",
          "},",
        ].join("\n"),
      ),
    ).toBe(false);

    // And a file holding BOTH is still a writer: the clause is removed rather
    // than the line skipped, so a reader cannot hide a stamp by putting a
    // `where:` somewhere above it.
    expect(
      stampsTheColumn(
        [
          "  where: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING },",
          "  data: { source: HutLeaderAssignmentSource.ADMIN },",
        ].join("\n"),
      ),
    ).toBe(true);

    // THE ONE-LINE WRITE, which the first cut could not see at all: a filter
    // and a stamp on the SAME line. Skipping the line hid it; removing the
    // clause does not. This is the shape a short `updateMany` is written in.
    expect(
      stampsTheColumn(
        "await tx.hutLeaderAssignment.updateMany({ where: { id }, data: { source: HutLeaderAssignmentSource.ADMIN } });",
      ),
    ).toBe(true);

    // The same line without the stamp is still only a read.
    expect(
      stampsTheColumn(
        "const rows = await tx.hutLeaderAssignment.findMany({ where: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING }, take: 1 });",
      ),
    ).toBe(false);

    // A nested filter goes with its parent rather than confusing the balance.
    expect(
      stampsTheColumn(
        "const rows = await tx.member.findMany({ where: { hutLeaderAssignments: { some: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING } } } });",
      ),
    ).toBe(false);
  });

  it("is not settable through updateMany either", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      let index = text.indexOf("hutLeaderAssignment.updateMany");
      while (index !== -1) {
        const window = text.slice(index, index + 600);
        if (/\bsource\s*:/.test(window)) offenders.push(`${rel(file)} :: updateMany`);
        index = text.indexOf("hutLeaderAssignment.updateMany", index + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});
