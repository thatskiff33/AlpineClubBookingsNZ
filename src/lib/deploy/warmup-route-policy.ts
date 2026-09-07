/**
 * WHICH public addresses the pre-cutover warm-up gate asks for, and what the
 * BUILD says should happen when it does (#2566, owner decision Option 4).
 *
 * Deliberately pure: no filesystem, no Prisma, no `next/server`. The impure half
 * — reading the two build manifests off disk and the published CMS rows out of
 * the database — is `warmup-discovery.ts`, which hands its findings to
 * {@link buildWarmupPlan}. Everything a reviewer needs to check about the RULES is
 * therefore readable and testable without a build or a database.
 *
 * ## The three sources, and why nothing is inferred from a URL
 *
 * The owner's decision names three authoritative sources and nothing else:
 *
 *  1. the Next.js build output — `prerender-manifest.json` (what is stored) and
 *     `app-path-routes-manifest.json` (what routes exist at all);
 *  2. the published CMS page paths, from the database the target release itself
 *     reads;
 *  3. an EXPLICIT list of public routes that matter — {@link CRITICAL_PUBLIC_ROUTES}
 *     below, plus the club's configured Book Now target.
 *
 * The critical list is written out by hand on purpose ("Do not rely solely on
 * automatic inference"). Two things are NOT hand-maintained, and both exist so the
 * hand-written half cannot rot:
 *
 *  • **Each route's render mode.** The list DECLARES what it expects, the build
 *    MANIFEST says what is true, and {@link buildWarmupPlan} refuses the deploy when
 *    the two disagree. That disagreement is the interesting failure — it is how `/`
 *    silently becoming a stored page (or silently stopping being one, once #2352
 *    slice 2 lands) reaches an operator instead of production.
 *  • **Whether the list is COMPLETE.** Every literal entry of the repository's public
 *    route census must be declared, or the plan carries a blocking problem naming the
 *    address (see {@link CENSUS_FIXED_WEBSITE_ROUTES}). Without that, a release that
 *    gained a public page passed the gate having never requested it.
 *
 * ## The exclusion list is ONE predicate, not a deny list
 *
 * The owner's spec enumerates what must never be warmed: API routes, admin
 * routes, authenticated member routes, login and auth-callback routes, draft and
 * unpublished pages, external URLs, malformed paths, query-string variants,
 * duplicates, and anything not meant to be publicly cacheable. A hand-rolled
 * deny list for that would be a second, rotting copy of a classification this
 * repository already owns, so it is enforced in two layers instead:
 *
 *  • `isFixedNonceWebsitePath()` (`src/lib/public-website-paths.ts`) answers
 *    "is this an address one of the five approved public routes can serve?" — and
 *    it is FALSE for `/api/*`, the admin area, every authenticated member area,
 *    `/login` and the auth flows, `robots.txt`/`sitemap.xml`, asset shapes,
 *    `_next/*`, and the eight per-request public routes. That predicate is already
 *    held from both sides by `src/proxy.ts` and the CMS catch-all, so warming
 *    exactly its territory means the gate can never warm something the release
 *    does not intend to store.
 *  • {@link warmupPathRejection} covers the shapes that are not about ROUTING at
 *    all — an external or protocol-relative URL, a query-string variant, a
 *    traversal, a malformed encoding — because those must be refused before they
 *    are ever handed to an HTTP client, whatever the route table says.
 *
 * Drafts and unpublished pages are excluded at the source instead (the discovery
 * read filters `published`), which is the only place that can be authoritative
 * about them.
 */

import {
  FIXED_NONCE_WEBSITE_ROUTES,
  isFixedNonceWebsitePath,
} from "@/lib/public-website-paths";

/**
 * What the BUILD says happens when this address is requested.
 *
 *  • `isr` — generated on demand (or seeded at build with a revalidate) and
 *    STORED. The warm-up must prove the store worked, not merely that a 200 came
 *    back.
 *  • `prebuilt` — frozen at build time with no revalidation. There is no store to
 *    populate, so "warm" is meaningless and a cache-hit header is not required —
 *    and, since next sets one on any `isSSG` response, one is ACCEPTED rather than
 *    treated as a fault (`warmup-run.ts` → `warmOneRoute`). Nothing discovery
 *    produces classifies here today (`/sitemap.xml` and `/_global-error` are the
 *    only two, and neither is a page a visitor reads); it exists so #2352 slice 3
 *    has to state its intent rather than silently changing what the gate proves.
 *  • `render-only` — rendered per request. Warming it still buys the thing
 *    `DEPLOYMENT.md` → "App CPU sizing" measures — the first render of a route
 *    costs several CPU-seconds of engine re-warm — and it is a real smoke test of
 *    the release. What it cannot do is prove cache storage, because there is
 *    none, so the gate instead proves the ABSENCE of a cache header: a
 *    `render-only` route that starts reporting one has quietly begun storing a
 *    per-request page, which is the #2352 hazard in reverse.
 */
