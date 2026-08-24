import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  explicitPublicApiRoutes,
  mixedMethodApiRoutes,
  type MixedMethodApiRouteMetadata,
} from "@/lib/api-route-security";

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

const issue675MalformedJsonRoutes = [
  "src/app/api/admin/bed-allocation/allocations/range/route.ts",
  "src/app/api/admin/bed-allocation/allocations/route.ts",
  "src/app/api/admin/bed-allocation/auto-allocate/route.ts",
  "src/app/api/admin/bed-allocation/approve/route.ts",
  "src/app/api/admin/bed-allocation/beds/[id]/route.ts",
  "src/app/api/admin/bed-allocation/beds/route.ts",
  "src/app/api/admin/bed-allocation/rooms/[id]/route.ts",
  "src/app/api/admin/bed-allocation/rooms/route.ts",
  "src/app/api/admin/bed-allocation/settings/route.ts",
  "src/app/api/admin/promo-codes/[id]/route.ts",
  "src/app/api/admin/promo-codes/route.ts",
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/app/api/bookings/[id]/modify-quote/route.ts",
  "src/app/api/bookings/quote/route.ts",
  "src/app/api/bookings/route.ts",
  "src/app/api/payments/create-payment-intent/route.ts",
  "src/app/api/promo-codes/validate/route.ts",
] as const;

// Shared cross-file wrappers that perform requireAdmin internally. Keep this
// closed list synchronized with the exported route guards; the defining module
// must still call requireAdmin (asserted in the method-reachability test below),
// so adding a wrapper cannot silently turn the allowlist into a bypass.
const sharedAdminGuardWrappers: Record<string, string> = {
  requireBedAllocationRead: "src/lib/admin-bed-allocation-routes.ts",
  requireBedAllocationWrite: "src/lib/admin-bed-allocation-routes.ts",
  requireBedInventoryRead: "src/lib/admin-bed-allocation-routes.ts",
  requireBedInventoryWrite: "src/lib/admin-bed-allocation-routes.ts",
  requireFullAdminForConfigTransfer: "src/lib/config-transfer/route-helpers.ts",
};

function hasAdminGuard(contents: string) {
  // Admin routes must use the shared requireAdmin helper (directly or via an
  // allowlisted wrapper); inline auth()/role-check sequences are not accepted.
  return (
    /\brequireAdmin\s*\(/.test(contents) ||
    Object.keys(sharedAdminGuardWrappers).some((wrapper) =>
      // Test helper: wrapper comes from Object.keys of an internal constant map, not user input.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
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
  if (routePath.endsWith("/webhooks/servernz-posts/route.ts")) {
    // Epic #2992: HMAC with the registration-issued secret, compared in
    // constant time. Both markers must be present -- a signature check that
    // lost its timingSafeEqual would still "verify".
    return /x-acs-signature/.test(contents) && /timingSafeEqual/.test(contents);
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
      if (boundary === "member" && !hasMemberGuard(contents)) {
        return [`${routePath}: member route lacks active-session guard marker`];
      }

      return [];
    });

    expect(violations).toEqual([]);
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
        if (hasMemberGuard(body) || /\bauth\s*\(/.test(body)) return [];

        const documented = documentedMethods[method];
        if (documented && documented.boundary === "public") return [];

        return [
          `${routePath}#${method}: member-boundary method has no active-session guard and is not documented as a public mixed-method handler`,
        ];
      });
    });

    expect(violations).toEqual([]);
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

  it("keeps issue #675 JSON-consuming routes on the controlled malformed JSON path", () => {
    const violations = issue675MalformedJsonRoutes.flatMap((routePath) => {
      const contents = routeContents(routePath);
      const directParse = /\bawait\s+(?:req|request)\.json\(\)/.test(contents);

      if (!contents.includes("parseJsonRequestBody(")) {
        return [`${routePath}: route does not use controlled JSON parsing`];
      }
      if (directParse) {
        return [`${routePath}: route still directly awaits request.json()`];
      }
      return [];
    });

    expect(violations).toEqual([]);
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
