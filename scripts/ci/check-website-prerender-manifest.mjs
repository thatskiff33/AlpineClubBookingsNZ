import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Asserts the BUILD's own record of what is cached and what is not (issue #2352
 * slice 1).
 *
 * ## Why the source-level check is not enough
 *
 * `scripts/ci/check-website-render-modes.mjs` reads the route files and so
 * catches a missing `force-dynamic` or a `generateStaticParams` that stopped
 * returning an empty list. It cannot catch the thing that actually decides the
 * outcome: whether Next agreed. A component anywhere in the `(website)` tree that
 * calls `auth()`, `cookies()` or `headers()` opts the CMS catch-all out of static
 * rendering SILENTLY — the build succeeds, every test passes, the pages look
 * right, and the only symptom is that the CPU cost #2352 removed has come back.
 * That is the regression this file exists to fail on, and the prerender manifest
 * is the one place the answer is written down.
 *
 * It is also the second half of the promise: a route that starts being
 * prerendered at BUILD time has no request and therefore no CSP nonce, so its
 * inline scripts are blocked by our own nonce-only policy (#2356). The
 * `routes` allowlist below is what stops a new one appearing unnoticed.
 * `check-prerendered-script-nonces.mjs` covers the same class from the other
 * direction — the emitted HTML — and the two together mean neither a new
 * prerendered route nor a nonce-less script can arrive quietly.
 *
 * **BOTH halves of the manifest are closed lists**, and that symmetry arrived in
 * the slice-1 review. `dynamicRoutes` used to be checked only against the routes
 * that must stay per-request (`MUST_STAY_DYNAMIC`), so a manifest listing a NEW stored route
 * passed — which is the more dangerous direction, because a stored route is one
 * visitor's render handed to the next. `routes` is the build-time half,
 * `dynamicRoutes` the on-demand half, and each names exactly what is allowed.
 *
 * Verified against a real `docker build --target builder` of this branch: the
 * manifest listed `dynamicRoutes: ["/[...slug]"]` and
 * `routes: ["/_global-error", "/sitemap.xml"]`, and the build's own route table
 * marked `/[...slug]` `●  (SSG)` with every other app route `ƒ  (Dynamic)`.
 */

const DIST_DIR = ".next";
const MANIFEST_FILE = "prerender-manifest.json";

/**
 * The ONE route served from the full-route (ISR) cache: the admin-authored CMS
 * pages. `generateStaticParams()` returns `[]`, so nothing is prerendered at
 * build; each path is generated on its first request and stored.
 */
const ISR_DYNAMIC_ROUTE = "/[...slug]";

/**
 * Public-website routes that must stay per-request, and why each one is not simply
 * "not done yet":
 *  • `/`, `/join`, `/contact`, `/join/apply` — the `(website)` group, held for
 *    #2352 slices 2 and 3, which first have to answer how a BUILD-time render
 *    acquires the per-release nonce (reconciliation F2);
 *  • `/hut-leader-instructions` — per-assignment and PIN-gated;
 *  • `/join/[code]`, `/join/verify/[token]` — a group code and a one-time token
 *    in the URL; a stored copy is a page that skips its own re-check;
 *  • `/booking-requests`, `/school-bookings` and their token flows
 *    (`/booking-requests/respond/[token]`, `/booking-requests/verify/[token]`,
 *    `/school-bookings/confirm/[token]`) — moved to `(website-dynamic)` in #2818
 *    (decision 2): public forms an anonymous visitor types personal details into,
 *    plus the one-time emailed confirmation links.
 *
 * All but the first four sit in the `(website-dynamic)` group and are per-request
 * for a SECOND reason too: they carry a nonce minted for the request, so a stored
 * copy could never match a later response's policy either. Both halves are checked
 * here. The generic on-demand loop below already fails closed on any of them (only
 * `/[...slug]` is an allowed on-demand route), so listing them here does not change
 * whether the gate catches a regression — it makes the SPECIFIC token/PIN reason
 * fire, and keeps this census honest against the route tree.
 */
const MUST_STAY_DYNAMIC = [
  "/",
  "/join",
  "/contact",
  "/join/apply",
  "/hut-leader-instructions",
  "/join/[code]",
  "/join/verify/[token]",
  "/booking-requests",
  "/booking-requests/respond/[token]",
  "/booking-requests/verify/[token]",
  "/school-bookings",
  "/school-bookings/confirm/[token]",
];

/**
 * Routes allowed to be prerendered AT BUILD TIME, as a closed list.
 *
 * Both are deliberate and neither is a page a visitor navigates to:
 *  • `/sitemap.xml` — generated synchronously with no database read (#1985), and
 *    XML, so it carries no inline script for a nonce to be missing from;
 *  • `/_global-error` — Next's own built-in error shell, which it prerenders
 *    itself. It is the documented exception in
 *    `check-prerendered-script-nonces.mjs`, and nothing in this repository
 *    controls how it is emitted.
 *
 * Anything else appearing here is a route that was quietly frozen at build time,
 * where there is no database (`Dockerfile` points `DATABASE_URL` at an
 * unreachable host) and no request and therefore no CSP nonce.
 */
const ALLOWED_BUILD_TIME_ROUTES = new Set(["/_global-error", "/sitemap.xml"]);

/**
 * Routes allowed to be generated ON DEMAND and then STORED, as a closed list.
 *
 * The slice-1 review found this half was not closed: `dynamicRoutes` was only
 * checked against the names in {@link MUST_STAY_DYNAMIC}, so a manifest
 * listing `/pay/[token]` or `/blog/[slug]` alongside `/[...slug]` produced zero
 * problems. That is short of the criterion #2352 recorded ("a future PR cannot
 * silently re-dynamise a route OR make a new one static") and it left the exact
 * class this file's header calls the hazard uncovered: a route generated on demand
 * and stored, then handed to whoever asks next.
 *
 * The live shape it would have missed: a later PR removes the group-level
 * `force-dynamic` from `src/app/(public)/layout.tsx` — or adds a
 * `generateStaticParams` to `pay/[token]` — and the first visitor's render of a
 * one-time payment link is stored and served to the next. Neither this check nor
 * `check-website-render-modes.mjs` noticed, because the latter walks
 * `src/app/(website)` only.
 */
const ALLOWED_ON_DEMAND_ROUTES = new Set([ISR_DYNAMIC_ROUTE]);

/**
 * The pure half, so the rules are testable without a build.
 *
 * Returns a list of plain-English problems; an empty list is a pass.
 */
export function auditPrerenderManifest(manifest) {
  const problems = [];
  const routes = Object.keys(manifest?.routes ?? {});
  const dynamicRoutes = Object.keys(manifest?.dynamicRoutes ?? {});

  if (!dynamicRoutes.includes(ISR_DYNAMIC_ROUTE)) {
    problems.push(
      `${ISR_DYNAMIC_ROUTE} is not in the manifest's dynamicRoutes, so the CMS pages ` +
        "are NOT being served from the full-route cache — every visit renders them " +
        "again, which is the whole cost #2352 slice 1 removed. The usual cause is a " +
        "component somewhere under (website) reading auth(), cookies() or headers(): " +
        "that opts the route out of static rendering silently. " +
        `Saw dynamicRoutes: ${JSON.stringify(dynamicRoutes)}.`,
    );
  }

  for (const route of MUST_STAY_DYNAMIC) {
    if (routes.includes(route)) {
      problems.push(
        `${route} is prerendered at BUILD time (manifest routes). A build has no ` +
          "database and no request, so it would freeze an empty page carrying inline " +
          "scripts with no CSP nonce. It must keep `export const dynamic = " +
          '"force-dynamic"` until #2352 slice 2 answers the build-time nonce question.',
      );
    }
    if (dynamicRoutes.includes(route)) {
      problems.push(
        `${route} is listed as an on-demand-generated route (manifest dynamicRoutes), ` +
          "so a render of it would be STORED and served to whoever asked next. For a " +
          "token- or PIN-bearing address that is a page skipping its own re-check.",
      );
    }
  }

  for (const route of dynamicRoutes) {
    // MUST_STAY_DYNAMIC already reports its own, with a more specific reason.
    if (
      !ALLOWED_ON_DEMAND_ROUTES.has(route) &&
      !MUST_STAY_DYNAMIC.includes(route)
    ) {
      problems.push(
        `${route} is newly generated on demand and STORED (manifest dynamicRoutes), ` +
          "so one visitor's render is handed to whoever asks for that address next. " +
          "If that is intended, argue for it in ALLOWED_ON_DEMAND_ROUTES here — and " +
          "be sure the route carries nothing per-visitor, no token or PIN in its URL, " +
          "and a public-website CSP nonce (src/lib/public-website-paths.ts), because " +
          "a stored page outside that set carries a nonce no later response names.",
      );
    }
  }

  for (const route of routes) {
    if (!ALLOWED_BUILD_TIME_ROUTES.has(route)) {
      problems.push(
        `${route} is newly prerendered at build time. If that is intended, add it to ` +
          "ALLOWED_BUILD_TIME_ROUTES here with the reason, and check " +
          "check-prerendered-script-nonces.mjs still passes — a build-time render has " +
          "no request, so Next stamps no nonce into its inline scripts and the " +
          "nonce-only CSP blocks them (#2356).",
      );
    }
  }

  return problems;
}

export function checkBuildOutput(repoRoot) {
  const manifestPath = path.join(repoRoot, DIST_DIR, MANIFEST_FILE);

  // Loud rather than quiet: a missing manifest means the build did not run, and
  // "no problems found" would be a false pass.
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No ${DIST_DIR}/${MANIFEST_FILE}. This check reads real build output and must ` +
        "run after `pnpm run build`.",
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  return {
    routeCount: Object.keys(manifest.routes ?? {}).length,
    dynamicRouteCount: Object.keys(manifest.dynamicRoutes ?? {}).length,
    problems: auditPrerenderManifest(manifest),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const { routeCount, dynamicRouteCount, problems } = checkBuildOutput(
      process.cwd(),
    );

    if (problems.length > 0) {
      console.error("The build's cached-route set is wrong (#2352):");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        `Prerender-manifest check passed: ${dynamicRouteCount} on-demand route(s), ` +
          `${routeCount} build-time prerendered route(s).`,
      );
    }
  } catch (error) {
    console.error(`Prerender-manifest check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
