import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "../../../scripts/ci/check-website-render-modes.mjs";

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
 * It is a DISK-SCANNING census, so `vitest related` reaches it only through its
 * one import (`stripComments`) and not through any file it reads. Run it
 * explicitly when you add a route group, a layout, or a page outside one; CI
 * catches it either way.
 *
 * ## What it checks
 *
 * 1. Both mount points really mount the provider — `app-providers-client.tsx`
 *    for the five authenticated/admin groups, `website/website-chrome.tsx` for
 *    the two public ones.
 * 2. `app-providers.tsx` resolves the zone from the PERSISTED reader
 *    (`@/lib/club-time/server`), not from `process.env` and not from the browser.
 * 3. Every page under a `src/app/(group)` route group has, at or above its own
 *    directory, a layout that really WRAPS `{children}` in one of those two mount
 *    points.
 * 4. Every surface OUTSIDE a route group is on a short, named list, each with the
 *    reason it has no provider. A new one cannot appear silently.
 * 5. **And each of those surfaces is checked, not just named.** The reason on
 *    every row is "nothing in this tree reaches `useClubTime()`", so the census
 *    walks the import graph and proves it, stopping at any component that mounts
 *    a provider of its own. Measured today: 97 files from `/display` with no
 *    consumer, 92 from the root 404 with none and THREE mount boundaries, and
 *    one file each from the four error/404 surfaces, which import nothing but
 *    packages. See below for why the list alone was not enough.
 *
 * ## Reading the source rather than matching it raw
 *
 * Every presence check here runs over `stripComments(source)`, shared with
 * `scripts/ci/check-website-render-modes.mjs`, which had already met and
 * documented this hazard: a POSITIVE rule ("this layout must render
 * `<AppProviders>`") is satisfied by a comment mentioning it, so an un-stripped
 * substring match passes on a layout with no provider anywhere. Measured on this
 * census before the strip was added.
 *
 * A LAYOUT ALSO HAS TO WRAP THE PAGE, not merely name the component. Rule 3
 * requires `{children}` to sit between the mount's opening and closing tags AND
 * to appear exactly once in the file. The second half is what catches a
 * CONDITIONAL mount — `cond ? <AppProviders>{children}</AppProviders> :
 * <>{children}</>`, which renders the page with no provider down one branch and
 * satisfies any check that only looks for the wrapped branch. Measured: that
 * shape passes the presence check alone and fails this one. All six mounting
 * layouts in this application render `{children}` exactly once today.
 *
 * These are still substring rules over text rather than an AST, so be precise
 * about what is left. A branch that renders something OTHER than the page
 * (`cond ? <AppProviders>{children}</AppProviders> : <SetupRedirect />`) passes,
 * and correctly — down that branch the page is not rendered at all, so there is
 * nothing to be missing a provider. A layout that passes the page through under
 * another name (`{props.children}`, `{cond ? children : null}`) fails, loudly and
 * wrongly, and the fix is to write `{children}`.
 */

const ROOT = process.cwd();
const APP = path.join(ROOT, "src", "app");
const SRC = path.join(ROOT, "src");

/** The Next.js file extensions a route or component may be written in. */
const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/** Imported for a side effect or a URL, never for a component. */
const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".woff",
  ".woff2",
]);

/**
 * A route file, in every extension Next.js accepts.
 *
 * NOT `name === "page.tsx"`. Next resolves `page.jsx` and `page.js` exactly as it
 * resolves `page.tsx`, and both were invisible to this census — a page added in
 * either would have had neither a mounting layout nor a row on the reviewed list,
 * and nothing here would have said so.
 */