export type WarmupCacheClass = "isr" | "prebuilt" | "render-only";

/** No route in the target release claims this address at all. */
export type WarmupRouteClassification = WarmupCacheClass | "unrouted";

/** A route pattern the build declares as stored on demand, with its own regex. */
export interface IsrDynamicRoute {
  /** The route pattern, e.g. `/[...slug]`. */
  pattern: string;
  /**
   * The regex the BUILD emitted for that pattern (`routeRegex` in
   * `prerender-manifest.json`). Used rather than a hand-rolled segment matcher so
   * the gate matches paths the way the framework does; a dynamic route with no
   * usable regex is a discovery failure rather than a silent miss.
   */
  routeRegex: string;
}

/**
 * The target release's own record of its route table, read out of the build
 * output by `warmup-discovery.ts`.
 */
export interface RouteTableSnapshot {
  /**
   * Every app route pattern in the release, from the values of
   * `app-path-routes-manifest.json` — literal (`/join/apply`) and dynamic
   * (`/join/[code]`, `/[...slug]`) alike, pages and route handlers together.
   */
  appRoutePatterns: readonly string[];
  /**
   * `prerender-manifest.json` → `routes`: addresses with build-time HTML. Each
   * carries whether it revalidates, which is what separates a stored-and-
   * refreshing page from one frozen for the life of the release.
   */
  prebuiltRoutes: readonly { path: string; revalidates: boolean }[];
  /** `prerender-manifest.json` → `dynamicRoutes`: generated on demand, then stored. */
  isrDynamicRoutes: readonly IsrDynamicRoute[];
}

/** One hand-written critical route: the address, the intent, and the reason. */
export interface CriticalRouteDeclaration {
  path: string;
  /** What the build is expected to say about it. A mismatch blocks the deploy. */
  expected: WarmupCacheClass;
  /** Why this address is critical, in the operator's language. */
  why: string;
}

/**
 * The EXPLICIT, reviewable list of critical public routes (owner decision on
 * #2566: "Do not rely solely on automatic inference").
 *
 * A failure on any of these blocks cutover. Changing the list is a change to what
 * the club considers a primary public journey, so it is made here, in a diff, and
 * not derived from whatever happened to be in the route table that day.
 *
 * `expected` is checked against the build manifests on every run. All four are
 * `render-only` TODAY because #2352 slice 1 left them `force-dynamic` — only the
 * CMS catch-all is stored — and slice 2 is what turns `/` (and then the rest) into
 * stored pages. When it does, this list must be updated in the same PR: the gate
 * refuses to cut over while a declaration and the build disagree, in either
 * direction. That is deliberate. Silently accepting the drift is exactly how a
 * release that stopped storing `/` would ship unnoticed.
 *
 * ## What is NOT here, and why each absence is a decision
 *
 *  • **A public booking entry route.** The owner's list names one, and this
 *    deployment does not have one. Since #2430 the public Book Now button either
 *    points at a CMS content page (handled below — the configured target is
 *    promoted to critical at run time) or sends an anonymous visitor to the MEMBER
 *    login path (`buildBookingLoginPath()`); `/book` is authenticated. Login and
 *    auth routes are excluded from warming by the same decision, so when the
 *    button is on the default target there is genuinely nothing public to warm.
 *    The report says so in as many words rather than leaving a silent gap.
 *  • **The rest of the published CMS pages.** They are discovered and warmed, but
 *    as NON-CRITICAL routes under the tiered tolerance the owner set. Promoting
 *    them all to critical would replace that policy with "every CMS page is
 *    fatal", which the decision explicitly rejects.
 *  • **`/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]`, and the
 *    two form pages `/booking-requests` and `/school-bookings` with their token
 *    flows (`/booking-requests/respond/[token]`, `/booking-requests/verify/[token]`,
 *    `/school-bookings/confirm/[token]`).** Public pages, but per-request by design
 *    (a PIN-gated assignment, a group code, one-time tokens, and public forms an
 *    anonymous visitor types personal details into). All eight are `(website-dynamic)`
 *    routes outside `isFixedNonceWebsitePath()`, so {@link buildWarmupPlan} would
 *    refuse them anyway — and the two bare form pages are `(website-dynamic)`
 *    code routes with no stored `PageContent` to warm, so the CMS-page discovery
 *    below does not reach them either (#2818 decision 4).
 */
