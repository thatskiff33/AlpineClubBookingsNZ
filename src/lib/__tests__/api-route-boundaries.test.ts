import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  explicitPublicApiRoutes,
  mixedMethodApiRoutes,
  type MixedMethodApiRouteMetadata,
} from "@/lib/api-route-security";
import { SHARED_ADMIN_GUARD_WRAPPERS } from "@/lib/__tests__/helpers/admin-route-explicit-permissions";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

function listRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listRouteFiles(entryPath);
    }
    return entry.name === "route.ts" ? [entryPath] : [];
  });
}

function relativeRoutePath(filePath: string) {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

function routeContents(filePath: string) {
  return fs.readFileSync(path.join(process.cwd(), filePath), "utf8");
}

// `request.json()` on the incoming request, or on its `clone()`, however the
// call is awaited.
const DIRECT_REQUEST_JSON_READ =
  /\b(?:request|req)\s*\??\.\s*(?:clone\(\)\s*\??\.\s*)?json\(\)/;
// Receivers of a `.json()` call that a route file may contain: the incoming
// request (the two names routes use) and a provider's `response`.
const JSON_RECEIVER_NAMES = new Set(["request", "req", "response"]);
// The body read as text, or as bytes, on the incoming request or its clone.
const DIRECT_REQUEST_RAW_READ =
  /\b(?:request|req)\s*\??\.\s*(?:clone\(\)\s*\??\.\s*)?(?:text|arrayBuffer|blob)\(\)/;
// A body read on a clone of anything: a route never needs one.
const CLONED_BODY_READ =
  /\.\s*clone\(\)\s*\??\.\s*(?:json|text|arrayBuffer|blob|formData)\(\)/;
// Receivers a route may call `text()`, `arrayBuffer()` or `blob()` on, none of
// them the request. Each needs a reason; a new name fails the census.
const RAW_READ_RECEIVERS: Record<string, string> = {
  upstream: "skifield-conditions reads the upstream provider's answer as text",
  response: "a provider's answer, the same receiver name the JSON census allows",
  file: "an uploaded File taken from formData(); its bytes are the upload, not a JSON body",
};

/**
 * Route files that still call `request.json()` themselves instead of the shared
 * readers in `src/lib/api-json.ts` (#5400, #5407). The census below derives the
 * set of such files from the tree and requires it to equal this list exactly: a
 * route that reads the body directly and is not listed fails, and so does a
 * listed route that no longer does.
 *
 * Every route reads its JSON body through `parseJsonRequestBody` when the body
 * is required, or `parseOptionalJsonRequestBody` when it may be empty. Either
 * way a body that is present but not valid JSON answers 400, never a 500 and
 * never "no body" (#5407 items 26 to 28). What is left here is permanent
 * exceptions, each group with its reason.
 *
 * Do not add a route to dodge the census: a new route uses a shared reader.
 * Comments are removed before matching (`stripComments`, INV-SSOT-004), so a
 * comment that mentions `request.json()` is not a read and a commented-out
 * read does not keep an entry alive.
 *
 * The optional reader reads `text()`, so the second census below fails any
 * route that reads the request, or a clone of it, as text or bytes itself: a
 * route cannot parse a body by hand beside the shared readers. A body read on
 * any `clone()` fails too. The signed-webhook routes (Stripe, Xero, SES SNS,
 * ServerNZ posts) read the raw bounded text on purpose, because the signature
 * covers the exact bytes, through `readBoundedWebhookText`; `mcp` and
 * `mcp/oauth/register` use the same bounded reader. `JSON_RECEIVER_NAMES` and
 * `RAW_READ_RECEIVERS` fail on a new receiver name.
 *
 * Stated limits: `formData()` on the request (the upload routes use it on
 * purpose) and stream readers (`request.body`, `getReader()`) are not
 * matched, and neither is a read through a helper defined outside the route.
 */
const directJsonReadAllowlist: Record<
  string,
  { reason: string; routes: string[] }
> = {
  intentionalExtraResponse: {
    reason:
      "Permanent exception, not pending work. The invalid-JSON 400 carries something on purpose that the shared reader's bare answer cannot. admin/roster/[date]: a machine-readable `code` (ROSTER_JSON_INVALID) beside a roster-specific message, the same shape as that route's sibling answers (ROSTER_PARAMS_INVALID and others); no client reading this code was found, so the reason recorded is consistency with its siblings. lodge-maintenance/[token]: the `no-store` and `noindex` headers its docblock requires on every response of the unauthenticated token door, so a tokenised page is never cached or indexed.",
    routes: [
      "src/app/api/admin/roster/[date]/route.ts",
      "src/app/api/lodge-maintenance/[token]/route.ts",
    ],
  },
};

// Shared cross-file wrappers that perform requireAdmin internally. Keep this
// closed list synchronized with the exported route guards; the defining module
// must still call requireAdmin (asserted in the method-reachability test below),
// so adding a wrapper cannot silently turn the allowlist into a bypass.
//
// ONE HOME since #2975, in `helpers/admin-route-explicit-permissions.ts`. That
// module follows the same wrappers to find WHICH permission the guard is given,
// and two copies of the list would let this suite accept a wrapper the other
// cannot read — a route whose gate nobody measures.
const sharedAdminGuardWrappers = SHARED_ADMIN_GUARD_WRAPPERS;

function hasAdminGuard(contents: string) {
  // Admin routes must use the shared requireAdmin helper (directly or via an
  // allowlisted wrapper); inline auth()/role-check sequences are not accepted.
  return (
    /\brequireAdmin\s*\(/.test(contents) ||
    Object.keys(sharedAdminGuardWrappers).some((wrapper) =>
      // Test helper: wrapper comes from Object.keys of an internal constant map, not user input.
      new RegExp(`\\b${wrapper}\\s*\\(`).test(contents),
    )
  );
}

function hasMemberGuard(contents: string) {
  return (
    /\brequireActiveSession\s*\(/.test(contents) ||
    /\brequireActiveSessionUser\s*\(/.test(contents) ||
    /\brequireTwoFactorApiSession\s*\(/.test(contents)
  );
}

// Passkey ceremonies share one guard module. Recognising the call is only a
// session marker when that module's function actually loads the two-factor
// session — the pin in this file reads the function body and fails if the
// call is removed.
function hasPasskeySessionGuard(fileContents: string, methodBody: string) {
  return (
    /\bguardPasskeyRequest\s*\(/.test(methodBody) &&
    /import\s*\{[^}]*\bguardPasskeyRequest\b[^}]*\}\s*from\s*["'](?:\.\.\/)+guard["']/.test(
      fileContents,
    )
  );
}

function hasFinanceGuard(contents: string) {
  return (
    /\brequireFinance(?:Viewer|Manager)ApiAccess\s*\(/.test(contents) ||
    /\bhasFinanceViewerAccess\s*\(/.test(contents)
  );
}

function hasLodgeGuard(contents: string, routePath: string) {
  return (
    /\bcheckLodgeAuth\s*\(/.test(contents) ||
    (routePath === "src/app/api/lodge/pin-login/route.ts" &&
      /\brequireActiveSessionUser\s*\(/.test(contents) &&
      /\bhasLodgeAccess\s*\(\s*session\.user\s*\)/.test(contents))
  );
}

function hasCronGuard(contents: string) {
  return (
    /\brequireCronSecret\s*\(/.test(contents) ||
    /\bisValidCronSecret\s*\(/.test(contents)
  );
}

function hasWebhookSignatureBoundary(routePath: string, contents: string) {
  if (routePath.endsWith("/webhooks/stripe/route.ts")) {
    return (
      /stripe-signature/.test(contents) &&
      /constructWebhookEvent/.test(contents)
    );
  }
  if (routePath.endsWith("/webhooks/xero/route.ts")) {
    return (
      /x-xero-signature/.test(contents) && /timingSafeEqual/.test(contents)
    );
  }
  if (
    routePath.endsWith("/webhooks/servernz-posts/route.ts") ||
    routePath.endsWith("/webhooks/servernz-availability/route.ts")
  ) {
    // Epic #2992 and triyder/AlpineClubBookingsNZ#62: HMAC with the registration-issued secret, compared in
    // constant time, through the ONE shared verifier. The route must call it;
    // the verifier's own constant-time compare is pinned below
    // ("the shared Alpine Central Server verifier keeps its constant-time compare").
    return /verifyServerNzSignature\(/.test(contents);
  }
  if (routePath.endsWith("/webhooks/ses-sns/route.ts")) {
    return /verifySnsWebhookMessage/.test(contents);
  }
  return false;
}

// Slice a route file into per-method segments so a mixed-method file can be
// checked one exported HTTP handler at a time instead of treating the whole
// file as a single boundary (issue #812).
function extractMethodBodies(contents: string): Record<string, string> {
  const methodPattern =
    /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  const matches = [...contents.matchAll(methodPattern)];
  const bodies: Record<string, string> = {};
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? contents.length)
        : contents.length;
    bodies[matches[index][1]] = contents.slice(start, end);
  }
  return bodies;
}

function expectedBoundaryFor(routePath: string) {
  if (routePath in explicitPublicApiRoutes) return "public";
  if (routePath.startsWith("src/app/api/admin/")) return "admin";
  if (routePath.startsWith("src/app/api/finance/")) return "finance";
  if (routePath.startsWith("src/app/api/lodge/")) return "lodge";
  if (routePath.startsWith("src/app/api/cron/")) return "cron";
  // Every `/api/deploy/*` route is operator machinery for
  // `scripts/run-production-blue-green-deploy.sh` and is guarded by the shared
  // cron/deploy secret. A PREFIX rather than the single named file it used to be
  // (#2566 added the warm-up gate): a new deploy route now inherits the
  // requirement instead of defaulting to "member" and failing for the wrong
  // reason, and one that forgets the guard still fails.
  if (routePath.startsWith("src/app/api/deploy/")) return "cron";
  return "member";
}

describe("API route boundary metadata", () => {
  const routeFiles = listRouteFiles(path.join(process.cwd(), "src/app/api"))
    .map(relativeRoutePath)
    .sort();

  it("keeps the public route allowlist exact and backed by real files", () => {
    const missing = Object.keys(explicitPublicApiRoutes).filter(
      (routePath) => !routeFiles.includes(routePath),
    );

    expect(missing).toEqual([]);
  });

  it("requires every protected route family to expose an approved boundary marker", () => {
    const violations = routeFiles.flatMap((routePath) => {
      const contents = routeContents(routePath);
      const boundary = expectedBoundaryFor(routePath);

      if (boundary === "public") {
        const metadata =
          explicitPublicApiRoutes[
            routePath as keyof typeof explicitPublicApiRoutes
          ];
        if (metadata.boundary === "webhook") {
          return hasWebhookSignatureBoundary(routePath, contents)
            ? []
            : [`${routePath}: webhook route lacks provider signature marker`];
        }
        return [];
      }

      if (boundary === "admin" && !hasAdminGuard(contents)) {
        return [
          `${routePath}: admin route lacks requireAdmin or legacy admin guard marker`,
        ];
      }
      if (boundary === "finance" && !hasFinanceGuard(contents)) {
        return [`${routePath}: finance route lacks finance API guard marker`];
      }
      if (boundary === "lodge" && !hasLodgeGuard(contents, routePath)) {
        return [`${routePath}: lodge route lacks lodge guard marker`];
      }
      if (boundary === "cron" && !hasCronGuard(contents)) {
        return [
          `${routePath}: cron/deploy route lacks cron secret guard marker`,
        ];
      }
      if (
        boundary === "member" &&
        !hasMemberGuard(contents) &&
        !hasPasskeySessionGuard(contents, contents)
      ) {
        return [`${routePath}: member route lacks active-session guard marker`];
      }

      return [];
    });

    expect(violations).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("the shared Alpine Central Server verifier keeps its constant-time compare", () => {
    // Both servernz webhook routes are accepted above because they call
    // verifyServerNzSignature; this pins that the verifier itself still checks
    // the signature header in constant time with its length guard, so a refactor
    // that lost either cannot leave both routes "verifying" (#2992, triyder/AlpineClubBookingsNZ#62).
    const verifier = fs.readFileSync(
      path.join(process.cwd(), "src/lib/servernz-signature.ts"),
      "utf8",
    );
    expect(verifier).toMatch(/x-acs-signature/);
    expect(verifier).toMatch(/timingSafeEqual\(a, b\)/);
    expect(verifier).toMatch(/a\.length !== b\.length/);
  });

  it("enforces per-method boundaries for documented mixed-method routes", () => {
    const violations = Object.entries(mixedMethodApiRoutes).flatMap(
      ([routePath, metadata]) => {
        if (!routeFiles.includes(routePath)) {
          return [`${routePath}: documented mixed-method route file is missing`];
        }

        const bodies = extractMethodBodies(routeContents(routePath));
        const issues: string[] = [];

        for (const [method, methodMetadata] of Object.entries(
          metadata.methods,
        ) as Array<
          [string, NonNullable<MixedMethodApiRouteMetadata["methods"][keyof MixedMethodApiRouteMetadata["methods"]]>]
        >) {
          const body = bodies[method];
          if (!body) {
            issues.push(`${routePath}#${method}: documented method is not exported`);
            continue;
          }

          if (methodMetadata.boundary === "public") {
            // A genuinely public method must not depend on a session, admin or
            // finance guard. If one is added later, the boundary metadata must
            // be updated to match (or the method is no longer public).
            //
            // The one sanctioned shape is a method that is anonymous for a
            // documented subset of requests and guarded for the rest (the
            // boundary is mixed WITHIN the method, which `boundary` alone
            // cannot express). That requires an explicit `conditionalAuth`
            // declaration naming exactly which requests are anonymous — and it
            // is checked BOTH ways, so neither a silent guard nor a stale
            // declaration can survive.
            const guarded =
              hasMemberGuard(body) ||
              hasAdminGuard(body) ||
              hasFinanceGuard(body);
            if (guarded && !methodMetadata.conditionalAuth) {
              issues.push(
                `${routePath}#${method}: documented public method contains an auth guard`,
              );
            }
            if (!guarded && methodMetadata.conditionalAuth) {
              issues.push(
                `${routePath}#${method}: declares conditionalAuth but contains no shared guard — drop the declaration`,
              );
            }
          } else if (methodMetadata.boundary === "member") {
            if (!hasMemberGuard(body) && !/\bauth\s*\(/.test(body)) {
              issues.push(
                `${routePath}#${method}: documented member method lacks an active-session guard`,
              );
            }
          } else if (methodMetadata.boundary === "admin" && !hasAdminGuard(body)) {
            issues.push(
              `${routePath}#${method}: documented admin method lacks requireAdmin`,
            );
          } else if (
            methodMetadata.boundary === "finance" &&
            !hasFinanceGuard(body)
          ) {
            issues.push(
              `${routePath}#${method}: documented finance method lacks finance guard`,
            );
          }
        }

        // Every exported HTTP method in a mixed-method file must be documented,
        // so a newly added handler cannot silently inherit the wrong boundary.
        for (const method of Object.keys(bodies)) {
          if (!(method in metadata.methods)) {
            issues.push(
              `${routePath}#${method}: exported method is not documented in mixedMethodApiRoutes`,
            );
          }
        }

        return issues;
      },
    );

    expect(violations).toEqual([]);
  });

  it("requires every method of a member-boundary route to be guarded or documented as a public mixed method", () => {
    // Issue #812 Risk #1 blind spot: the file-level marker check passes a
    // member-boundary file as soon as *one* exported method calls a session
    // guard. A second exported method with no guard at all would then ride
    // along as effectively public without appearing in the public allowlist.
    // Enforce per method: a member-boundary handler must either carry a
    // session guard, or be explicitly documented as a public method in
    // mixedMethodApiRoutes (which the per-method test above validates).
    const violations = routeFiles.flatMap((routePath) => {
      if (expectedBoundaryFor(routePath) !== "member") return [];

      // Widened to a plain string-keyed record on purpose. `keyof` over the
      // UNION of every entry's `methods` object is the INTERSECTION of their
      // keys, so as soon as two documented routes share no HTTP method (which
      // #2263's two single-POST entries made true), that key set collapses to
      // `never` and the lookup below stops typechecking. The runtime behaviour
      // is unchanged; only the index signature is loosened.
      const documentedMethods: Partial<
        Record<string, { boundary: string; reason: string }>
      > =
        mixedMethodApiRoutes[routePath as keyof typeof mixedMethodApiRoutes]
          ?.methods ?? {};
      const bodies = extractMethodBodies(routeContents(routePath));

      return Object.entries(bodies).flatMap(([method, body]) => {
        if (
          hasMemberGuard(body) ||
          hasPasskeySessionGuard(routeContents(routePath), body) ||
          /\bauth\s*\(/.test(body)
        ) {
          return [];
        }

        const documented = documentedMethods[method];
        if (documented && documented.boundary === "public") return [];

        return [
          `${routePath}#${method}: member-boundary method has no active-session guard and is not documented as a public mixed-method handler`,
        ];
      });
    });

    expect(violations).toEqual([]);
  });

  it("keeps the shared passkey guard on the two-factor session", () => {
    const contents = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/auth/2fa/webauthn/guard.ts"),
      "utf8",
    );
    const bodies = extractLocalFunctionBodies(contents);
    expect(bodies.guardPasskeyRequest ?? "").toMatch(
      /\brequireTwoFactorApiSession\s*\(/,
    );
  });

  // -------------------------------------------------------------------------
  // Per-method admin guard enforcement (issue #1132). The file-level admin
  // marker check above has the same blind spot issue #812 found for member
  // routes: one guarded method lets a second unguarded exported method ride
  // along. Admin handlers either call requireAdmin directly, call a local
  // helper that does, or call a shared wrapper from the closed allowlist above.
  // -------------------------------------------------------------------------

  // (The shared wrapper allowlist is hoisted to module scope above so the
  // boundary-marker check uses the same list; its defining-module assertion
  // below keeps it from rotting into a bypass.)

  // Slice every top-level function in a file (declarations and const
  // arrow/function assignments) so a method body can be traced through local
  // helpers to a requireAdmin call.
  function extractLocalFunctionBodies(
    contents: string,
  ): Record<string, string> {
    const definitionPattern =
      /(?:^|\n)(?:export\s+)?(?:async\s+function\s+(\w+)|function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function))/g;
    const matches = [...contents.matchAll(definitionPattern)];
    const bodies: Record<string, string> = {};
    for (let index = 0; index < matches.length; index += 1) {
      const name = matches[index][1] ?? matches[index][2] ?? matches[index][3];
      const start = matches[index].index ?? 0;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? contents.length)
          : contents.length;
      bodies[name] = contents.slice(start, end);
    }
    return bodies;
  }

  function bodyReachesRequireAdmin(
    body: string,
    localFunctions: Record<string, string>,
    depth = 0,
  ): boolean {
    if (/\brequireAdmin\s*\(/.test(body)) return true;
    if (depth >= 3) return false;

    for (const [name, helperBody] of Object.entries(localFunctions)) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
      if (helperBody === body) continue;
      if (bodyReachesRequireAdmin(helperBody, localFunctions, depth + 1)) {
        return true;
      }
    }

    for (const [wrapper, definingFile] of Object.entries(
      sharedAdminGuardWrappers,
    )) {
      if (new RegExp(`\\b${wrapper}\\s*\\(`).test(body)) {
        const wrapperContents = fs.readFileSync(
          path.join(process.cwd(), definingFile),
          "utf8",
        );
        if (/\brequireAdmin\s*\(/.test(wrapperContents)) return true;
      }
    }

    return false;
  }

  it("requires every method of an admin-boundary route to reach requireAdmin", () => {
    const violations = routeFiles.flatMap((routePath) => {
      if (expectedBoundaryFor(routePath) !== "admin") return [];

      const contents = routeContents(routePath);
      const localFunctions = extractLocalFunctionBodies(contents);
      const bodies = extractMethodBodies(contents);

      return Object.entries(bodies).flatMap(([method, body]) =>
        bodyReachesRequireAdmin(body, localFunctions)
          ? []
          : [
              `${routePath}#${method}: admin-boundary method does not reach requireAdmin directly, via a local helper, or via an allowlisted shared wrapper`,
            ],
      );
    });

    expect(violations).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Per-method finance guard enforcement with explicit access levels (issue
  // #1132). Every /api/finance route method must be documented here, so a new
  // finance route fails the suite until its required level is declared, and a
  // silent manager→viewer downgrade shows up as a reviewable diff.
  // -------------------------------------------------------------------------

  const financeRouteAccessLevels: Record<
    string,
    Record<string, "viewer" | "manager" | "session-redirect">
  > = {
    "src/app/api/finance/bookings/metrics/route.ts": { GET: "viewer" },
    "src/app/api/finance/legacy-dashboard/auth/route.ts": {
      // Browser redirect flow: checks auth() + hasFinanceViewerAccess and
      // redirects to login instead of returning a JSON 401.
      GET: "session-redirect",
    },
    "src/app/api/finance/legacy-dashboard/bookings/route.ts": { GET: "viewer" },
    "src/app/api/finance/sync/backfill-monthly-facts/route.ts": {
      POST: "manager",
    },
    "src/app/api/finance/sync/run/route.ts": { POST: "manager" },
    "src/app/api/finance/sync/status/route.ts": { GET: "manager" },
  };

  it("requires every finance route method to match its documented access level", () => {
    const financeRouteFiles = routeFiles.filter((routePath) =>
      routePath.startsWith("src/app/api/finance/"),
    );

    const violations = financeRouteFiles.flatMap((routePath) => {
      const documented = financeRouteAccessLevels[routePath];
      if (!documented) {
        return [
          `${routePath}: finance route is not documented in financeRouteAccessLevels`,
        ];
      }

      const bodies = extractMethodBodies(routeContents(routePath));
      const issues: string[] = [];

      for (const [method, body] of Object.entries(bodies)) {
        const level = documented[method];
        if (!level) {
          issues.push(
            `${routePath}#${method}: exported finance method has no documented access level`,
          );
          continue;
        }

        if (
          level === "viewer" &&
          !/\brequireFinanceViewerApiAccess\s*\(/.test(body)
        ) {
          issues.push(
            `${routePath}#${method}: documented viewer method does not call requireFinanceViewerApiAccess`,
          );
        }
        if (
          level === "manager" &&
          !/\brequireFinanceManagerApiAccess\s*\(/.test(body)
        ) {
          issues.push(
            `${routePath}#${method}: documented manager method does not call requireFinanceManagerApiAccess`,
          );
        }
        if (
          level === "session-redirect" &&
          !(/\bauth\s*\(/.test(body) && /\bhasFinanceViewerAccess\s*\(/.test(body))
        ) {
          issues.push(
            `${routePath}#${method}: documented session-redirect method must check auth() and hasFinanceViewerAccess`,
          );
        }
      }

      for (const method of Object.keys(documented)) {
        if (!(method in bodies)) {
          issues.push(
            `${routePath}#${method}: documented finance method is not exported`,
          );
        }
      }

      return issues;
    });

    expect(violations).toEqual([]);
  });

  it("reads a request body through the shared JSON reader unless the route is listed with a reason", () => {
    const allowlisted = Object.values(directJsonReadAllowlist).flatMap(
      (group) => group.routes,
    );
    const routes = listRouteFiles(path.join(process.cwd(), "src/app/api")).map(
      relativeRoutePath,
    );
    const code = (routePath: string) => stripComments(routeContents(routePath));
    const directReaders = routes.filter((routePath) =>
      DIRECT_REQUEST_JSON_READ.test(code(routePath)),
    );

    const duplicated = allowlisted.filter(
      (routePath, index) => allowlisted.indexOf(routePath) !== index,
    );
    const unlisted = directReaders.filter(
      (routePath) => !allowlisted.includes(routePath),
    );
    const stale = allowlisted.filter(
      (routePath) => !directReaders.includes(routePath),
    );
    // A request parameter under another name would slip past the pattern above.
    const otherReceivers = routes.flatMap((routePath) =>
      [...code(routePath).matchAll(/\b(\w+)\s*\??\.\s*json\(\)/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => !JSON_RECEIVER_NAMES.has(name))
        .map((name) => `${routePath}: ${name}.json()`),
    );

    expect({
      duplicated,
      unlisted,
      stale,
      otherReceivers,
    }).toEqual({
      duplicated: [],
      unlisted: [],
      stale: [],
      otherReceivers: [],
    });
  }, CENSUS_TIMEOUT_MS);

  it("never reads a request body as text or bytes in a route; the shared readers do it", () => {
    const routes = listRouteFiles(path.join(process.cwd(), "src/app/api")).map(
      relativeRoutePath,
    );
    const code = (routePath: string) => stripComments(routeContents(routePath));

    const rawReaders = routes.filter((routePath) =>
      DIRECT_REQUEST_RAW_READ.test(code(routePath)),
    );
    const clonedReaders = routes.filter((routePath) =>
      CLONED_BODY_READ.test(code(routePath)),
    );
    // A request parameter under another name would slip past the pattern above.
    const otherRawReceivers = routes.flatMap((routePath) =>
      [...code(routePath).matchAll(/\b(\w+)\s*\??\.\s*(text|arrayBuffer|blob)\(\)/g)]
        .filter((match) => !Object.hasOwn(RAW_READ_RECEIVERS, match[1] ?? ""))
        .map((match) => `${routePath}: ${match[1]}.${match[2]}()`),
    );

    expect({ rawReaders, clonedReaders, otherRawReceivers }).toEqual({
      rawReaders: [],
      clonedReaders: [],
      otherRawReceivers: [],
    });
  });

  it("binds a shared reader's result to an ordinary name, never a global it would shadow", () => {
    // #5400's conversion script once bound a result to `undefined`, which
    // compiles and shadows the global for the rest of the handler (#5407).
    const shadowing = new Set(["undefined", "NaN", "Infinity", "arguments", "eval"]);
    const routes = listRouteFiles(path.join(process.cwd(), "src/app/api")).map(
      relativeRoutePath,
    );
    const badBindings = routes.flatMap((routePath) =>
      [
        ...stripComments(routeContents(routePath)).matchAll(
          /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+parse(?:Optional)?JsonRequestBody\(/g,
        ),
      ]
        .map((match) => match[1] ?? "")
        .filter((name) => shadowing.has(name))
        .map((name) => `${routePath}: ${name}`),
    );

    expect(badBindings).toEqual([]);
  });

  it("does not allow SVG uploads through the static image-manager route (stored XSS)", () => {
    // SVG is an XML dialect that can carry inline <script> and event-handler
    // attributes.  Files under public/images/ are served by Next.js/Caddy
    // without a restrictive CSP, so an SVG opened directly would execute JS
    // in the site origin (session/cookie theft).  The upload and list routes
    // must never include SVG in their allowlists.
    const uploadContents = routeContents(
      "src/app/api/admin/image-manager/upload/route.ts",
    );
    const listContents = routeContents(
      "src/app/api/admin/image-manager/images/route.ts",
    );

    expect(uploadContents).not.toContain("svg");
    expect(listContents).not.toContain("svg");
  });
});
