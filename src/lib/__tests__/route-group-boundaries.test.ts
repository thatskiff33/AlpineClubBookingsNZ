import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROUTE_GROUP_BOUNDARIES,
  type RouteGroupKey,
} from "@/lib/route-group-boundaries";

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
 *   - a group without a recorded reason lacks its `loading.tsx`, a group WITH one
 *     has quietly gained it, or any `loading.tsx` anywhere skips the accessible
 *     `RouteLoading` shell.
 *
 * `test:related` cannot select this file — it reads `src/app` from disk and has no
 * import edge to the files it scans — so it runs in CI and through
 * `pnpm run test:named` (docs/TESTING.md).
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

/**
 * Route groups that have NO group-level `loading.tsx`, and why. Each one is a
 * place where a Suspense boundary above the pages would change what the server
 * answers, not just what the user sees while waiting: a `loading.tsx` starts the
 * response stream, and "starting the stream sends the response headers and fixes
 * the status code" (`node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/loading.md`, "Status codes"), so a page's own later
 * `notFound()` or `redirect()` becomes a 200 with a streamed fallback.
 *
 * An entry here is checked both ways: the group must not have the file, so an
 * exemption cannot outlive its reason unnoticed.
 */
const LOADING_EXEMPT: Partial<Record<RouteGroupKey, string>> = {
  lodge:
    "The lodge kiosk and roster fetch their own data on the client, so a group loading boundary never shows on a fresh load, and it would turn the roster layout's server redirect to the kiosk into a client-side one. The July 2026 hardening review (docs/reviews/2026-07-15-production-hardening.md, F36) says of loading skeletons: 'Lodge routes are client-fetched — do not add there.'",
  authenticated:
    "Member pages decide their own 404s after a database read — /notices/[id] answers an out-of-audience member with a hard 404 that e2e/member-notices.spec.ts asserts — and a group loading boundary would turn every one into a streamed 200. The member screens that are slow to load already carry their own loading.tsx (dashboard, bookings, book, booking detail, consent).",
  public:
    "The sign-in and recovery screens decide redirects in the page (/login, /login/verify, /login/enroll, /membership-cancellation/[token]); behind a group loading boundary each 307 becomes a 200 plus a client-side redirect on the most-travelled path in the app.",
  website:
    "Forbidden by scripts/ci/check-website-render-modes.mjs (#2352, #2434): a boundary above the CMS catch-all can commit a 200 before it decides a URL is a 404, making a missing page a soft 404 that ISR then stores.",
  websiteDynamic:
    "Forbidden by scripts/ci/check-website-render-modes.mjs (#2352, #2434), which bans render boundaries in both public-website groups; the token pages here decide their own 404s.",
};

type Entry = (typeof ROUTE_GROUP_BOUNDARIES)[RouteGroupKey];
const ENTRIES = Object.entries(ROUTE_GROUP_BOUNDARIES) as Array<
  [RouteGroupKey, Entry]
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

function source(relative: string): string {
  return readFileSync(path.join(APP_DIR, relative), "utf8");
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
      const text = source(file);

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
      const file = path.join(APP_DIR, boundaryDir, "loading.tsx");
      const reason = LOADING_EXEMPT[key];

      if (reason === undefined) {
        expect(existsSync(file), `${boundaryDir}/loading.tsx is missing`).toBe(
          true,
        );
      } else {
        expect(reason.length).toBeGreaterThan(40);
        expect(
          existsSync(file),
          `${boundaryDir}/loading.tsx exists but LOADING_EXEMPT says it must not: ${reason}`,
        ).toBe(false);
      }
    });
  });

  it("names only real groups in LOADING_EXEMPT", () => {
    for (const key of Object.keys(LOADING_EXEMPT)) {
      expect(Object.keys(ROUTE_GROUP_BOUNDARIES)).toContain(key);
    }
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
    expect(LOADING_EXEMPT.website).toContain("check-website-render-modes.mjs");
    expect(LOADING_EXEMPT.websiteDynamic).toContain(
      "check-website-render-modes.mjs",
    );
  });

  it("gives every loading.tsx in the app the accessible RouteLoading shell", () => {
    const loadingDirs = dirsHolding(".", "loading.tsx");
    expect(loadingDirs.length).toBeGreaterThan(0);

    const bare = loadingDirs.filter(
      (dir) =>
        !/import\s*\{\s*RouteLoading\s*\}\s*from\s*"@\/components\/route-loading"/.test(
          source(`${dir}/loading.tsx`),
        ),
    );
    expect(
      bare,
      "wrap the skeleton in <RouteLoading> so screen readers hear that the page is loading",
    ).toEqual([]);
  });
});