/**
 * The public-route CENSUS this list is cross-checked against.
 *
 * `FIXED_NONCE_WEBSITE_ROUTES` (`src/lib/public-website-paths.ts`) is the repository's
 * existing authoritative record of the approved `(website)` routes, held in place by
 * `scripts/ci/check-website-render-modes.mjs` — a new public page cannot ship without
 * being added to it. {@link buildWarmupPlan} therefore refuses to plan a run while any
 * LITERAL entry of that census has no declaration here.
 *
 * Why the check exists at all: the build manifests were only ever used to CLASSIFY the
 * addresses this list already names, never iterated over, so drift was caught in one
 * direction only. A declared route that disappeared from the release blocked the
 * deploy; a release that GAINED an eligible public page passed silently, was never
 * requested once, and reached its first real visitor unrendered. That is the whole
 * class of failure this gate exists to catch, and the owner's acceptance criterion 1
 * ("all eligible public routes are discovered from authoritative sources") rules it
 * out.
 *
 * The dynamic entry `/[...slug]` is skipped: it is a pattern, not an address, and its
 * addresses arrive from the published-CMS read instead.
 */
const CENSUS_FIXED_WEBSITE_ROUTES: readonly string[] =
  FIXED_NONCE_WEBSITE_ROUTES;

export const CRITICAL_PUBLIC_ROUTES: readonly CriticalRouteDeclaration[] = [
  {
    path: "/",
    expected: "render-only",
    why: "The home page — the address most first-time visitors land on.",
  },
  {
    path: "/join",
    expected: "render-only",
    why: "The membership information page: how someone joins the club.",
  },
  {
    path: "/join/apply",
    expected: "render-only",
    why: "The membership application form itself — the public join journey's entry point.",
  },
  {
    path: "/contact",
    expected: "render-only",
    why: "The contact page, and the only way a non-member reaches the club.",
  },
];

/** Where a planned route came from, for the operator-facing report. */
export type WarmupRouteSource =
  "critical-list" | "book-now-target" | "published-cms-page";

/** A route the gate will request, with everything needed to judge the answer. */
export interface PlannedWarmupRoute {
  path: string;
  /** `critical` blocks cutover on failure; `cms` is tolerated within the threshold. */
  tier: "critical" | "cms";
  cacheClass: WarmupCacheClass;
  source: WarmupRouteSource;
  why: string;
}

/** A path discovery deliberately did not warm, and the plain-English reason. */
export interface ExcludedWarmupPath {
  path: string;
  reason: string;
}

export interface WarmupPlan {
  routes: readonly PlannedWarmupRoute[];
  excluded: readonly ExcludedWarmupPath[];
  /**
   * Route-discovery failures. Any entry blocks cutover: the owner's decision
   * lists "route-discovery failure" among the critical failures, because a gate
   * that cannot enumerate what to warm cannot say anything about the release.
   */
  problems: readonly string[];
  /**
   * Discovery findings that do not block but must be PROMINENT — something
   * discovery could not establish, as against something it established to be wrong.
   * They are surfaced through the evaluation's warnings, not the quiet notes list,
   * because a gap in what was proved is not a footnote.
   */
  warnings: readonly string[];
  /** Non-blocking notes that belong in the report (e.g. no public booking entry). */
  notes: readonly string[];
}

/**
 * What the club's configured public booking entry turned out to be.
 *
 * Three states rather than `string | null`, because the third one used to be
 * indistinguishable from the first and the report then asserted the benign reading as
 * fact: `resolveBookNowChoice()` swallows a database error and fails open, so a failed
 * read of `PublicContentSettings` arrived here as "this club has no page target" and
 * the plan answered "Nothing public is missing" — about a critical public route it had
 * never looked at.
 *
 * Declared in this pure module rather than beside the resolver so the planner keeps its
 * "no Prisma, no server-only" property; `src/lib/book-now-config.ts` imports the type
 * from here.
 */
export type ConfiguredBookNowTarget =
  /** The button is hidden, or points at the member login path. Nothing to warm. */
  | { state: "none" }
  /** The admin chose a published content page, at this address. */
  | { state: "page"; path: string }
  /** The setting could not be read, so what to warm is UNKNOWN. */
  | { state: "unreadable"; detail: string };

