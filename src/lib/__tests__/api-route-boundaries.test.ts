import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explicitPublicApiRoutes } from "@/lib/api-route-security";

function listRouteFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
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

function hasAdminGuard(contents: string) {
  return (
    /\brequireAdmin\s*\(/.test(contents) ||
    (/\bauth\s*\(/.test(contents) &&
      /\brequireActiveSessionUser\s*\(/.test(contents) &&
      /session\.user\.role\s*(?:!==|===)\s*["']ADMIN["']/.test(contents))
  );
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
    return /stripe-signature/.test(contents) && /constructWebhookEvent/.test(contents);
  }
  if (routePath.endsWith("/webhooks/xero/route.ts")) {
    return /x-xero-signature/.test(contents) && /timingSafeEqual/.test(contents);
  }
  if (routePath.endsWith("/webhooks/ses-sns/route.ts")) {
    return /verifySnsWebhookMessage/.test(contents);
  }
  return false;
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
    expect(routeFiles).toHaveLength(228);

    const missing = Object.keys(explicitPublicApiRoutes).filter(
      (routePath) => !routeFiles.includes(routePath)
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
        return [`${routePath}: admin route lacks requireAdmin or legacy admin guard marker`];
      }
      if (boundary === "finance" && !hasFinanceGuard(contents)) {
        return [`${routePath}: finance route lacks finance API guard marker`];
      }
      if (boundary === "lodge" && !hasLodgeGuard(contents, routePath)) {
        return [`${routePath}: lodge route lacks lodge guard marker`];
      }
      if (boundary === "cron" && !hasCronGuard(contents)) {
        return [`${routePath}: cron/deploy route lacks cron secret guard marker`];
      }
      if (boundary === "member" && !hasMemberGuard(contents)) {
        return [`${routePath}: member route lacks active-session guard marker`];
      }

      return [];
    });

    expect(violations).toEqual([]);
  });
});
