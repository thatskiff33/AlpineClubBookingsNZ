import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  explicitPublicApiRoutes,
  mixedMethodApiRoutes,
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

function hasAdminGuard(contents: string) {
  // Admin routes must use the shared requireAdmin helper; inline
  // auth()/role-check/requireActiveSessionUser sequences are not accepted.
  return /\brequireAdmin\s*\(/.test(contents);
}

function hasMemberGuard(contents: string) {
  return (
    /\brequireActiveSession\s*\(/.test(contents) ||
    /\brequireActiveSessionUser\s*\(/.test(contents)
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
      /session\.user\.role\s*(?:===|!==)\s*["']LODGE["']/.test(contents))
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
  if (routePath === "src/app/api/deploy/runtime-status/route.ts") return "cron";
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
        )) {
          const body = bodies[method];
          if (!body) {
            issues.push(`${routePath}#${method}: documented method is not exported`);
            continue;
          }

          if (methodMetadata.boundary === "public") {
            // A genuinely public method must not depend on a session, admin or
            // finance guard. If one is added later, the boundary metadata must
            // be updated to match (or the method is no longer public).
            if (
              hasMemberGuard(body) ||
              hasAdminGuard(body) ||
              hasFinanceGuard(body)
            ) {
              issues.push(
                `${routePath}#${method}: documented public method contains an auth guard`,
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

      const documentedMethods =
        mixedMethodApiRoutes[routePath as keyof typeof mixedMethodApiRoutes]
          ?.methods ?? {};
      const bodies = extractMethodBodies(routeContents(routePath));

      return Object.entries(bodies).flatMap(([method, body]) => {
        if (hasMemberGuard(body) || /\bauth\s*\(/.test(body)) return [];

        const documented =
          documentedMethods[method as keyof typeof documentedMethods];
        if (documented && documented.boundary === "public") return [];

        return [
          `${routePath}#${method}: member-boundary method has no active-session guard and is not documented as a public mixed-method handler`,
        ];
      });
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