export interface WarmupPlanInput {
  table: RouteTableSnapshot;
  /** Defaults to {@link CRITICAL_PUBLIC_ROUTES}; injectable for the tests. */
  criticalRoutes?: readonly CriticalRouteDeclaration[];
  /**
   * The public-route census the critical list is cross-checked against. Defaults to
   * {@link CENSUS_FIXED_WEBSITE_ROUTES}; injectable so the tests can prove the
   * cross-check fires in both directions.
   */
  fixedWebsiteRoutes?: readonly string[];
  /** Published, servable CMS page paths, as read from the database. */
  cmsPaths: readonly string[];
  /** The club's configured public booking entry, in all three of its states. */
  bookNowTarget: ConfiguredBookNowTarget;
}

/**
 * One trailing slash off and nothing else — in particular NO percent-decoding and
 * NO case folding.
 *
 * Both omissions mirror Next, and `src/lib/public-website-paths.ts` carries the
 * measurement: routes are matched against the RAW pathname, and matching is
 * case-sensitive. Decoding or lower-casing here would make the gate ask for an
 * address the release resolves differently from the one it meant to warm.
 */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Why this path must never be handed to the HTTP client, or null if it is safe.
 *
 * CMS paths are UNTRUSTED DATA (owner decision: "Do not use `eval`. Do not
 * concatenate unquoted CMS paths into shell commands. … Reject external URLs and
 * protocol-relative URLs. Reject path traversal or malformed encodings."). Two
 * layers make that true here: nothing in this feature ever reaches a shell — the
 * requests are made by `fetch` inside the target release, with the path as a
 * separate argument — and this function refuses the shapes that would be wrong
 * even so.
 *
 * The order of the checks is not arbitrary: the cheap structural refusals run
 * before the decode, so a path with a bad encoding is rejected as malformed
 * rather than throwing.
 */
export function warmupPathRejection(rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return "empty path";
  }

  // An absolute URL, a scheme-relative URL, or a protocol-relative `//host` —
  // every form that would take the request off this host.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath) || rawPath.startsWith("//")) {
    return "external or protocol-relative URL";
  }

  if (!rawPath.startsWith("/")) {
    return "not an absolute path";
  }

  if (rawPath.includes("?")) {
    return "query-string variant";
  }

  if (rawPath.includes("#")) {
    return "fragment variant";
  }

  // Whitespace, control characters and backslashes. A real CMS slug has none of
  // them (`isValidPageSlug()` refuses them on the admin write); a row that
  // somehow carries one is malformed, not something to normalise into shape.
  if (/[\s\\]/.test(rawPath) || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    return "malformed path (whitespace, backslash or control character)";
  }

  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "path traversal";
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return "malformed percent-encoding";
  }

  // An encoded separator or control character survives the raw checks above and
  // would change what the path MEANS to anything that decodes it.
  if (
    decoded !== rawPath &&
    // The slash count is the sharpest of these: a `%2F` inside a slug is a
    // segment boundary smuggled into a segment, and no legal CMS slug has one.
    (decoded.split("/").length !== rawPath.split("/").length ||
      /[\s\\]/.test(decoded) ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      decoded.split("/").some((segment) => segment === "." || segment === ".."))
  ) {
    return "malformed path once decoded";
  }

  return null;
}

/** Does a route pattern with dynamic segments claim this path? */
function dynamicPatternClaims(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").filter((s) => s.length > 0);
  const pathSegments = path.split("/").filter((s) => s.length > 0);

  for (const [index, segment] of patternSegments.entries()) {
    // `[[...rest]]` — optional catch-all: matches the remainder, empty included.
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      return index === patternSegments.length - 1;
    }

    // `[...rest]` — catch-all: matches one or more remaining segments.
    if (segment.startsWith("[...") && segment.endsWith("]")) {
      return (
        index === patternSegments.length - 1 && pathSegments.length > index
      );
    }

    if (index >= pathSegments.length) {
      return false;
    }

    if (segment.startsWith("[") && segment.endsWith("]")) {
      continue;
    }

    if (segment !== pathSegments[index]) {
      return false;
    }
  }

  return patternSegments.length === pathSegments.length;
}

