import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * `INV-PAY-051` - the expand half of a two-release enum addition, and the rule
 * that the halves stay in different releases (#3213, epic #2797).
 *
 * WHAT THIS EXISTS TO CATCH. A production deploy runs migrations BEFORE the new
 * colour takes traffic, while the previous colour is still serving requests
 * against the same database (`docs/BLUE_GREEN_MIGRATION_POLICY.md`; the cutover
 * is step 17/20 of `docs/PRODUCTION_UPGRADE_RUNBOOK.md`, and the new colour AND
 * the `app` cron leader are warmed before it). That colour's generated Prisma
 * client knows `ManualRefundTaskKind` with four labels and cannot deserialize a
 * fifth.
 *
 * AND THE READ THAT WOULD MEET ONE IS THE WHOLE QUEUE'S. The finance queue's
 * loader selects `kind` over EVERY OPEN row
 * (`src/app/api/admin/payments/manual-refund-tasks/route.ts`), so one row
 * carrying the new label would not degrade one card: it would fail the entire
 * "money to settle by hand" list, including real hand-backs the club owes
 * members. The completion door selects it too. Registering the label breaks
 * neither; writing it does. So this release registers it and the release after
 * it starts writing it.
 *
 * WHY A CENSUS RATHER THAN A NOTE. "Nothing writes this yet" is a property of
 * the whole tree, held over a release boundary, by whoever next edits the
 * finance queue - exactly the kind of promise a comment does not keep. The value
 * is a legal member of the generated Prisma enum the moment the schema names it,
 * so the compiler will happily accept a writer. This is the thing that will not.
 *
 * IT SCANS `src/` FROM DISK, so it has no import edge to the files it reads and
 * `npm run test:related` structurally cannot select it (`docs/TESTING.md`). Run
 * it by name.
 */

const REPO_ROOT = process.cwd();

/** The registered-but-unwritten label. */
const PENDING_KIND = "UNCOLLECTED_EDIT_REVIEW_SHARE";

/** The expand migration that registers it. */
const EXPAND_MIGRATION =
  "20260910010000_register_uncollected_edit_review_share_kind";

/**
 * The modules allowed to NAME the label this release, and why each one has to.
 *
 * Naming is not writing, and the write-shape assertion below still applies to
 * both of them.
 *
 *   * the settlement rules hold the dismiss-only rule itself, which must compare
 *     against the label to answer whether one of these may be settled at all.
 *     The completion door and the queue card both ASK it rather than deciding
 *     again, so the label is named once for that purpose (`INV-SSOT`);
 *   * the queue card holds the officer's wording, which lands in this release
 *     for the same reason #3232's did - when the runtime half comes it changes a
 *     writer, not a writer plus a screen.
 *
 * THE COMPLETION DOOR IS DELIBERATELY NOT ON THIS LIST. It refuses the close by
 * calling the rule above rather than by comparing the label itself, so it never
 * names it - and leaving it listed would be an allowance for something that is
 * not there, which is how an allowlist stops describing the tree it guards.
 */
const DECLARING_MODULES = [
  "src/lib/manual-refund-task-settlement-rules.ts",
  "src/components/admin/manual-refund-task-queue.tsx",
];

/**
 * A write of the kind, in the only shape the tree can express one.
 *
 * Every `ManualRefundTask` row is created through Prisma with a `kind:`
 * property (`booking-cancel.ts`, `deleted-booking-modification-payment.ts`,
 * `edit-financial-review.ts`), so a writer has to name the label at some
 * `kind:`. Matching that shape rather than the bare token is what lets the two
 * declaring modules keep their comparison and their wording.
 */
const WRITE_SHAPE = new RegExp(
  `kind\\s*:\\s*(?:["']|ManualRefundTaskKind\\.)?${PENDING_KIND}`,
);

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

describe("INV-PAY-051: the withheld-share item type is registered, not yet written (#3213)", () => {
  it("registers the label in the schema, appended and never reordered", () => {
    const schema = read("prisma/schema.prisma");
    const block = /enum ManualRefundTaskKind \{([^}]*)\}/.exec(schema);
    expect(block, "the enum must still exist under this name").not.toBeNull();

    const values = (block?.[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));

    // ORDER IS PART OF THE ASSERTION. PostgreSQL cannot remove or re-sort an
    // enum label, so a reordering here would be a migration that cannot exist.
    expect(values).toEqual([
      "CANCELLED_BOOKING_HAND_BACK",
      "DELETED_BOOKING_LATE_CAPTURE",
      "AUTOMATIC_LATE_CAPTURE_RECORD",
      "EDIT_FINANCIAL_REVIEW",
      PENDING_KIND,
    ]);
  });

  it("registers it by a migration that writes no row", () => {
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
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter((statement) => statement.length > 0);

    expect(statements[0]).toBe(
      `ALTER TYPE "ManualRefundTaskKind" ADD VALUE IF NOT EXISTS '${PENDING_KIND}'`,
    );
    // The constraint is relaxed so the label will be USABLE - the
    // payment-recovery replay holds no share figure, and 0 may never mean
    // unknown. Compared as text on purpose: PostgreSQL refuses to USE a new enum
    // label in the transaction that added it, and Prisma runs each migration in
    // one.
    expect(statements).toHaveLength(5);
    expect(statements[2]).toContain(`"kind"::text`);
    expect(statements[2]).toContain(PENDING_KIND);
    // The duplicate fence: the unique index on `occurrenceKey` exempts NULL, so
    // the key has to be MANDATORY for this kind or a replaying writer raises a
    // second item for the same withheld share and an officer bills it twice.
    // Free to add now and only now - no row can carry the label, so the
    // validating scan can refuse nothing.
    expect(statements[4]).toContain(
      `"ManualRefundTask_edit_review_occurrence_key_present"`,
    );
    expect(statements[4]).toContain(PENDING_KIND);
    expect(statements[4]).toContain(`"occurrenceKey" IS NOT NULL`);
    expect(statements.join(" ")).not.toMatch(/::"ManualRefundTaskKind"/);
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
    expect(plan).toContain("EXPAND HALF OF A TWO-RELEASE SEQUENCE");
    expect(plan).toContain("NOTHING WRITES IT");
    expect(plan).toContain("uncollected-edit-review-share-expand.test.ts");
  });

  it("finds no writer of the label anywhere under src/", () => {
    const files = everySourceFile();
    // A census that scanned nothing would pass vacuously, and an empty result is
    // exactly the shape that hides that.
    expect(
      files.length,
      "the walk found almost no source files, so every result below is vacuous",
    ).toBeGreaterThan(1500);

    const offenders: string[] = [];
    let sawTheLabelSomewhere = false;
    for (const file of files) {
      const code = stripComments(read(file));
      if (code.includes(PENDING_KIND)) sawTheLabelSomewhere = true;
      if (WRITE_SHAPE.test(code)) {
        offenders.push(`${file} (writes it)`);
        continue;
      }
      if (!DECLARING_MODULES.includes(file) && code.includes(PENDING_KIND)) {
        offenders.push(
          `${file} (names it outside ${DECLARING_MODULES.join(" / ")})`,
        );
      }
    }

    // Proof the scan reaches real code with the right spelling: the guard
    // compares against the label and the card names it, and both survive
    // comment-stripping.
    expect(
      sawTheLabelSomewhere,
      `no file under src/ mentions ${PENDING_KIND} at all, so the token has been renamed or the scan is broken`,
    ).toBe(true);

    expect(
      offenders,
      [
        `${PENDING_KIND} is REGISTERED BUT NOT YET WRITABLE (INV-PAY-051, #3213).`,
        `Migration ${EXPAND_MIGRATION} is the expand half: it registers the label so`,
        "the database will accept it. But the previously deployed colour is still serving",
        "during a deploy and its Prisma client cannot deserialize a fifth label - and the",
        "finance queue's loader selects `kind` over EVERY OPEN row, so one such row fails",
        "the whole hand-back queue rather than one card.",
        "",
        "WHAT TO DO INSTEAD: wait for the FOLLOWING release. Until then a withheld share is",
        "recorded as the `booking.editFinancialReview.chargeShareUncollected` audit entry it",
        "has always been, which names the booking, the edit and the total in prose. When that",
        "release comes, delete this assertion in the same change that starts writing the value.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("would notice a writer - the detector is not blind", () => {
    // The assertion above is an empty-list assertion, so the detector is
    // exercised against content that SHOULD trip it. Without this, a broken
    // regex and a clean tree are indistinguishable.
    expect(WRITE_SHAPE.test(`kind: "${PENDING_KIND}",`)).toBe(true);
    expect(WRITE_SHAPE.test(`kind: ManualRefundTaskKind.${PENDING_KIND},`)).toBe(
      true,
    );
    expect(WRITE_SHAPE.test(`  kind:   '${PENDING_KIND}'`)).toBe(true);
    // And not against the shapes the declaring modules legitimately hold.
    expect(
      WRITE_SHAPE.test(`task.kind === ManualRefundTaskKind.${PENDING_KIND} &&`),
    ).toBe(false);
    expect(
      WRITE_SHAPE.test(`const WITHHELD_SHARE_KIND: ManualRefundTaskKind =`),
    ).toBe(false);
  });
});
