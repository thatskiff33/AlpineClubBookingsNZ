import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Guards the public website's STRUCTURE: its two route groups, their render modes,
 * their route censuses, and the shared chrome both of them compose (issue #2352,
 * owner decision D1 and the 3 Aug 2026 narrowing).
 *
 * ## Why this needs a guard at all
 *
 * `(website)/layout.tsx` used to call `auth()` and `headers()`. Those two lines
 * forced EVERY route in the group to be rendered from scratch on every visit — a
 * production build prerendered zero pages — and removing them is the whole of
 * #2352 slice 1. But they also made the group's render modes uniform by accident,
 * and with them gone each route's mode is a deliberate, load-bearing choice that
 * nothing else in the repo notices when it changes:
 *
 *  • A fixed route that stops being per-request is PRERENDERED AT BUILD, where
 *    there is no database (`Dockerfile` points `DATABASE_URL` at an unreachable
 *    host) and no request and therefore no CSP nonce. The nonce half is caught by
 *    `check-prerendered-script-nonces.mjs` — after a full build. The database half
 *    is not caught at all: it silently freezes an empty page.
 *  • A DYNAMIC-SEGMENT route that stops being per-request is generated on demand
 *    and then STORED. `join/[code]` and `join/verify/[token]` carry a group code
 *    and a one-time token, so a stored copy is a page that skips its own re-check.
 *  • The CMS catch-all going the other way — losing its ISR config — is a silent
 *    return to the cost slice 1 removed, with no failing test anywhere.
 *
 * The 3 Aug narrowing added a second class of silent change, and it is a security
 * one. The fixed per-release CSP nonce now covers exactly five approved addresses;
 * everything else on the site mints one per request. Which group a page file sits
 * in is what decides that, and a route group is invisible in a URL — so a new page
 * dropped into `(website)` would be handed the weaker fixed nonce with nothing
 * anywhere failing, and a page moved out of `(website-dynamic)` would lose the
 * per-request one the same way.
 *
 * ## What it checks
 *
 * 1. **Render modes.** Every `page.tsx` under `src/app/(website)` either declares
 *    `export const dynamic = "force-dynamic"` or is the CMS catch-all; the
 *    catch-all declares `generateStaticParams` returning an empty array plus an
 *    `export const revalidate`, and does NOT declare `force-dynamic`. Every
 *    `page.tsx` under `src/app/(website-dynamic)` declares `force-dynamic`, its
 *    layout declares it for the whole group, and NOTHING there declares
 *    `generateStaticParams` or `revalidate` — that group's whole point is that none
 *    of it is ever stored.
 * 2. **Route censuses.** Each group's set of routes equals the corresponding list
 *    in `src/lib/public-website-paths.ts`
 *    (`FIXED_NONCE_WEBSITE_ROUTES` / `PER_REQUEST_WEBSITE_ROUTES`). That file is the
 *    single source of truth — `src/proxy.ts` derives the runtime nonce decision from
 *    the second list — so this check is what makes adding a public page a deliberate
 *    decision about the CSP rather than a file drop.
 * 3. **The nonce source of each layout.** `(website)/layout.tsx` must take the fixed
 *    per-release value and must not read the request; `(website-dynamic)/layout.tsx`
 *    must read the per-request value out of the CSP nonce header and must not touch
 *    the fixed one. This is the split itself, asserted rather than assumed.
 * 4. **Chrome parity.** Both layouts must compose the ONE shared chrome component
 *    and no chrome of their own, so the two groups cannot drift apart visually. The
 *    owner's direction for the split was explicit: no duplicated markup.
 * 5. **The shared chrome itself.** It must read NOTHING from the request and must
 *    resolve NEITHER nonce: the value arrives as a prop, which is the only reason
 *    two groups can differ while sharing one component. This is coverage this gate
 *    never had rather than coverage carried across the extraction: nothing here
 *    banned `auth()` or `headers()` in the public layout before the narrowing, only
 *    `check-website-prerender-manifest.mjs` after a full build. What the extraction
 *    changed is the stakes — one request read in the shared chrome opts BOTH groups
 *    out at once — so the ban was written alongside the move.
 * 6. **No render boundaries.** No `loading.tsx`, `template.tsx` or `default.tsx`
 *    anywhere under either group, and no Partial Prerendering flag on any of their
 *    routes. This is the enforceable form of the #2434 streaming-boundary warning:
 *    any of those introduces a boundary that can commit a 200 status before the
 *    catch-all page's own `notFound()` decision is made, which would turn a missing
 *    CMS page into a soft 404 — and under ISR, would then store it.
 *
 * Source-only by design: it reads files and never needs a build or a database, so
 * it fails in seconds rather than twenty minutes into CI.
 */