/**
 * What the target release's OWN build output says about this address.
 *
 * Precedence mirrors Next's, which `src/lib/public-website-paths.ts` measured
 * rather than assumed: a literal route wins over any dynamic pattern, so
 * `/join/apply` is the static page and not the `/[...slug]` catch-all.
 *
 *  1. build-time HTML (`prerender-manifest.routes`) — `isr` when it revalidates,
 *     `prebuilt` when it does not;
 *  2. a LITERAL app route with no build-time HTML — `render-only`;
 *  3. a dynamic route the build stores on demand — `isr`, matched with the
 *     build's own `routeRegex`;
 *  4. any other dynamic app route — `render-only`;
 *  5. nothing claims it — `unrouted`.
 */
export function classifyWarmupRoute(
  path: string,
  table: RouteTableSnapshot,
): WarmupRouteClassification {
  const prebuilt = table.prebuiltRoutes.find((route) => route.path === path);
  if (prebuilt) {
    return prebuilt.revalidates ? "isr" : "prebuilt";
  }

  const literalPatterns = table.appRoutePatterns.filter(
    (pattern) => !pattern.includes("["),
  );
  if (literalPatterns.includes(path)) {
    return "render-only";
  }

  for (const route of table.isrDynamicRoutes) {
    if (new RegExp(route.routeRegex).test(path)) {
      return "isr";
    }
  }

  const dynamicPatterns = table.appRoutePatterns.filter((pattern) =>
    pattern.includes("["),
  );
  if (dynamicPatterns.some((pattern) => dynamicPatternClaims(pattern, path))) {
    return "render-only";
  }

  return "unrouted";
}

/**
 * Turns the three authoritative sources into the ordered list of addresses to
 * warm, plus the exclusions, the discovery failures and the operator notes.
 *
 * Critical routes come first in the returned order. That is not cosmetic: the
 * overall warm-up timeout is a real bound, and if it bites, the routes that
 * block cutover are the ones that must already have been attempted.
 */
