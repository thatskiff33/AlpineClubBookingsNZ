import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROUTE_GROUP_BOUNDARIES,
  type RouteGroupBoundary,
  type RouteGroupKey,
} from "@/lib/route-group-boundaries";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * EVERY ROUTE GROUP HAS AN ERROR BOUNDARY, IN THE RIGHT PLACE (#4467 item 1).
 *
 * Before #4467 there were two `error.tsx` files for 167 pages, so an error on any
 * admin page fell through to the root screen and took the admin layout with it.
 * This census is what stops the next route group from repeating that: it walks
 * `src/app` and fails when
 *
 *   - a route group exists that `ROUTE_GROUP_BOUNDARIES` does not list (or the
 *     table lists one that is gone);
 *   - a group's boundary directory is not inside its OUTERMOST layout, or does not
 *     cover every page in the group — the two things that make an `error.tsx`
 *     render with the group's chrome around it and catch all of its pages;
 *   - the `error.tsx` there is missing, is not the shared `RouteError`, names a
 *     different group, or wires Next's `reset` instead of `retry`;
 *   - a group without a `loadingExemptReason` lacks its `loading.tsx`, a group
 *     WITH one has quietly gained one (anywhere in the group, unless the reason
 *     is marked root-only), or any `loading.tsx` anywhere skips the accessible
 *     `RouteLoading` shell.
 *
 * `test:related` cannot select this file — it reads `src/app` from disk and has no
 * import edge to the files it scans — so it runs in CI and through
 * `pnpm run test:named` (docs/TESTING.md).
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

// Widened to the declared shape so the optional loading answers read as
// `string | undefined` on every entry rather than only on the ones that set them.
const ENTRIES = Object.entries(ROUTE_GROUP_BOUNDARIES) as Array<
  [RouteGroupKey, RouteGroupBoundary]
>;

function routeGroupsOnDisk(): string[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\(.+\)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Every directory under `dir` (inclusive) holding a file named `leaf`, relative to src/app. */
function dirsHolding(dir: string, leaf: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    const entries = readdirSync(abs, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === leaf)) {
      out.push(path.relative(APP_DIR, abs).split(path.sep).join("/"));
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "__tests__") {
        walk(path.join(abs, entry.name));
      }
    }
  };
  walk(path.join(APP_DIR, dir));
  return out;
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * A file's CODE, comments blanked. Every match below is about what the file
 * does, so a commented-out import or a docblock mentioning `reset` must neither
 * satisfy nor trip it.
 */
function code(relative: string): string {
  return stripComments(readFileSync(path.join(APP_DIR, relative), "utf8"));
}

