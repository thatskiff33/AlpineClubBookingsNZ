import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  type ModuleKey,
} from "@/config/modules";

/**
 * #2996 — the operator Modules reference is reconciled against the registry.
 *
 * `docs/guides/modules.md` carries a "Settings reference" table with one row per
 * optional module: its label and key, what it enables in operator language, and
 * its out-of-the-box default. The prose is curated by hand and stays that way —
 * the issue rejected generating the guide from `MODULE_DEFINITIONS`, because an
 * operator needs an explanation and not a dump of source labels. What is NOT
 * left to hand maintenance is the table's key coverage: at the time this was
 * written three registered modules had no row at all, and nothing said so.
 *
 * So this suite parses THAT TABLE — not the guide's prose, where a key can be
 * mentioned in a troubleshooting row without the module being documented — and
 * checks it against `MODULE_KEYS` in both directions, plus the two facts the
 * registry can vouch for robustly: the label (`MODULE_DEFINITIONS[key].label`)
 * and the default (`DEFAULT_MODULE_SETTINGS[key]`, rendered On/Off). The
 * "Enables" cell is only required to be non-empty; its wording is the guide's
 * business, and it need not match the source description.
 *
 * A key retired from the registry has to leave the table, or move to a section
 * the parser does not read; a historical note elsewhere in the guide is fine.
 */

const GUIDE_PATH = path.join(process.cwd(), "docs/guides/modules.md");
const SECTION_HEADING = "## Settings reference";
const TABLE_HEADER = ["Module", "Enables", "Default"];

interface ReferenceRow {
  line: number;
  label: string;
  key: string;
  enables: string;
  defaultCell: string;
}

/** The lines of the "Settings reference" section, up to the next `## ` heading. */
function settingsReferenceSection(guide: string): { lines: string[]; start: number } {
  const lines = guide.split("\n");
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start < 0) {
    throw new Error(
      `${GUIDE_PATH} has no "${SECTION_HEADING}" heading; the reference table lives under it.`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines: lines.slice(start + 1, end), start: start + 1 };
}

/**
 * Cells split on UNESCAPED pipes only, so a `\|` inside a cell stays in the
 * cell (and is unescaped) — which is what the parse error below tells an author
 * to write. The first version split on every pipe and then gave that advice,
 * so following it failed the same way (PR #3265 review).
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** The one table in the section headed `| Module | Enables | Default |`. */
function parseReferenceTable(guide: string): ReferenceRow[] {
  const { lines, start } = settingsReferenceSection(guide);
  const headerIndex = lines.findIndex(
    (line) =>
      line.trim().startsWith("|") &&
      splitTableRow(line).join("|") === TABLE_HEADER.join("|"),
  );
  if (headerIndex < 0) {
    throw new Error(
      `${GUIDE_PATH}: no table headed "| ${TABLE_HEADER.join(" | ")} |" under "${SECTION_HEADING}".`,
    );
  }
  const rows: ReferenceRow[] = [];
  // headerIndex + 1 is the `| --- | --- | --- |` separator.
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const lineNumber = start + i + 1;
    const cells = splitTableRow(line);
    if (cells.length !== TABLE_HEADER.length) {
      throw new Error(
        `${GUIDE_PATH}:${lineNumber}: expected ${TABLE_HEADER.length} cells, found ${cells.length}. ` +
          "A pipe inside a cell must be escaped as \\|.",
      );
    }
    const [moduleCell, enables, defaultCell] = cells;
    const match = /^(.*\S)\s*\(`([A-Za-z][A-Za-z0-9]*)`\)$/.exec(moduleCell);
    if (!match) {
      throw new Error(
        `${GUIDE_PATH}:${lineNumber}: the Module cell must read "Label (\`key\`)", found "${moduleCell}".`,
      );
    }
    rows.push({ line: lineNumber, label: match[1], key: match[2], enables, defaultCell });
  }
  return rows;
}

function renderDefault(key: ModuleKey): "On" | "Off" {
  return DEFAULT_MODULE_SETTINGS[key] ? "On" : "Off";
}

describe("docs/guides/modules.md Settings reference matches the module registry (#2996)", () => {
  const rows = parseReferenceTable(fs.readFileSync(GUIDE_PATH, "utf8"));
  const registry = new Set<string>(MODULE_KEYS);

  it("parses a non-empty table (the guard is not passing vacuously)", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("documents every registered module key exactly once", () => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    const missing = MODULE_KEYS.filter((key) => !counts.has(key));
    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key, count]) => `${key} (${count} rows)`);
    expect(
      missing,
      "registered in MODULE_KEYS but absent from the Settings reference table — add a row",
    ).toEqual([]);
    expect(duplicated, "documented more than once").toEqual([]);
  });

  it("carries no key the registry no longer has", () => {
    const stale = rows
      .filter((row) => !registry.has(row.key))
      .map((row) => `${row.key} (line ${row.line})`);
    expect(
      stale,
      "in the Settings reference table but not in MODULE_KEYS — remove the row or move it to a clearly historical section",
    ).toEqual([]);
  });

  it("uses each module's current label", () => {
    const wrong = rows
      .filter((row) => registry.has(row.key))
      .filter((row) => row.label !== MODULE_DEFINITIONS[row.key as ModuleKey].label)
      .map(
        (row) =>
          `${row.key} (line ${row.line}): "${row.label}" but the registry says "${MODULE_DEFINITIONS[row.key as ModuleKey].label}"`,
      );
    expect(wrong).toEqual([]);
  });

  it("states each module's actual out-of-the-box default", () => {
    const wrong = rows
      .filter((row) => registry.has(row.key))
      .filter((row) => row.defaultCell !== renderDefault(row.key as ModuleKey))
      .map(
        (row) =>
          `${row.key} (line ${row.line}): documented "${row.defaultCell}" but DEFAULT_MODULE_SETTINGS says ${renderDefault(row.key as ModuleKey)}`,
      );
    expect(wrong).toEqual([]);
  });

  it("gives every module an operator-facing description", () => {
    const blank = rows.filter((row) => row.enables === "").map((row) => row.key);
    expect(blank).toEqual([]);
  });
});