function isRouteFile(name: string, base: string): boolean {
  return CODE_EXTENSIONS.some((extension) => name === `${base}${extension}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** A repository-relative posix path, which is what every message here prints. */
function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
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

/** Where `useClubTime` is DEFINED, so its own signature is not read as a call. */
const HOOK_DEFINITION = "src/components/club-time-provider.tsx";

/**
 * Surfaces that render with NO provider above them, and why each is allowed to.
 *
 * Every entry is a decision, not a backlog. A page that reaches `useClubTime()`
 * from here is a thrown error on a live route, so adding a row means having
 * checked that nothing in its tree renders an instant or derives the club's
 * today — and the import-graph walk below now checks it for you rather than
 * taking the reason on trust.
 */
const PROVIDERLESS_SURFACES: Record<string, string> = {
  "src/app/display/page.tsx":
    "The lobby TV display, and the one surface here that is providerless BY " +
    "DESIGN rather than because nothing in it needs a zone. Its module " +
    "components under `src/components/lodge-display/**` render only CALENDAR " +
    "DAYS, carried as `yyyy-MM-dd` strings and formatted with no zone in the " +
    "picture. The screen's own shell DOES need one — it renders a live clock " +
    "and two header stamps, which are real instants — and CT-4 group E gave it " +
    "one: `src/app/display/page.tsx` resolves `clubTimeZone()` on the server " +
    "and hands it to `display-screen.tsx` as a REQUIRED PROP, which " +
    "`display-header-clock.tsx` binds. So nothing under `/display` calls " +
    "`useClubTime()` and this row stays true — for a different reason than the " +
    "one it used to give, which was that the shell had not been migrated yet. " +
    "A prop rather than a provider because `/display` shares none of the " +
    "application's chrome and its sibling `error.tsx` is held at zero data " +
    "dependencies on purpose, so a provider mounted here would cover two of the " +
    "three `/display` surfaces and could not cover the third: Next renders an " +
    "error boundary outside the layout whose subtree threw. Keeping the hook " +
    "out is also what leaves this row — and therefore the walk below, which is " +
    "what protects the lobby television — doing any work at all. See the " +
    "reasoning block in `src/app/display/page.tsx`.",
  "src/app/not-found.tsx":
    "The root 404, which sits outside both public route groups and therefore " +
    "outside `WebsiteChrome`. It renders `EmbeddedPageContentParts` over " +
    "whatever an admin published at that path, and each embedded part that " +
    "needs a zone brings its own provider — `skifield-whakapapa-embed.tsx`, " +
    "`booking-requests/booking-request-form-embed.tsx` and " +
    "`school-bookings/school-booking-form-embed.tsx`, all three of which the " +
    "walk below treats as mount boundaries for that reason. The two form " +
    "wrappers were added by CT-4 group E and were NOT foresight: migrating the " +
    "forms onto `useClubTime()` reddened this very row, which is the walk doing " +
    "its job. Anything else published at `/404` renders no instant and derives " +
    "no club today.",
  "src/app/(finance)/not-found.tsx":
    "The finance 404. `(finance)` has NO group-root layout — the only layout in " +
    "that group is `(finance)/finance/layout.tsx`, a segment deeper — so this " +
    "file renders under the root layout alone, with no provider. Nothing " +
    "temporal is on it: it is a heading, a sentence and a link home.",
  "src/app/display/error.tsx":
    "The lobby display's own error boundary, and the surface this census found " +
    "the moment it started walking `error.tsx` files rather than only pages. It " +
    "renders with ZERO data dependencies on purpose (issue #176, ADR-003 §5) — a " +
    "branded dark shell and nothing else — because an unattended wall screen must " +
    "never be able to throw from its own fallback. A club-time read here would be " +
    "precisely the dependency that stance forbids.",
  "src/app/error.tsx":
    "The root error boundary. Next renders an error boundary OUTSIDE the layout " +
    "whose subtree threw, so no route group's provider is above it — including " +
    "for a page whose own layout mounts one. Nothing temporal is on it, and an " +
    "error page is the worst possible place for a throw, since surviving is its " +
    "entire job.",
  "src/app/global-error.tsx":
    "The global error boundary, which replaces the ROOT layout when that layout " +
    "itself throws. It renders its own `<html>` and `<body>` and has nothing " +
    "above it at all, so a provider here is not merely absent but impossible " +
    "without duplicating the server read into the failure path.",
};

/**
 * Files that mount their own provider and so END the walk.
 *
 * A component that renders `<ClubTimeProvider>` covers everything beneath it, so
 * reaching one is a correct answer rather than a violation. Detected from the
 * source rather than listed, so a new one needs no edit here.
 */
function mountsProviderItself(strippedSource: string): boolean {
  return strippedSource.includes("<ClubTimeProvider");
}

/**
 * Resolve one import specifier to a tracked file under `src/`, or `null`.
 *
 * Only `@/` and relative specifiers are followed: a bare specifier is a package,
 * and no package in this application renders a club-time component.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const extension of CODE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const extension of CODE_EXTENSIONS) {
      const candidate = path.join(base, `index${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  return null;
}

/** Every specifier a file imports, static and dynamic. */
function importSpecifiers(strippedSource: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(strippedSource)) !== null) found.push(match[1]);
  return found;
}

interface WalkResult {
  /** Files reached, as repository-relative posix paths. */
  visited: string[];
  /** Files that CALL `useClubTime()` and are not below a provider of their own. */
  consumers: string[];
  /** Files that mounted their own provider, so their subtree was not walked. */
  boundaries: string[];
  /**
   * First-party specifiers the resolver could not turn into a file, as
   * `importer -> specifier`.
   *
   * THIS IS THE ANTI-VACUITY, and it is the one that fits. "The walk reached
   * more than one file" would be the obvious check and is wrong here: three of
   * the five surfaces import nothing but packages, which is not a broken walk
   * but the strongest possible evidence that nothing below them needs a zone. A
   * resolver that quietly failed on `@/...` would instead report an empty
   * consumer list having inspected nothing, and that is what this catches.
   */
  unresolved: string[];
}