describe("route-group boundaries census (#4467)", () => {
  it("finds the route groups it is meant to police", () => {
    // Floor: a broken walk must not pass every assertion below by finding nothing.
    expect(routeGroupsOnDisk().length).toBeGreaterThanOrEqual(7);
  });

  it("lists every route group on disk, and nothing that is not on disk", () => {
    const listed = ENTRIES.map(([, entry]) => entry.group).sort();
    expect(
      listed,
      "Add the new group to ROUTE_GROUP_BOUNDARIES (src/lib/route-group-boundaries.ts), give it an error.tsx, and decide its loading.tsx here.",
    ).toEqual(routeGroupsOnDisk());
  });

  describe.each(ENTRIES)("%s", (key, entry) => {
    const { group, boundaryDir } = entry;

    it("sits inside the group's outermost layout and covers every page in it", () => {
      expect(isWithin(boundaryDir, group)).toBe(true);
      expect(
        existsSync(path.join(APP_DIR, boundaryDir, "layout.tsx")),
        `${boundaryDir} has no layout.tsx, so its error.tsx would render without the group's chrome`,
      ).toBe(true);

      const layouts = dirsHolding(group, "layout.tsx");
      const above = layouts.filter(
        (dir) => isWithin(boundaryDir, dir) && dir !== boundaryDir,
      );
      expect(
        above,
        `a layout sits above ${boundaryDir}; the boundary belongs next to the outermost one`,
      ).toEqual([]);

      const pages = dirsHolding(group, "page.tsx");
      expect(pages.length).toBeGreaterThan(0);
      expect(
        pages.filter((dir) => !isWithin(dir, boundaryDir)),
        `pages outside ${boundaryDir} would fall through to the root error screen`,
      ).toEqual([]);
    });

    it("has the shared error boundary, naming this group and wired to retry", () => {
      const file = `${boundaryDir}/error.tsx`;
      expect(existsSync(path.join(APP_DIR, file)), `${file} is missing`).toBe(
        true,
      );
      const text = code(file);

      expect(text.trimStart().startsWith('"use client";')).toBe(true);
      expect(text).toMatch(
        /import\s*\{\s*RouteError\s*\}\s*from\s*"@\/components\/route-error"/,
      );
      expect(text).toContain(`area="${key}"`);
      expect(text).toMatch(/retry=\{retry\}/);
      // `reset` re-renders the payload the client already holds; for a Server
      // Component error that is the same failure, so it must not be the wiring.
      expect(text).not.toMatch(/\breset\b/);
    });

    it("has no second error.tsx above the boundary, outside the group's layout", () => {
      const stray = dirsHolding(group, "error.tsx").filter(
        (dir) => isWithin(boundaryDir, dir) && dir !== boundaryDir,
      );
      expect(stray).toEqual([]);
    });

    it("has a loading.tsx, or a recorded reason not to and no such file", () => {
      const reason = entry.loadingExemptReason;
      const atBoundary = path.join(APP_DIR, boundaryDir, "loading.tsx");

      if (reason === undefined) {
        expect(
          existsSync(atBoundary),
          `${boundaryDir}/loading.tsx is missing; add it, or record loadingExemptReason in ROUTE_GROUP_BOUNDARIES`,
        ).toBe(true);
        return;
      }

      expect(reason.length).toBeGreaterThan(40);
      // A reason about the whole group (prefetch fan-out, client-fetched
      // screens, a gate that bans boundaries) is broken by a loading.tsx in ANY
      // folder of it. Only a root-only exemption lets pages keep their own.
      const offending = entry.loadingExemptAtRootOnly
        ? existsSync(atBoundary)
          ? [boundaryDir]
          : []
        : dirsHolding(group, "loading.tsx");
      expect(
        offending,
        `loading.tsx found where ROUTE_GROUP_BOUNDARIES.${key}.loadingExemptReason says there must be none: ${reason}`,
      ).toEqual([]);
    });
  });

  it("rests the public-website exemptions on a ban that still exists", () => {
    // If the website render-mode gate ever stops forbidding loading.tsx, these
    // two exemptions have lost their stated reason and must be decided again.
    const gate = readFileSync(
      path.join(process.cwd(), "scripts", "ci", "check-website-render-modes.mjs"),
      "utf8",
    );
    const forbidden = gate.match(
      /const FORBIDDEN_SEGMENT_FILES = new Set\(\[([^\]]*)\]\)/,
    );
    expect(forbidden?.[1]).toContain('"loading.tsx"');
    for (const key of ["website", "websiteDynamic"] as const) {
      const entry: RouteGroupBoundary = ROUTE_GROUP_BOUNDARIES[key];
      expect(entry.loadingExemptReason).toContain(
        "check-website-render-modes.mjs",
      );
    }
  });

  it("gives every loading.tsx in the app the accessible RouteLoading shell", () => {
    const loadingDirs = dirsHolding(".", "loading.tsx");
    expect(loadingDirs.length).toBeGreaterThan(0);

    const bare = loadingDirs.filter(
      (dir) =>
        !/import\s*\{\s*RouteLoading\s*\}\s*from\s*"@\/components\/route-loading"/.test(
          code(`${dir}/loading.tsx`),
        ),
    );
    expect(
      bare,
      "wrap the skeleton in <RouteLoading> so screen readers hear that the page is loading",
    ).toEqual([]);
  });
});