export function buildWarmupPlan({
  table,
  criticalRoutes = CRITICAL_PUBLIC_ROUTES,
  fixedWebsiteRoutes = CENSUS_FIXED_WEBSITE_ROUTES,
  cmsPaths,
  bookNowTarget,
}: WarmupPlanInput): WarmupPlan {
  const routes: PlannedWarmupRoute[] = [];
  const excluded: ExcludedWarmupPath[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  const isrPatterns = table.isrDynamicRoutes.map((route) => route.pattern);

  // An unusable regex is BOTH recorded as a discovery failure and removed from the
  // table the classifier reads. Recording it alone would leave `classifyWarmupRoute`
  // to throw on it a few lines later, which the endpoint would report as "the gate
  // itself failed" — true, but three steps removed from the reason.
  const usableTable: RouteTableSnapshot = {
    ...table,
    isrDynamicRoutes: table.isrDynamicRoutes.filter((route) => {
      try {
        new RegExp(route.routeRegex);
        return true;
      } catch {
        problems.push(
          `The build output for stored route "${route.pattern}" carries an unusable route regex, so the gate cannot tell which addresses it claims.`,
        );
        return false;
      }
    }),
  };

  const add = (route: PlannedWarmupRoute) => {
    if (seen.has(route.path)) {
      return;
    }
    seen.add(route.path);
    routes.push(route);
  };

  for (const declaration of criticalRoutes) {
    const rejection = warmupPathRejection(declaration.path);
    if (rejection) {
      problems.push(
        `Critical route "${declaration.path}" is not a usable address (${rejection}). The critical-route list in src/lib/deploy/warmup-route-policy.ts is wrong.`,
      );
      continue;
    }

    const path = stripTrailingSlash(declaration.path);

    if (!isFixedNonceWebsitePath(path)) {
      problems.push(
        `Critical route "${path}" is not a public website address this release can serve, so it must not be warmed. Either the address or the critical-route list is wrong.`,
      );
      continue;
    }

    const actual = classifyWarmupRoute(path, usableTable);
    if (actual === "unrouted") {
      problems.push(
        `Critical route "${path}" is claimed by no route in this release's build output. The page has been removed or renamed, and the critical-route list has not followed.`,
      );
      continue;
    }

    if (actual !== declaration.expected) {
      problems.push(
        `Critical route "${path}" is declared "${declaration.expected}" but this release's build output says "${actual}". A public page silently starting or stopping being stored changes what the deploy proves; update the critical-route list in the same change that moved the route.`,
      );
      continue;
    }

    add({
      path,
      tier: "critical",
      cacheClass: actual,
      source: "critical-list",
      why: declaration.why,
    });
  }

  if (routes.length === 0) {
    problems.push(
      "No critical public route survived discovery, so the gate has nothing to prove before cutover.",
    );
  }

  // The census cross-check: every LITERAL approved public route must be declared
  // above, or the gate is enumerating less than the release serves. See
  // CENSUS_FIXED_WEBSITE_ROUTES for why this is a blocking problem rather than a note.
  const declaredCriticalPaths = new Set(
    criticalRoutes.map((declaration) => stripTrailingSlash(declaration.path)),
  );
  for (const censusRoute of fixedWebsiteRoutes) {
    if (censusRoute.includes("[")) {
      continue;
    }

    const path = stripTrailingSlash(censusRoute);
    if (declaredCriticalPaths.has(path)) {
      continue;
    }

    problems.push(
      `Public website route "${path}" is an approved public address of this release (FIXED_NONCE_WEBSITE_ROUTES in src/lib/public-website-paths.ts) but is not declared in CRITICAL_PUBLIC_ROUTES, so the gate would never request it and an unrendered page would reach the first real visitor. Add it to the critical-route list in src/lib/deploy/warmup-route-policy.ts with the render mode the build gives it.`,
    );
  }

  if (bookNowTarget.state === "unreadable") {
    // NOT the all-clear below. The owner's critical-route list names "any public
    // booking entry route", and this branch means the gate does not know whether
    // there is one — so it says that, prominently, instead of reporting a gap it
    // never looked into as "nothing public is missing".
    warnings.push(
      `This club's Book Now setting could not be read (${bookNowTarget.detail}), so the gate could not establish whether there is a public booking entry page to warm. If one is configured, it has NOT been rendered or proved stored by this run. The button itself is unaffected: its resolver fails open to the member booking flow.`,
    );
  } else if (bookNowTarget.state === "none") {
    notes.push(
      "No public booking entry route was warmed: this club's Book Now button is hidden or points at the member login path, which is excluded from warming. Nothing public is missing.",
    );
  } else {
    const bookNowPagePath = bookNowTarget.path;
    const rejection = warmupPathRejection(bookNowPagePath);
    const path = rejection
      ? bookNowPagePath
      : stripTrailingSlash(bookNowPagePath);
    const classification = rejection
      ? "unrouted"
      : classifyWarmupRoute(path, usableTable);

    if (
      rejection ||
      !isFixedNonceWebsitePath(path) ||
      classification !== "isr"
    ) {
      // The club's own configuration, not a defect in the release: the Book Now
      // resolver already falls back to the default booking flow for a target it
      // cannot serve (`src/lib/book-now-config.ts`, the #1929 fail-open
      // contract), so the button is not dead and the deploy is not at risk.
      excluded.push({
        path: bookNowPagePath,
        reason:
          "configured Book Now page target is not an address this release stores; the button falls back to the default booking flow",
      });
      notes.push(
        `The configured Book Now target ${bookNowPagePath} was not warmed because this release cannot serve it as a stored page. The button falls back to the member booking flow, so no visitor sees a dead link — but the target is worth correcting in Admin > Page Content.`,
      );
    } else {
      add({
        path,
        tier: "critical",
        cacheClass: "isr",
        source: "book-now-target",
        why: "The club's configured public booking entry: the page the Book Now button opens.",
      });
    }
  }

  for (const rawPath of cmsPaths) {
    const rejection = warmupPathRejection(rawPath);
    if (rejection) {
      excluded.push({ path: rawPath, reason: rejection });
      continue;
    }

    const path = stripTrailingSlash(rawPath);

    if (!isFixedNonceWebsitePath(path)) {
      excluded.push({
        path,
        reason: "not an address the public website serves as a content page",
      });
      continue;
    }

    if (seen.has(path)) {
      // Already planned as a critical route (the Book Now target is always a
      // published CMS page). Not an exclusion — the same address twice is what
      // the owner's "duplicate routes" rule refuses.
      continue;
    }

    const classification = classifyWarmupRoute(path, usableTable);
    if (classification !== "isr") {
      // Every published CMS page is served by the one stored catch-all. If the
      // build says otherwise, the catch-all has lost its ISR configuration —
      // which is the whole of #2352 slice 1 undone, and systemic rather than a
      // per-page problem.
      problems.push(
        `Published CMS page "${path}" is "${classification}" in this release's build output, not a stored page. The CMS catch-all (${isrPatterns.join(", ") || "none"}) is no longer configured for incremental static regeneration.`,
      );
      continue;
    }

    add({
      path,
      tier: "cms",
      cacheClass: "isr",
      source: "published-cms-page",
      why: "A published page an admin wrote in Page Content.",
    });
  }

  return { routes, excluded, problems, warnings, notes };
}