const FIXED_NONCE_GROUP = path.join("src", "app", "(website)");
const PER_REQUEST_GROUP = path.join("src", "app", "(website-dynamic)");
const CENSUS_FILE = path.join("src", "lib", "public-website-paths.ts");

/** The shared chrome component, and where both layouts must get it from. */
const CHROME_COMPONENT = "WebsiteChrome";
const CHROME_MODULE = "@/components/website/website-chrome";
const CHROME_FILE = path.join(
  "src",
  "components",
  "website",
  "website-chrome.tsx",
);

/** The CMS catch-all, relative to the fixed-nonce group root, in posix form. */
const CATCH_ALL = "[...slug]/page.tsx";

/** Segment files that introduce a boundary above the page. See check 5. */
const FORBIDDEN_SEGMENT_FILES = new Set([
  "loading.tsx",
  "template.tsx",
  "default.tsx",
]);

/**
 * Partial Prerendering, in either the per-route or the config form. PPR splits a
 * route into a prerendered shell plus a streamed hole, which is precisely the
 * boundary check 5 exists to keep out — and the prerendered shell would carry no
 * nonce.
 */
const PPR_PATTERN = /export\s+const\s+experimental_ppr\b/;

const FORCE_DYNAMIC_PATTERN =
  /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;

/**
 * `export function generateStaticParams(...): <any return type> { return []; }`.
 *
 * The bounded `[\s\S]{0,80}?` after the opening brace is what keeps this an
 * assertion about an EMPTY list rather than about the identifier being present: a
 * body that computed paths would not match, and neither would one that returned a
 * literal with entries in it. The signature is matched with `[^\n]*` so a return
 * type containing braces (`: { slug: string[] }[]`) is allowed.
 */
const GENERATE_STATIC_PARAMS_EMPTY_PATTERN =
  /export\s+function\s+generateStaticParams\b[^\n]*\{[\s\S]{0,80}?return\s*\[\s*\]\s*;?\s*\}/;

const GENERATE_STATIC_PARAMS_PATTERN = /\bgenerateStaticParams\b/;
const REVALIDATE_PATTERN = /export\s+const\s+revalidate\s*=\s*\d+/;

/**
 * Chrome components a layout could plausibly render directly, and which must
 * therefore come from the shared component instead.
 *
 * Not an exhaustive list of every component in the repo, and it does not need to
 * be: check 4 also requires each layout to RENDER the shared chrome, and the two
 * layouts' sets are compared with each other. This list is what turns "you copied
 * the header back in" into a named failure rather than a set-inequality puzzle.
 */
const CHROME_COMPONENTS = [
  "WebsiteHeader",
  "WebsiteFooter",
  "SiteBanners",
  "AnalyticsConsent",
  "HelpWidgetPublic",
  "AppProviders",
  "ThemeSwitcher",
];

/** Request reads that opt a route out of static rendering. */
const REQUEST_READ_PATTERNS = [
  { name: "headers()", pattern: /\bheaders\s*\(\s*\)/ },
  { name: "cookies()", pattern: /\bcookies\s*\(\s*\)/ },
  { name: "auth()", pattern: /\bauth\s*\(\s*\)/ },
];

