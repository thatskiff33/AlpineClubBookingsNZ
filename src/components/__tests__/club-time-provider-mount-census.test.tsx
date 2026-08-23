import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * EVERY PAGE HAS A CLUB-TIME PROVIDER ABOVE IT (CT-4 group C, #2870; epic #2988;
 * INV-CONFIG-002).
 *
 * ## Why this file exists
 *
 * `useClubTime()` THROWS when no `ClubTimeProvider` is above it. That is the
 * right choice — the alternative is a fallback zone that renders a plausible
 * wrong hour with nothing anywhere failing — but it is only SAFE while the mount
 * is guaranteed. "Guaranteed" was a sentence in a docblock, which is the kind of
 * guarantee that stops holding the first time somebody adds a route group. This
 * is that sentence, enforced.
 *
 * It is a DISK-SCANNING census, so `vitest related` cannot reach it: there is no
 * import edge from any of the files it reads. Run it explicitly when you add a
 * route group, a layout, or a page outside one; CI catches it either way.
 *
 * ## What it checks
 *
 * 1. Both mount points really mount the provider — `app-providers-client.tsx`
 *    for the five authenticated/admin groups, `website/website-chrome.tsx` for
 *    the two public ones.
 * 2. `app-providers.tsx` resolves the zone from the PERSISTED reader
 *    (`@/lib/club-time/server`), not from `process.env` and not from the browser.
 * 3. Every `page.tsx` under a `src/app/(group)` route group has, at or above its
 *    own directory, a layout that composes one of those two mount points.
 * 4. Every page OUTSIDE a route group is on a short, named list of surfaces that
 *    have no provider, each with the reason it does not need one. A new one
 *    cannot appear silently.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "src", "app");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function walk(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...walk(full, match));
    } else if (match(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** The components that mount the provider, and the source that must prove it. */
const MOUNT_POINTS = {
  AppProviders: "src/components/app-providers-client.tsx",
  WebsiteChrome: "src/components/website/website-chrome.tsx",
} as const;

/**
 * Pages that render with NO provider, and why each is allowed to.
 *
 * Every entry is a decision, not a backlog. A page that reaches
 * `useClubTime()` from here is a thrown error on a live route, so adding a row
 * means having checked that nothing in its tree renders an instant or derives
 * the club's today.
 */
const PROVIDERLESS_SURFACES: Record<string, string> = {
  "src/app/display/page.tsx":
    "The lobby TV display. Its module components under " +
    "`src/components/lodge-display/**` render only CALENDAR DAYS, carried as " +
    "`yyyy-MM-dd` strings and formatted with no zone in the picture, so none of " +
    "them reaches `useClubTime()`. The screen's own shell " +
    "(`src/app/display/display-screen.tsx`) still reads `APP_TIME_ZONE` for its " +
    "clock and belongs to the page groups of this migration.",
  "src/app/not-found.tsx":
    "The root 404, which sits outside both public route groups and therefore " +
    "outside `WebsiteChrome`. It renders `EmbeddedPageContentParts` over " +
    "whatever an admin published at that path, and the one embedded widget that " +
    "needs a zone brings its own — see " +
    "`src/components/website/skifield-whakapapa-embed.tsx`.",
};

describe("club-time provider mount census (CT-4, #2870)", () => {
  it("both mount points really mount ClubTimeProvider", () => {
    for (const [name, file] of Object.entries(MOUNT_POINTS)) {
      const source = read(file);
      expect(
        source.includes("<ClubTimeProvider"),
        `${name} (${file}) must render <ClubTimeProvider>: it is one of the two ` +
          "components every route group composes, and INV-CONFIG-002 says the " +
          "browser learns the club's zone from the server and nowhere else.",
      ).toBe(true);
    }
  });

  it("the server half reads the PERSISTED zone, not the environment", () => {
    const source = read("src/components/app-providers.tsx");
    expect(
      source.includes('from "@/lib/club-time/server"'),
      "app-providers.tsx must resolve the zone through @/lib/club-time/server, " +
        "which reads ClubTimeSettings. INV-CONFIG-002.",
    ).toBe(true);
    expect(
      /APP_TIME_ZONE|process\.env|resolvedOptions/.test(source),
      "app-providers.tsx must not reach the environment or the viewer's clock " +
        "for the club's zone (INV-CONFIG-002).",
    ).toBe(false);

    const chrome = read(MOUNT_POINTS.WebsiteChrome);
    expect(
      chrome.includes('from "@/lib/club-time/server"'),
      "website-chrome.tsx must resolve the zone through @/lib/club-time/server.",
    ).toBe(true);
  });

  it("every page in a route group has a mounting layout above it", () => {
    const pages = walk(APP, (name) => name === "page.tsx").filter((file) =>
      path.relative(APP, file).startsWith("("),
    );
    expect(pages.length).toBeGreaterThan(20);

    // Directories whose layout.tsx composes a mount point.
    const mounting = new Set(
      walk(APP, (name) => name === "layout.tsx")
        .filter((file) => {
          const source = fs.readFileSync(file, "utf8");
          return Object.keys(MOUNT_POINTS).some((name) =>
            source.includes(`<${name}`),
          );
        })
        .map((file) => path.dirname(file)),
    );
    expect(mounting.size).toBeGreaterThan(0);

    const uncovered = pages.filter((page) => {
      let dir = path.dirname(page);
      while (dir.startsWith(APP)) {
        if (mounting.has(dir)) return false;
        dir = path.dirname(dir);
      }
      return true;
    });

    expect(
      uncovered.map((file) => path.relative(ROOT, file).split(path.sep).join("/")),
      "Every page in a route group must render under a layout that composes " +
        "AppProviders or WebsiteChrome. Without one, any client component that " +
        "renders an instant or derives the club's today throws on that page " +
        "(CT-4, #2870).",
    ).toEqual([]);
  });

  it("the pages outside a route group are exactly the reviewed list", () => {
    const outside = walk(APP, (name) => name === "page.tsx")
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => !path.relative(APP, path.join(ROOT, file)).startsWith("("))
      .concat(
        fs.existsSync(path.join(APP, "not-found.tsx"))
          ? ["src/app/not-found.tsx"]
          : [],
      )
      .sort();

    expect(
      outside,
      "A page outside every route group has no ClubTimeProvider above it. Add " +
        "it to PROVIDERLESS_SURFACES with the reason nothing in its tree needs " +
        "the club's zone — or give it a provider.",
    ).toEqual(Object.keys(PROVIDERLESS_SURFACES).sort());
  });
});
