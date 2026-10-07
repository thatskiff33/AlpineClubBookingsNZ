import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
 * EVERY PAGE HAS A CLUB-FORMAT PROVIDER ABOVE IT (#3564, stage 2 of programme
 * #3205; INV-CONFIG-006).
 *
 * ## Why this file exists
 *
 * `useClubFormat()` THROWS when no `ClubFormatProvider` is above it. That is
 * the right choice — the alternative is a fallback to `NZD` / `en-NZ`, which
 * renders a plausible wrong currency on an officer's screen with nothing
 * anywhere failing, and that is the exact defect programme #3205 exists to end,
 * reintroduced one level down. But a throw is only SAFE while the mount is
 * guaranteed, and "guaranteed" written in a docblock is the kind of guarantee
 * that stops holding the first time somebody adds a route group. This is that
 * sentence, enforced.
 *
 * It is the club-time census's shape, deliberately, and it shares that
 * census's machinery rather than copying it —
 * `@/lib/__tests__/support/provider-mount-census` records why, and the
 * hazards those routines already handle (a `.jsx` page, a conditional mount, a
 * comment that satisfies a positive rule).
 *
 * It is a DISK-SCANNING census, so `vitest related` reaches it only through its
 * imports and not through any file it reads. Run it explicitly when you add a
 * route group, a layout, or a page outside one; CI catches it either way.
 *
 * ## What it checks
 *
 * 1. Both mount points really mount the provider.
 * 2. `app-providers.tsx` and `website-chrome.tsx` resolve the values from the
 *    PERSISTED reader, not from `process.env` and not from the browser.
 * 3. Every page under a `src/app/(group)` route group has, at or above its own
 *    directory, a layout that really WRAPS `{children}` in one of those two.
 * 4. Every surface OUTSIDE a route group is on one of two short, named lists:
 *    the ones with no provider at all, and the ones that mount their own.
 * 5. And each of those surfaces is CHECKED, not just named. A provider-less
 *    surface's import graph is walked and must reach NO caller of the hook. A
 *    self-mounting one's is walked THROUGH its mount and must reach at least
 *    one, so the mount is load-bearing rather than decorative.
 */

/** The components that mount the provider, and the source that must prove it. */
const MOUNT_POINTS = {
  AppProviders: "src/components/app-providers-client.tsx",
  WebsiteChrome: "src/components/website/website-chrome.tsx",
} as const;

/** The component names a layout must WRAP `{children}` in. */
const MOUNT_NAMES = Object.keys(MOUNT_POINTS);

/** Where `useClubFormat` is DEFINED, so its signature is not read as a call. */
const HOOK_DEFINITION = "src/components/club-format-provider.tsx";

/**
 * The walk's provider-specific inputs. A component that renders
 * `<ClubFormatProvider>` covers everything beneath it, so reaching one ENDS the
 * walk — a correct answer rather than a violation, detected from the source
 * rather than listed, so a new one needs no edit here.
 */
const CLUB_FORMAT_WALK = {
  mountTag: "<ClubFormatProvider",
  hookCall: /\buseClubFormat\s*\(/,
  hookDefinition: HOOK_DEFINITION,
} as const;

/**
 * Surfaces outside every mounting layout that mount the provider THEMSELVES,
 * and the file that resolves the values for them.
 *
 * A separate category from the list below, because the two make opposite
 * claims and want opposite checks. A provider-less surface claims nothing
 * beneath it reaches the hook, and its walk must come back EMPTY. A
 * self-mounting surface claims it supplies the provider itself, and the honest
 * check there is that something beneath it really does reach the hook — a
 * mount nothing needs is dead code wearing a green suite, and a walk that
 * stopped at the mount would inspect nothing while passing.
 */
const SELF_MOUNTING_SURFACES: Record<string, string> = {
  "src/app/display/page.tsx":
    "The lobby TV display. It has no layout and sits in no route group, so " +
    "neither chrome component is above it; this page resolves the club's " +
    "format on the server and mounts the provider around the screen itself. " +
    "Not a chrome mount because `/display` shares none of the application's " +
    "chrome and its sibling `error.tsx` is held at zero data dependencies on " +
    "purpose (issue #176, ADR-003 section 5), so no mount on this route could " +
    "ever cover all three of its surfaces. See the reasoning block in the page.",
  "src/app/not-found.tsx":
    "The root 404, which sits outside both public route groups and therefore " +
    "outside `WebsiteChrome`. It renders `EmbeddedPageContentParts` over " +
    "whatever an admin published at that path, and an embedded booking-request " +
    "form reads `useClubFormat()` in the browser since #3565 made the format a " +
    "required argument everywhere - exactly the case the old PROVIDERLESS row " +
    "said would turn it red. So the page resolves the club's format on the " +
    "server, inside the same guarded read as its content, and mounts the " +
    "provider around the embedded parts itself; the hardcoded fallback branch " +
    "renders no amount and needs none.",
};

/**
 * Surfaces that render with NO provider above them, and why each is allowed to.
 *
 * Every entry is a decision, not a backlog. A page that reaches
 * `useClubFormat()` from here is a thrown error on a live route, so adding a
 * row means having checked that nothing in its tree renders an amount or a
 * formatted number — and the import-graph walk below checks it for you rather
 * than taking the reason on trust.
 *
 * The list is the same six surfaces the club-time census reviews, which is not
 * a coincidence: both providers are mounted by the same two chrome components,
 * so the set of surfaces outside them is a property of the route tree rather
 * than of either provider. The REASONS differ, and one of them differs sharply.
 */
const PROVIDERLESS_SURFACES: Record<string, string> = {
  "src/app/(finance)/not-found.tsx":
    "The finance 404. `(finance)` has NO group-root layout — the only layout " +
    "in that group is `(finance)/finance/layout.tsx`, a segment deeper — so " +
    "this file renders under the root layout alone, with no provider. It is a " +
    "heading, a sentence and a link home: no amount, no number, no date.",
  "src/app/display/error.tsx":
    "The lobby display's own error boundary. It renders with ZERO data " +
    "dependencies on purpose (issue #176, ADR-003 section 5) — a branded dark " +
    "shell and nothing else — because an unattended wall screen must never be " +
    "able to throw from its own fallback. A club-format read here would be " +
    "precisely the dependency that stance forbids, and note that Next renders " +
    "an error boundary OUTSIDE the layout whose subtree threw, so the mount " +
    "`page.tsx` makes could not cover this file even if it wanted to.",
  "src/app/error.tsx":
    "The root error boundary. Next renders an error boundary OUTSIDE the " +
    "layout whose subtree threw, so no route group's provider is above it — " +
    "including for a page whose own layout mounts one. Nothing on it is " +
    "formatted, and an error page is the worst possible place for a throw, " +
    "since surviving is its entire job.",
  "src/app/global-error.tsx":
    "The global error boundary, which replaces the ROOT layout when that " +
    "layout itself throws. It renders its own `<html>` and `<body>` and has " +
    "nothing above it at all, so a provider here is not merely absent but " +
    "impossible without duplicating the server read into the failure path.",
};

describe("club-format provider mount census (#3564)", () => {
  it("both mount points really mount ClubFormatProvider", () => {
    for (const [name, file] of Object.entries(MOUNT_POINTS)) {
      const source = stripComments(read(file));
      expect(
        source.includes("<ClubFormatProvider"),
        `${name} (${file}) must render <ClubFormatProvider>: it is one of the ` +
          "two components every route group composes, and INV-CONFIG-006 says " +
          "the browser learns the club's currency and locale from the server " +
          "and nowhere else.",
      ).toBe(true);
    }
  });

  /**
   * The reader a mount point must use, and why the spelling moved at #3565.
   *
   * Stage 2 wrote `getClubFormat()` from `@/lib/club-format-settings`, because
   * stage 1 cached nothing and recorded that the caching contract belonged to
   * stage 3. Stage 3 chose it: React `cache()`, in `club-format-server.ts`.
   *
   * REQUIRING THE WRAPPED READER IS THE POINT, not tidiness. `cache()` memoises
   * per FUNCTION IDENTITY, so a mount point still calling the raw reader holds
   * its own memo entry and reads the one-row table a SECOND time in any render
   * pass where something below it renders an amount through `clubFormat()`.
   * That is a defect nothing else in the tree can see, and it is what this
   * assertion now holds closed. `club-format-server.ts` re-exports nothing and
   * invents nothing: `clubFormatValues()` is `getClubFormat()` wrapped, so the
   * persisted-not-environment property below is unchanged.
   */
  const PERSISTED_READER_IMPORT = 'from "@/lib/club-format-server"';

  it("the server half reads the PERSISTED setting, not the environment", () => {
    for (const file of [
      "src/components/app-providers.tsx",
      MOUNT_POINTS.WebsiteChrome,
    ]) {
      const source = stripComments(read(file));
      expect(
        source.includes(PERSISTED_READER_IMPORT),
        `${file} must resolve the club's format through ` +
          "@/lib/club-format-server, whose clubFormatValues() is the " +
          "request-scoped reader over ClubFormatSettings and consults the " +
          "environment only while nothing is persisted (INV-CONFIG-006). The " +
          "raw getClubFormat() is not interchangeable here: React cache() " +
          "memoises per function identity, so the raw call reads the row a " +
          "second time in a pass that also calls clubFormat() (#3565).",
      ).toBe(true);
      expect(
        /process\.env/.test(source),
        `${file} must not reach the environment for the club's currency or ` +
          "locale: NEXT_PUBLIC_* is inlined at BUILD time into an image that " +
          "serves every club, which is the defect #3205 exists to remove.",
      ).toBe(false);
    }
  });

  it("a self-mounting surface really mounts, from the persisted reader", () => {
    /*
      These sit outside both chrome components, so rule 2 above cannot see
      them — and `/display` is the surface where getting this wrong is least
      likely to be noticed, because nobody is standing in front of an
      unattended wall waiting for it to be wrong.
    */
    for (const surface of Object.keys(SELF_MOUNTING_SURFACES)) {
      const source = stripComments(read(surface));
      expect(
        source.includes("<ClubFormatProvider"),
        `${surface} is on SELF_MOUNTING_SURFACES, so it must render ` +
          "<ClubFormatProvider> itself. Nothing else covers it.",
      ).toBe(true);
      expect(
        source.includes(PERSISTED_READER_IMPORT),
        `${surface} must resolve the club's format through ` +
          "@/lib/club-format-server, on the server (INV-CONFIG-006) — see " +
          "PERSISTED_READER_IMPORT for why the raw reader is not interchangeable.",
      ).toBe(true);
      expect(
        /process\.env/.test(source),
        `${surface} must not read the environment for the club's currency or locale.`,
      ).toBe(false);
    }
  });

  it("every page in a route group has a mounting layout above it", () => {
    expect(pagesInRouteGroups().length).toBeGreaterThan(20);
    expect(mountingLayoutDirectories(MOUNT_NAMES).size).toBeGreaterThan(0);

    expect(
      pagesWithoutMountingLayout(MOUNT_NAMES),
      "Every page in a route group must render under a layout that wraps " +
        "{children} in AppProviders or WebsiteChrome. Without one, any client " +
        "component that renders the club's currency or a locale-formatted " +
        "number throws on that page (#3564).",
    ).toEqual([]);
  });

  it("the surfaces outside a route group are exactly the reviewed list", () => {
    expect(
      surfacesOutsideMountingLayouts(MOUNT_NAMES),
      "A surface outside every mounting layout has no ClubFormatProvider " +
        "above it. Add it to PROVIDERLESS_SURFACES with the reason nothing in " +
        "its tree needs the club's currency or locale, or mount one in its own " +
        "file and add it to SELF_MOUNTING_SURFACES - or give it a provider.",
    ).toEqual(
      [
        ...Object.keys(PROVIDERLESS_SURFACES),
        ...Object.keys(SELF_MOUNTING_SURFACES),
      ].sort(),
    );
  });

  /*
    THE ROW IS A CLAIM; THIS IS THE CHECK.

    Listing a surface records which pages lack a provider. It does not record
    whether that is SAFE, and the club-time census learned the difference the
    hard way: `/display` sat on its list with a reason that had quietly stopped
    being true, and the old census passed because the page was still on the list
    and still had no provider. Here the walk is doing real work from the first
    day, because `/display` genuinely does reach this hook.
  */
  describe("nothing under a providerless surface reaches useClubFormat()", () => {
    for (const [surface, reason] of Object.entries(PROVIDERLESS_SURFACES)) {
      it(`${surface} really does not need one`, () => {
        expect(
          existsSync(join(ROOT, surface)),
          `${surface} is on PROVIDERLESS_SURFACES but does not exist. Remove ` +
            "the row, or point it at wherever the surface moved to - a row for " +
            "a missing file makes this walk inspect nothing while still passing.",
        ).toBe(true);

        const { visited, consumers, boundaries, unresolved } = walkImports(
          surface,
          CLUB_FORMAT_WALK,
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
          `${surface} has NO ClubFormatProvider above it, and its recorded ` +
            `reason is:\n\n  ${reason}\n\n` +
            `That is no longer true - the ${visited.length} file(s) reached ` +
            "from it include the ones listed above, which call " +
            "useClubFormat(). That hook THROWS without a provider, so this " +
            "surface is now a thrown error on a live route. Either mount a " +
            "provider on it or take the format read back out. The worked " +
            "example is the lobby display, whose mount is in " +
            "src/app/display/page.tsx - the SERVER page, because that is " +
            "where the persisted setting can be read, and deliberately not " +
            "in display-screen.tsx, which is at its size budget. This walk " +
            `stopped at ${boundaries.length} file(s) that mount a provider ` +
            "of their own.",
        ).toEqual([]);
      });
    }

    /*
      AND EACH SELF-MOUNTING SURFACE'S MOUNT IS LOAD-BEARING. The opposite
      assertion to the ones above, and the reason the two are separate lists: a
      walk that stopped at the entry's own mount would report a boundary having
      inspected nothing, so it walks THROUGH and must find a real caller
      beneath. That is also what proves the consumer detection behind those
      clean results detects anything at all — several of the surfaces above
      import nothing but npm packages, so their empty lists say as much about
      the resolver as about the code.
    */
    for (const [surface, reason] of Object.entries(SELF_MOUNTING_SURFACES)) {
      it(`${surface} mounts a provider something below it needs`, () => {
        const { consumers, unresolved } = walkImports(surface, {
          ...CLUB_FORMAT_WALK,
          walkThroughEntry: true,
        });

        expect(unresolved).toEqual([]);
        expect(
          consumers,
          `${surface} mounts ClubFormatProvider, and its recorded reason is:` +
            `\n\n  ${reason}\n\nNothing beneath it calls useClubFormat() any ` +
            "more, so that mount is now dead weight on a live route. Remove " +
            "it and move the surface to PROVIDERLESS_SURFACES, or put the " +
            "read back.",
        ).not.toEqual([]);
      });
    }


    /*
      AND THE RESOLVER REACHES A WIDE FIRST-PARTY GRAPH. `/display` reaches a
      handful of files, so on its own it says little about the walk's reach.
      The root 404 is the widest tree outside the chrome components, and its
      consumer list is only worth anything if the walk really visited it. Since
      #3565 that page mounts a provider of its own, so the walk is told to go
      THROUGH the entry's mount rather than stop at it, exactly as the
      self-mounting check above does.
    */
    it("resolves a wide first-party graph", () => {
      const { visited, unresolved } = walkImports(
        "src/app/not-found.tsx",
        { ...CLUB_FORMAT_WALK, walkThroughEntry: true },
      );
      expect(unresolved).toEqual([]);
      expect(visited.length).toBeGreaterThan(20);
    });
  });
});