/**
 * The source with its comments removed, which every check below runs against.
 *
 * Both directions need it. A NEGATIVE rule ("nothing in this group may mention
 * `generateStaticParams`") fires on the docblock that explains why the rule exists —
 * `join/[code]/page.tsx` says in prose that a dynamic segment without one would be
 * stored, and that sentence is the reason for the rule, not a breach of it. A
 * POSITIVE rule ("this layout must render `<WebsiteChrome>`") would in turn be
 * satisfied by a comment mentioning it, which is a check that can pass on a file
 * that does nothing.
 *
 * A SINGLE LEFT-TO-RIGHT PASS, not a pair of regular expressions, and the
 * difference is a measured defect rather than tidiness. This used to strip block
 * comments first and then line comments, with `//` left alone after a colon so a
 * `https://…` inside a string survived. That ordering means a `/*` written inside
 * a LINE comment opens a block comment which the regex then closes at the next
 * block-comment terminator anywhere below — and `src/app/(admin)/layout.tsx`
 * contains exactly that:
 * a `// … /admin/* … ` comment on line 32 and a JSX comment ending on line 123.
 * Stripping it removed 4,739 of its 6,290 characters, including the
 * `<AppProviders>` it exists to prove. The scan below never met that shape
 * because it reads only the two public route groups; the club-time census reads
 * the whole of `src/app`, which is how it surfaced.
 *
 * The pass tracks four states — code, line comment, block comment, and inside a
 * `'`, `"` or backtick string, honouring backslash escapes — so a comment
 * delimiter inside a string or inside the other kind of comment is left alone by
 * construction rather than by a lookbehind. It is still not a parser: a regular
 * expression LITERAL is treated as code, so `/…//…/` could confuse it. That shape
 * does not occur in this repository, and it cannot be written by accident,
 * because an unescaped `/` ends a regex.
 *
 * EXPORTED because the same hazard turned up again in a different census:
 * `src/components/__tests__/club-time-provider-mount-census.test.tsx` asserts
 * that a layout really renders `<AppProviders>` or `<WebsiteChrome>`, and a raw
 * substring match on the un-stripped file was measured passing on a layout that
 * only MENTIONS one in a comment. That is the positive-rule failure described
 * above, so both readers share the one implementation rather than each keeping a
 * copy of the heuristic and its caveats.
 */
export function stripComments(source) {
  let out = "";
  let index = 0;
  // "code" | "line" | "block" | a quote character we are inside.
  let mode = "code";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      // Newlines are kept so a stripped file still has its line structure.
      if (char === "\n") out += char;
      index += 1;
      continue;
    }

    if (mode === "'" || mode === '"' || mode === "`") {
      out += char;
      if (char === "\\") {
        out += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === mode) mode = "code";
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      mode = "line";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block";
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      mode = char;
      out += char;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Every file under `directory`, as paths relative to it, in posix form. */
function collectFiles(directory, root, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(absolute, root, found);
      continue;
    }
    if (entry.isFile()) {
      found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }

  return found;
}

/**
 * The URL a `page.tsx` serves, from its group-relative path.
 *
 * Nested route groups and private folders are transparent to the URL, so they are
 * dropped; every other directory is a real segment. `page.tsx` at the group root
 * is `/`.
 */
