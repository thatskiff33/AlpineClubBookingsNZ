import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * Contract for #2440: every public render path reads PageContent through
 * `getPublishedPageContentByPath()`, which hides unpublished (draft) rows. A
 * module that imported or called the unfiltered `getSanitizedPageContentByPath()`
 * directly could serve an admin's draft to anonymous visitors — that is exactly
 * how /contact and /join regressed. This test bans the unfiltered read from ALL
 * application code (src/**, components and lib included, not just route
 * modules) except the one module that defines it; admin/API surfaces that
 * legitimately need drafts use `listEditablePageContent()` or their own
 * queries, not the by-path read.
 *
 * Matching is on the IMPORT SPECIFIER or a CALL of the banned name — never a
 * bare substring — so a comment or doc string may still name the function
 * without failing CI.
 */

const SRC_ROOT = path.join(__dirname, "..", "..");

/** The module that defines and may use the unfiltered read. */
const ALLOWED = new Set([path.join("lib", "page-content-html.ts")]);

const BANNED_USE_PATTERN =
  /(?:import\s+(?:type\s+)?\{[^}]*\bgetSanitizedPageContentByPath\b[^}]*\}|\bgetSanitizedPageContentByPath\s*\()/;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...(await collectSourceFiles(full)));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      files.push(full);
    }
  }

  return files;
}

describe("public PageContent published contract (#2440)", () => {
  it("no module under src/ imports or calls the unfiltered by-path read", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file);
      if (ALLOWED.has(relative)) continue;
      const source = await fs.readFile(file, "utf8");
      if (BANNED_USE_PATTERN.test(source)) {
        offenders.push(relative);
      }
    }

    expect(offenders, [
      "These modules read PageContent without the published filter.",
      "Use getPublishedPageContentByPath() from @/lib/page-content-html so",
      "draft pages are never served to the public (#2440):",
      ...offenders,
    ].join("\n")).toEqual([]);
  }, CENSUS_TIMEOUT_MS);
});
