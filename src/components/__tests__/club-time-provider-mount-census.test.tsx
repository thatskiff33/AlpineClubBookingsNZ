import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  mountingLayoutDirectories,
  pagesInRouteGroups,
  pagesWithoutMountingLayout,
  read,
  ROOT,
  surfacesOutsideMountingLayouts,
  walkImports,
} from "@/lib/__tests__/support/provider-mount-census";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

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
 * two support imports (`provider-mount-census`, `strip-comments`) and not
 * through any file it reads. Run it explicitly when you add a route group, a
 * layout, or a page outside one; CI catches it either way.
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
 * Every presence check here runs over `stripComments(source)`, the one shared
 * implementation in `src/lib/__tests__/support/strip-comments.ts`, whose first
 * caller had already met and documented this hazard: a POSITIVE rule ("this layout must render
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

/** The components that mount the provider, and the source that must prove it. */
const MOUNT_POINTS = {
  AppProviders: "src/components/app-providers-client.tsx",
  WebsiteChrome: "src/components/website/website-chrome.tsx",
} as const;

/** The component names a layout must WRAP `{children}` in. */
const MOUNT_NAMES = Object.keys(MOUNT_POINTS);

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
 * The walk's provider-specific inputs, handed to the shared machinery in
 * `@/lib/__tests__/support/provider-mount-census` (extracted by #3564, when a
 * second census needed the identical walk — see that module for why it is not
 * copied).
 *
 * A component that renders `<ClubTimeProvider>` covers everything beneath it,
 * so reaching one ENDS the walk: it is a correct answer rather than a
 * violation, and it is detected from the source rather than listed, so a new
 * one needs no edit here.
 */
const CLUB_TIME_WALK = {
  mountTag: "<ClubTimeProvider",
  hookCall: /\buseClubTime\s*\(/,
  hookDefinition: HOOK_DEFINITION,
} as const;

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
    expect(pagesInRouteGroups().length).toBeGreaterThan(20);
    expect(
      mountingLayoutDirectories(MOUNT_NAMES).size,
    ).toBeGreaterThan(0);

    expect(
      pagesWithoutMountingLayout(MOUNT_NAMES),
      "Every page in a route group must render under a layout that wraps " +
        "{children} in AppProviders or WebsiteChrome. Without one, any client " +
        "component that renders an instant or derives the club's today throws on " +
        "that page (CT-4, #2870).",
    ).toEqual([]);
  });

  it("the surfaces outside a route group are exactly the reviewed list", () => {
    expect(
      surfacesOutsideMountingLayouts(MOUNT_NAMES),
      "A surface outside every mounting layout has no ClubTimeProvider above " +
        "it. Add it to PROVIDERLESS_SURFACES with the reason nothing in its " +
        "tree needs the club's zone - or give it a provider.",
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
          existsSync(join(ROOT, surface)),
          `${surface} is on PROVIDERLESS_SURFACES but does not exist. Remove the ` +
            "row, or point it at wherever the surface moved to — a row for a " +
            "missing file makes this walk inspect nothing while still passing.",
        ).toBe(true);

        const { visited, consumers, boundaries, unresolved } = walkImports(
          surface,
          CLUB_TIME_WALK,
        );

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
        CLUB_TIME_WALK,
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