function routePatternForPage(file) {
  const segments = file
    .split("/")
    .slice(0, -1)
    .filter(
      (segment) =>
        !(segment.startsWith("(") && segment.endsWith(")")) &&
        !segment.startsWith("_"),
    );

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * One census array out of `src/lib/public-website-paths.ts`, or null when the
 * declaration cannot be found or is empty.
 *
 * Read out of the source rather than imported because this gate is plain ESM and
 * must run without a TypeScript loader or a build. A null return is reported as a
 * failure by the caller, never treated as an empty list — a check that silently
 * compares against nothing is worse than no check at all.
 */
function extractCensus(source, name) {
  const block = source.match(
    new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`),
  );

  if (!block) return null;

  const routes = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  return routes.length > 0 ? routes : null;
}

function reportCensusDifference(problems, label, actual, expected, censusName) {
  for (const route of actual.filter((entry) => !expected.includes(entry))) {
    problems.push(
      `${label} serves ${route}, which is not in ${censusName} (${CENSUS_FILE}). ` +
        "Which group a page sits in decides whether it carries the FIXED per-release " +
        "CSP nonce or a freshly minted per-request one (#2352 D1), and a route group is " +
        "invisible in a URL — so this has to be a deliberate amendment to that list, " +
        "not a file drop. If the placement is right, add the route there with its reason.",
    );
  }

  for (const route of expected.filter((entry) => !actual.includes(entry))) {
    problems.push(
      `${censusName} (${CENSUS_FILE}) lists ${route}, but ${label} does not serve it. ` +
        "The runtime nonce decision is derived from that list, so a stale entry either " +
        "hands the fixed nonce to an address that no longer exists or withholds it from " +
        "one that does. Remove the entry, or restore the route.",
    );
  }
}

function auditGroupBoundaries(problems, label, files) {
  for (const [file, source] of files) {
    const basename = file.split("/").pop();

    if (FORBIDDEN_SEGMENT_FILES.has(basename)) {
      problems.push(
        `${label}/${file} introduces a render boundary above the page. Not allowed on ` +
          "the public website (#2352, #2434): a boundary can commit a 200 before the " +
          "CMS catch-all decides a URL is a 404, which would make a missing page a " +
          "soft 404 and — under ISR — store it.",
      );
    }

    if (PPR_PATTERN.test(source)) {
      problems.push(
        `${label}/${file} enables Partial Prerendering. Not allowed on the public ` +
          "website (#2352): PPR prerenders a shell at build time, which has no request " +
          "and therefore no CSP nonce, and streams the rest behind exactly the boundary " +
          "this check keeps out.",
      );
    }
  }
}

/**
 * The pure half, so the rules are unit-testable without a checkout.
 *
 * `fixedNonceFiles` and `perRequestFiles` are maps of group-relative posix path ->
 * file contents; `censusSource` is the text of `src/lib/public-website-paths.ts`;
 * `chromeSource` is the text of the shared chrome component. Returns a list of
 * plain-English problems; an empty list is a pass.
 */
export function auditPublicWebsiteStructure({
  fixedNonceFiles: rawFixedNonceFiles,
  perRequestFiles: rawPerRequestFiles,
  censusSource,
  chromeSource,
}) {
  const problems = [];
  const stripAll = (files) =>
    new Map([...files].map(([file, source]) => [file, stripComments(source)]));
  const fixedNonceFiles = stripAll(rawFixedNonceFiles);
  const perRequestFiles = stripAll(rawPerRequestFiles);

  const fixedPages = [...fixedNonceFiles.keys()].filter((file) =>
    file.endsWith("page.tsx"),
  );
  const perRequestPages = [...perRequestFiles.keys()].filter((file) =>
    file.endsWith("page.tsx"),
  );

  // A scan that finds nothing must fail rather than pass: a renamed route group
  // would otherwise sail through with a green tick and zero files inspected. Both
  // are checked before anything else, and nothing else runs if either is empty —
  // every rule below would otherwise report a second, misleading problem.
  if (fixedPages.length === 0) {
    problems.push(
      "No page.tsx found under src/app/(website). Either the route group moved or " +
        "this check is looking in the wrong place — it must not pass on an empty scan.",
    );
  }

  if (perRequestPages.length === 0) {
    problems.push(
      "No page.tsx found under src/app/(website-dynamic). That group holds the public " +
        "pages that must keep a PER-REQUEST CSP nonce (#2352, owner decision 3 Aug " +
        "2026); an empty scan means either the group moved or those pages have been " +
        "folded back into (website), where they would silently be served the fixed " +
        "per-release nonce.",
    );
  }

  if (problems.length > 0) {
    return problems;
  }

  if (!fixedNonceFiles.has(CATCH_ALL)) {
    problems.push(
      `The CMS catch-all (${CATCH_ALL}) is missing from src/app/(website). #2352 slice 1 ` +
        "makes it the one route served from full-route ISR; if it moved, this check has " +
        "to move with it.",
    );
  }

  auditGroupBoundaries(problems, "(website)", fixedNonceFiles);
  auditGroupBoundaries(problems, "(website-dynamic)", perRequestFiles);

  // ---- Render modes: the fixed-nonce group ---------------------------------
  for (const file of fixedPages) {
    const source = fixedNonceFiles.get(file);

    if (file === CATCH_ALL) {
      if (FORCE_DYNAMIC_PATTERN.test(source)) {
        problems.push(
          `(website)/${file} declares force-dynamic. That is the one route on the public ` +
            "website that must NOT: it is the admin-authored CMS page cache, and " +
            "per-request rendering is the cost #2352 slice 1 removed.",
        );
      }
      if (!GENERATE_STATIC_PARAMS_EMPTY_PATTERN.test(source)) {
        problems.push(
          `(website)/${file} must export a generateStaticParams() that returns an empty ` +
            "array. Returning paths would prerender them at build, where there is no " +
            "database and no CSP nonce (#2352).",
        );
      }
      if (!REVALIDATE_PATTERN.test(source)) {
        problems.push(
          `(website)/${file} must export a numeric \`revalidate\` — the freshness backstop ` +
            "the owner set at 300 seconds (#2352 D3).",
        );
      }
      continue;
    }

    if (!FORCE_DYNAMIC_PATTERN.test(source)) {
      problems.push(
        `(website)/${file} must declare \`export const dynamic = "force-dynamic"\`. Since ` +
          "#2352 the shared chrome no longer reads the request, so a route that does not " +
          "say this is prerendered at build (no database, no CSP nonce) or, if it has a " +
          "dynamic segment, generated on demand and then STORED.",
      );
    }
  }

  // ---- Render modes: the per-request group ---------------------------------
  const perRequestLayout = perRequestFiles.get("layout.tsx");

  if (!perRequestLayout) {
    problems.push(
      "src/app/(website-dynamic)/layout.tsx is missing. Without its own layout the group " +
        "is not a separate nonce territory at all — its routes would inherit whatever " +
        "layout does wrap them.",
    );
  } else if (!FORCE_DYNAMIC_PATTERN.test(perRequestLayout)) {
    problems.push(
      '(website-dynamic)/layout.tsx must declare `export const dynamic = "force-dynamic"` ' +
        "for the whole group, so a page added later is per-request by default rather than " +
        "by remembering. Nothing in this group may ever be stored: it holds a PIN-gated " +
        "per-assignment page, four token-bearing screens, a group-code page, and two " +
        "public forms an anonymous visitor types personal details into.",
    );
  }

  for (const file of perRequestPages) {
    if (!FORCE_DYNAMIC_PATTERN.test(perRequestFiles.get(file))) {
      problems.push(
        `(website-dynamic)/${file} must declare \`export const dynamic = "force-dynamic"\` ` +
          "as well as the group layout. Each of these routes is per-request for a " +
          "permanent reason of its own, and the reason belongs next to the route.",
      );
    }
  }

  for (const [file, source] of perRequestFiles) {
    if (GENERATE_STATIC_PARAMS_PATTERN.test(source)) {
      problems.push(
        `(website-dynamic)/${file} mentions generateStaticParams. Nothing in this group ` +
          "may be prerendered or stored — a group code, a one-time token and a PIN-gated " +
          "assignment page are all per-visitor — and these routes carry a PER-REQUEST CSP " +
          "nonce, so a stored copy could never match a later response's policy either.",
      );
    }
    if (REVALIDATE_PATTERN.test(source)) {
      problems.push(
        `(website-dynamic)/${file} exports \`revalidate\`. That configures the full-route ` +
          "store, and nothing in this group may be stored (see above).",
      );
    }
  }

  // ---- Route censuses -----------------------------------------------------
  const fixedCensus = extractCensus(censusSource, "FIXED_NONCE_WEBSITE_ROUTES");
  const perRequestCensus = extractCensus(
    censusSource,
    "PER_REQUEST_WEBSITE_ROUTES",
  );

  if (!fixedCensus || !perRequestCensus) {
    problems.push(
      "Could not read FIXED_NONCE_WEBSITE_ROUTES and PER_REQUEST_WEBSITE_ROUTES out of " +
        `${CENSUS_FILE}. Both must stay exported \`as const\` string arrays: this gate ` +
        "compares them with the real route tree, and a declaration it cannot find would " +
        "otherwise make the census check pass against nothing.",
    );
  } else {
    reportCensusDifference(
      problems,
      "src/app/(website)",
      fixedPages.map(routePatternForPage),
      fixedCensus,
      "FIXED_NONCE_WEBSITE_ROUTES",
    );
    reportCensusDifference(
      problems,
      "src/app/(website-dynamic)",
      perRequestPages.map(routePatternForPage),
      perRequestCensus,
      "PER_REQUEST_WEBSITE_ROUTES",
    );
  }

  // ---- Each layout's nonce source, and chrome parity -----------------------
  const fixedLayout = fixedNonceFiles.get("layout.tsx");

  if (!fixedLayout) {
    problems.push(
      "src/app/(website)/layout.tsx is missing. It is what hands the five approved " +
        "routes the fixed per-release CSP nonce.",
    );
  } else {
    if (!fixedLayout.includes("getPublicWebsiteNonce")) {
      problems.push(
        "(website)/layout.tsx must take its CSP nonce from getPublicWebsiteNonce() — the " +
          "ONE fixed value of this release. A stored CMS page can carry only one nonce, " +
          "and every later response has to keep naming it (#2352 D1).",
      );
    }
    if (fixedLayout.includes("CSP_NONCE_HEADER")) {
      problems.push(
        "(website)/layout.tsx reads the per-request CSP nonce header. That is the read " +
          "whose removal is the whole of #2352 slice 1: it opts the group out of static " +
          "rendering, so the CMS pages stop being stored, and the only symptom is the CPU " +
          "bill. The per-request nonce belongs in (website-dynamic)/layout.tsx.",
      );
    }
    for (const { name, pattern } of REQUEST_READ_PATTERNS) {
      if (pattern.test(fixedLayout)) {
        problems.push(
          `(website)/layout.tsx calls ${name}. Any request read here opts every one of the ` +
            "five approved routes out of static rendering (#2352 slice 1) — including the " +
            "CMS catch-all, which then stops being stored at all.",
        );
      }
    }
  }

  if (perRequestLayout) {
    if (!perRequestLayout.includes("CSP_NONCE_HEADER")) {
      problems.push(
        "(website-dynamic)/layout.tsx must read the per-request CSP nonce from " +
          "CSP_NONCE_HEADER. That is the entire reason this group exists: the owner " +
          "narrowed the fixed per-release nonce back to the five approved routes on " +
          "3 Aug 2026, and every route in this group gets the same freshly minted " +
          "nonce every member and admin page gets.",
      );
    }
    if (perRequestLayout.includes("getPublicWebsiteNonce")) {
      problems.push(
        "(website-dynamic)/layout.tsx reaches for getPublicWebsiteNonce(). That is the " +
          "fixed per-release value, and handing it to this group is exactly the " +
          "widening the owner reversed on 3 Aug 2026 — it costs them the unguessable-nonce " +
          "defence and buys nothing, because none of them is ever stored.",
      );
    }
  }

  const chromeUse = [];

  for (const [label, source] of [
    ["(website)/layout.tsx", fixedLayout],
    ["(website-dynamic)/layout.tsx", perRequestLayout],
  ]) {
    if (!source) continue;

    if (!source.includes(`from "${CHROME_MODULE}"`)) {
      problems.push(
        `${label} must import ${CHROME_COMPONENT} from "${CHROME_MODULE}". Both public ` +
          "layouts compose the ONE shared chrome so the two groups cannot drift apart — " +
          "the owner's direction for the split was explicit: no duplicated markup.",
      );
    }

    if (!source.includes(`<${CHROME_COMPONENT}`)) {
      problems.push(
        `${label} must render <${CHROME_COMPONENT}>. A layout that stops composing it is ` +
          "a second copy of the header, footer, banners, help widget and pre-setup " +
          "holding screen waiting to drift.",
      );
    }

    const rendered = CHROME_COMPONENTS.filter((component) =>
      source.includes(`<${component}`),
    ).sort();

    chromeUse.push([label, rendered]);

    for (const component of rendered) {
      problems.push(
        `${label} renders <${component}> directly. Public chrome lives in ` +
          `${CHROME_COMPONENT} (${CHROME_MODULE}) so both groups get the same thing; a ` +
          "layout that renders its own is the duplication the split was designed to avoid.",
      );
    }
  }

  if (
    chromeUse.length === 2 &&
    chromeUse[0][1].join("|") !== chromeUse[1][1].join("|")
  ) {
    problems.push(
      `The two public layouts compose different chrome: ${chromeUse[0][0]} renders ` +
        `[${chromeUse[0][1].join(", ")}] and ${chromeUse[1][0]} renders ` +
        `[${chromeUse[1][1].join(", ")}]. They must be identical — the only permitted ` +
        "difference between them is where the CSP nonce comes from.",
    );
  }

  // ---- The shared chrome itself -------------------------------------------
  //
  // New coverage, not preserved coverage. Before the 3 Aug narrowing no source-level
  // check banned a request read in the public layout at all — the request-read
  // patterns below arrived with this block — so the only backstop was
  // `check-website-prerender-manifest.mjs`, twenty minutes into CI and only after a
  // full build. What the extraction changed is the blast radius: a `headers()` call
  // here would opt every route in BOTH groups out of static rendering, the exact
  // regression slice 1 exists to prevent, and the only symptom would be the CPU bill.
  if (chromeSource === undefined || chromeSource === null) {
    problems.push(
      `The shared chrome (${CHROME_FILE}) is missing. Both public layouts compose it; ` +
        "without it there is no single definition of the public chrome and nothing for " +
        "this gate to check.",
    );
  } else {
    const chrome = stripComments(chromeSource);

    for (const { name, pattern } of REQUEST_READ_PATTERNS) {
      if (pattern.test(chrome)) {
        problems.push(
          `${CHROME_FILE} calls ${name}. The shared chrome is rendered by BOTH public ` +
            "layouts, so a request read here opts every public route out of static " +
            "rendering at once — including the CMS catch-all, which then stops being " +
            "stored (#2352 slice 1). Whatever the value is for, it has to arrive as a " +
            "prop from the layout that is allowed to read the request.",
        );
      }
    }

    for (const [token, why] of [
      [
        "getPublicWebsiteNonce",
        "the FIXED per-release value, which would reach every per-request public page " +
          "through the shared component and undo the owner's 3 Aug 2026 narrowing",
      ],
      [
        "CSP_NONCE_HEADER",
        "the PER-REQUEST value, and reading it here is a request read that would stop " +
          "the CMS pages being stored at all",
      ],
    ]) {
      if (chrome.includes(token)) {
        problems.push(
          `${CHROME_FILE} resolves its own CSP nonce via ${token}. It must take the nonce ` +
            `as a PROP: that is ${why}. The nonce prop is the whole of the D1 split — one ` +
            "component, two layouts, two nonce sources.",
        );
      }
    }

    if (!/nonce=\{nonce\}/.test(chrome)) {
      problems.push(
        `${CHROME_FILE} must pass its \`nonce\` prop straight through to the analytics ` +
          "<Script> (`nonce={nonce}`). Dropping it ships an unnonced inline script under " +
          "a nonce-only policy, so the analytics script is refused on every public page — " +
          "silently, because nothing else on the page depends on it.",
      );
    }
  }

  return problems;
}