/**
 * Everything an entry file can reach, stopping at any file that mounts its own
 * `ClubTimeProvider`.
 *
 * The stop is the whole reason a plain "nothing in this tree names the hook"
 * scan would be wrong: `src/app/not-found.tsx` really does reach the Whakapapa
 * widget, which really does call `useClubTime()`, and that is correct because
 * `skifield-whakapapa-embed.tsx` wraps it in a provider of its own.
 */
function walkImports(entryRelative: string): WalkResult {
  const entry = path.join(ROOT, entryRelative);
  const seen = new Set<string>();
  const consumers: string[] = [];
  const boundaries: string[] = [];
  const unresolved: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const stripped = stripComments(fs.readFileSync(file, "utf8"));
    const asRelative = relative(file);

    if (mountsProviderItself(stripped)) {
      boundaries.push(asRelative);
      continue;
    }
    if (asRelative !== HOOK_DEFINITION && /\buseClubTime\s*\(/.test(stripped)) {
      consumers.push(asRelative);
    }

    for (const specifier of importSpecifiers(stripped)) {
      // A stylesheet or an image imported for its side effect carries no
      // components, so it is neither walked nor counted as a resolution failure.
      if (ASSET_EXTENSIONS.has(path.extname(specifier))) continue;

      const resolved = resolveImport(file, specifier);
      if (resolved === null) {
        if (specifier.startsWith("@/") || specifier.startsWith(".")) {
          unresolved.push(`${asRelative} -> ${specifier}`);
        }
        continue;
      }
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }

  return {
    visited: [...seen].map(relative).sort(),
    consumers: consumers.sort(),
    boundaries: boundaries.sort(),
    unresolved: unresolved.sort(),
  };
}

describe("club-time provider mount census (CT-4, #2870)", () => {
  it("both mount points really mount ClubTimeProvider", () => {
    for (const [name, file] of Object.entries(MOUNT_POINTS)) {
      const source = stripComments(read(file));
      expect(
        source.includes("<ClubTimeProvider"),
        `${name} (${file}) must render <ClubTimeProvider>: it is one of the two ` +
          "components every route group composes, and INV-CONFIG-002 says the " +
          "browser learns the club's zone from the server and nowhere else.",
      ).toBe(true);
    }
  });

  it("the server half reads the PERSISTED zone, not the environment", () => {
    const source = stripComments(read("src/components/app-providers.tsx"));
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

    const chrome = stripComments(read(MOUNT_POINTS.WebsiteChrome));
    expect(
      chrome.includes('from "@/lib/club-time/server"'),
      "website-chrome.tsx must resolve the zone through @/lib/club-time/server.",
    ).toBe(true);
  });

  it("every page in a route group has a mounting layout above it", () => {
    const pages = walk(APP, (name) => isRouteFile(name, "page")).filter((file) =>
      path.relative(APP, file).startsWith("("),
    );
    expect(pages.length).toBeGreaterThan(20);

    // Directories whose layout really WRAPS the page in a mount point.
    const mounting = new Set(
      walk(APP, (name) => isRouteFile(name, "layout"))
        .filter((file) => {
          const source = stripComments(fs.readFileSync(file, "utf8"));
          return Object.keys(MOUNT_POINTS).some((name) => {
            const opened = source.indexOf(`<${name}`);
            const closed = source.indexOf(`</${name}>`);
            if (opened === -1 || closed <= opened) return false;
            const wrapped = source.slice(opened, closed);
            // The page has to be INSIDE the mount, and rendered nowhere else:
            // a second `{children}` is the conditional-mount shape, where one
            // branch wraps the page and another renders it bare.
            return (
              wrapped.includes("{children}") &&
              source.split("{children}").length === 2
            );
          });
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
      uncovered.map(relative),
      "Every page in a route group must render under a layout that wraps " +
        "{children} in AppProviders or WebsiteChrome. Without one, any client " +
        "component that renders an instant or derives the club's today throws on " +
        "that page (CT-4, #2870).",
    ).toEqual([]);
  });

  it("the surfaces outside a route group are exactly the reviewed list", () => {
    /*
      PAGES, plus the three special files Next renders OUTSIDE every route
      group's layout. `not-found.tsx` and `error.tsx` at the app root, and
      `global-error.tsx`, are real rendered surfaces with no `page.tsx` of their
      own, so a walk that collected only pages could not see them — and one of
      them, `(finance)/not-found.tsx`, is inside a route group that has no
      group-root layout at all, so being in a group does not make it covered.
    */
    const outside = walk(APP, (name) => isRouteFile(name, "page"))
      .map(relative)
      .filter(
        (file) => !path.relative(APP, path.join(ROOT, file)).startsWith("("),
      )
      .concat(
        walk(APP, (name) => isRouteFile(name, "not-found") || isRouteFile(name, "error") || isRouteFile(name, "global-error"))
          .map(relative)
          .filter((file) => {
            // A not-found/error file IS covered when a mounting layout sits at
            // or above its own directory, which is why (admin), (authenticated)
            // and (lodge) do not appear on the reviewed list and (finance) does.
            let dir = path.dirname(path.join(ROOT, file));
            while (dir.startsWith(APP)) {
              for (const extension of CODE_EXTENSIONS) {
                const layout = path.join(dir, `layout${extension}`);
                if (fs.existsSync(layout)) {
                  const source = stripComments(fs.readFileSync(layout, "utf8"));
                  if (
                    Object.keys(MOUNT_POINTS).some((name) =>
                      source.includes(`<${name}`),
                    )
                  ) {
                    return false;
                  }
                }
              }
              dir = path.dirname(dir);
            }
            return true;
          }),
      )
      .sort();

    expect(
      outside,
      "A surface outside every mounting layout has no ClubTimeProvider above " +
        "it. Add it to PROVIDERLESS_SURFACES with the reason nothing in its " +
        "tree needs the club's zone — or give it a provider.",
    ).toEqual(Object.keys(PROVIDERLESS_SURFACES).sort());
  });

  /*
    THE ROW IS A CLAIM; THIS IS THE CHECK.

    Every reason on `PROVIDERLESS_SURFACES` says the same thing — "nothing in
    this tree reaches `useClubTime()`" — and until this test existed the census
    verified only WHICH pages lacked a provider, never that claim. `/display` is
    the case that makes the difference concrete: its shell renders a live clock
    and two header stamps off `APP_TIME_ZONE` and its own row says that shell
    belongs to a sibling group's migration. On the day that group converts it,
    the lobby television throws — and the old census passed, because the page was
    still on the list and still had no provider.
  */
  describe("nothing under a providerless surface reaches useClubTime()", () => {
    for (const [surface, reason] of Object.entries(PROVIDERLESS_SURFACES)) {
      it(`${surface} really does not need one`, () => {
        expect(
          fs.existsSync(path.join(ROOT, surface)),
          `${surface} is on PROVIDERLESS_SURFACES but does not exist. Remove the ` +
            "row, or point it at wherever the surface moved to — a row for a " +
            "missing file makes this walk inspect nothing while still passing.",
        ).toBe(true);

        const { visited, consumers, boundaries, unresolved } =
          walkImports(surface);

        expect(
          unresolved,
          `The import walk from ${surface} could not resolve the first-party ` +
            "specifiers above, so it stopped short of code it was meant to " +
            "inspect and the result below is not trustworthy. Teach " +
            "`resolveImport` about the shape, or fix the import.",
        ).toEqual([]);

        expect(
          consumers,
          `${surface} has NO ClubTimeProvider above it, and its recorded reason ` +
            `is that nothing in its tree needs one:\n\n  ${reason}\n\n` +
            `That is no longer true — the ${visited.length} file(s) reached from ` +
            "it include the ones listed above, which call useClubTime(). That " +
            "hook THROWS without a provider, so this surface is now a thrown " +
            "error on a live route. Either mount a provider on it (as " +
            "skifield-whakapapa-embed.tsx does for the root 404, which is why " +
            `this walk stopped at ${boundaries.length} boundary file(s)) or take ` +
            "the temporal read back out.",
        ).toEqual([]);
      });
    }

    /*
      AND THE WALK ITSELF WORKS. Three of the five surfaces above import nothing
      but npm packages, so their clean result says as much about the resolver as
      about the code. The root 404 is the case that exercises every part of the
      machinery at once: a wide first-party graph, at least one file that really
      does call `useClubTime()`, and a provider mount between them that is the
      reason the call is legitimate. If this stops holding, the five results above
      mean nothing.
    */
    it("resolves a wide graph, and stops at a component's own provider", () => {
      const { visited, boundaries, consumers } = walkImports(
        "src/app/not-found.tsx",
      );

      expect(visited.length).toBeGreaterThan(20);
      expect(boundaries).toContain(
        "src/components/website/skifield-whakapapa-embed.tsx",
      );
      expect(consumers).toEqual([]);

      // The widget BELOW that boundary is a real `useClubTime()` caller, so the
      // clean result above is the boundary working rather than the hook being
      // absent from the tree.
      expect(
        /\buseClubTime\s*\(/.test(
          read("src/components/website/skifield-whakapapa-widget.tsx"),
        ),
      ).toBe(true);
      expect(visited).not.toContain(
        "src/components/website/skifield-whakapapa-widget.tsx",
      );
    });
  });
});
