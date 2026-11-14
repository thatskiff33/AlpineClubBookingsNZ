import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #4961 (`INV-SSOT-007`): an admin read that fails says so through the one
 * shared `AdminLoadError`, and never renders as its own empty state.
 *
 * The behaviour is proven per page by `admin-list-load-failure.test.tsx`. This
 * census keeps the wiring from drifting: every site below imports the shared
 * component, each empty state sits behind its page's load-error gate, and a
 * page that starts using the component must be added here with its gate, so
 * the list is the code's and not a memory of it. Disk-scanning: run by name
 * (`pnpm run test:named`).
 */
const ROOT = process.cwd();
const COMPONENT_SPECIFIER = "@/components/admin/admin-load-error";
const IMPORTS_COMPONENT = /import\s*\{[^}]*\bAdminLoadError\b[^}]*\}\s*from\s*["']@\/components\/admin\/admin-load-error["']/;

/**
 * Each page that renders `AdminLoadError`, with the empty-state markers its
 * load-error gate must precede. `gate` is the expression the JSX branches on;
 * `empty` is text (or an expression) only the "no rows" branch renders.
 */
const SITES: ReadonlyArray<{ file: string; guards: ReadonlyArray<{ gate: string; empty: string }> }> = [
  {
    file: "src/app/(admin)/admin/finance/payments/page.tsx",
    guards: [{ gate: "loadError ? (", empty: 'title="No payments found"' }],
  },
  {
    file: "src/app/(admin)/admin/finance/subscriptions/page.tsx",
    guards: [{ gate: "loadError ? (", empty: "No subscriptions found" }],
  },
  {
    file: "src/app/(admin)/admin/hut-leaders/page.tsx",
    guards: [
      { gate: "assignmentsLoadError ? (", empty: "assignments yet." },
      // The amber card's absence means "every night is covered", so its
      // condition itself must exclude the failed check.
      { gate: "!unassignedLoadError && unassignedDates.length > 0", empty: "unassignedDates.length > 0" },
    ],
  },
  {
    file: "src/app/(admin)/admin/messages/communications/page.tsx",
    guards: [{ gate: "historyLoadError ? (", empty: "No bulk communications sent yet." }],
  },
];

/** How far before its empty state a gate may sit and still be the same JSX branch chain. */
const GATE_WINDOW = 600;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function code(file: string): string {
  return stripComments(readFileSync(path.join(ROOT, file), "utf8"));
}

describe("#4961: admin pages that load data render AdminLoadError, never the empty state, on failure", () => {
  it("the site list is exactly the set of files importing the shared component", () => {
    const importers = walk(path.join(ROOT, "src"))
      .map((full) => path.relative(ROOT, full).split(path.sep).join("/"))
      .filter((file) => file !== "src/components/admin/admin-load-error.tsx")
      .filter((file) => code(file).includes(COMPONENT_SPECIFIER))
      .sort();
    expect(
      importers,
      "A file imports AdminLoadError but is not a SITE here (add it with its gate), or a SITE stopped importing it.",
    ).toEqual(SITES.map((site) => site.file).sort());
  });

  for (const site of SITES) {
    describe(site.file, () => {
      const source = code(site.file);

      it("imports and renders the shared component", () => {
        expect(source).toMatch(IMPORTS_COMPONENT);
        expect(source).toContain("<AdminLoadError");
      });

      for (const { gate, empty } of site.guards) {
        it(`checks \`${gate}\` before rendering \`${empty}\``, () => {
          const emptyAt = source.indexOf(empty);
          expect(emptyAt, `${site.file} no longer renders "${empty}"; update this census with the page`).toBeGreaterThan(-1);
          expect(source.indexOf(empty, emptyAt + 1), `"${empty}" must be unique in ${site.file}`).toBe(-1);
          const gateAt = source.lastIndexOf(gate, emptyAt);
          expect(gateAt, `${site.file} renders "${empty}" without first checking \`${gate}\``).toBeGreaterThan(-1);
          expect(
            emptyAt - gateAt,
            `\`${gate}\` sits ${emptyAt - gateAt} characters before "${empty}" in ${site.file}; it is no longer the branch guarding it`,
          ).toBeLessThanOrEqual(GATE_WINDOW);
        });
      }
    });
  }
});