export function checkWorkingTree(repoRoot) {
  const readGroup = (relativeGroup) => {
    const groupRoot = path.join(repoRoot, relativeGroup);

    if (!fs.existsSync(groupRoot)) {
      throw new Error(
        `No route group at ${relativeGroup}. This check cannot pass without inspecting it.`,
      );
    }

    return new Map(
      collectFiles(groupRoot, groupRoot)
        // Tests colocated under a group are not routes.
        .filter((file) => !file.includes("__tests__/"))
        .map((file) => [
          file,
          fs.readFileSync(path.join(groupRoot, file), "utf8"),
        ]),
    );
  };

  const censusPath = path.join(repoRoot, CENSUS_FILE);

  if (!fs.existsSync(censusPath)) {
    throw new Error(
      `No ${CENSUS_FILE}. That file holds both route censuses and the runtime nonce ` +
        "predicate; without it there is nothing to check the route tree against.",
    );
  }

  const fixedNonceFiles = readGroup(FIXED_NONCE_GROUP);
  const perRequestFiles = readGroup(PER_REQUEST_GROUP);
  const chromePath = path.join(repoRoot, CHROME_FILE);

  return {
    fileCount: fixedNonceFiles.size + perRequestFiles.size,
    problems: auditPublicWebsiteStructure({
      fixedNonceFiles,
      perRequestFiles,
      censusSource: fs.readFileSync(censusPath, "utf8"),
      // Read as `undefined` rather than throwing, so a missing chrome file is
      // reported in the same plain-English list as everything else.
      chromeSource: fs.existsSync(chromePath)
        ? fs.readFileSync(chromePath, "utf8")
        : undefined,
    }),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { fileCount, problems } = checkWorkingTree(process.cwd());

    if (problems.length > 0) {
      console.error("The public website's structure is wrong (#2352):");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        `Public website structure check passed: ${fileCount} file(s) across ` +
          "src/app/(website) and src/app/(website-dynamic).",
      );
    }
  } catch (error) {
    console.error(`Public website structure check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
