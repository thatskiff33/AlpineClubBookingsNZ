/**
 * The `mcpServer` module switched off (ALP-653, `INV-MCP-001`).
 *
 * Every route and page the module adds answers as if it did not exist, and
 * does no work first: no session read, no rate-limit count, no database
 * access, no request body read. The route files are discovered from disk, so
 * a route added later under one of the module's prefixes, or one that reaches
 * into `@/lib/mcp`, is held to the same rule without anyone listing it here.
 *
 * The admin page has no gate of its own: like every admin page since #4799 it
 * is gated by the proxy rule its hub registry entry's `mcpServer` flag
 * generates, and its data comes only through the API routes gated below.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { modules, touched, auth, guards, limits, recentAuth } = vi.hoisted(() => ({
  modules: vi.fn(),
  touched: [] as string[],
  auth: vi.fn(),
  guards: {
    requireActiveSession: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    requireAdmin: vi.fn(),
  },
  limits: { applyRateLimit: vi.fn(), checkRateLimit: vi.fn() },
  recentAuth: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/session-guards", () => guards);
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: recentAuth }));
vi.mock("@/lib/rate-limit", () => ({
  ...limits,
  getClientIp: () => "203.0.113.9",
  rateLimitedResponse: () => new Response(null, { status: 429 }),
  rateLimiters: new Proxy({}, { get: (_target, name) => String(name) }),
}));
// Any database access at all is recorded, whichever model or method.
vi.mock("@/lib/prisma", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method === "symbol" || method === "then"
            ? undefined
            : () => {
                touched.push(`${name}.${String(method)}`);
                return Promise.resolve(null);
              },
      },
    );
  return {
    prisma: new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === "symbol" || name === "then" ? undefined : model(String(name)),
      },
    ),
  };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (location: string) => {
    throw new Error(`NEXT_REDIRECT ${location}`);
  },
}));

import { FEATURE_ROUTE_RULES, getDisabledFeatureForPath } from "@/config/feature-routes";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { walkDir } from "@/lib/step-up-route-census-ast";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const allOn = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as FeatureFlags;
const mcpOff = { ...allOn, mcpServer: false } as FeatureFlags;

const mcpRule = FEATURE_ROUTE_RULES.find(
  (rule) => rule.flag === "mcpServer" && rule.prefixes?.includes("/api/mcp"),
);
const mcpPrefixes = mcpRule?.prefixes ?? [];

/** The address a file under `src/app` answers, with a sample value for each dynamic segment. */
function urlPathOf(file: string): string {
  const segments = file
    .replace(/^src\/app/, "")
    .replace(/\/(route\.ts|page\.tsx)$/, "")
    .split("/")
    .filter((segment) => segment !== "")
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .filter((segment) => !/^\[\[\.\.\..+\]\]$/.test(segment))
    .map((segment) => (/^\[.+\]$/.test(segment) ? "sample-id" : segment));
  return `/${segments.join("/")}`;
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function allRouteFiles(): string[] {
  const found = new Set<string>();
  walkDir("src/app", found);
  return [...found].sort();
}

/** Every route the module adds: under one of its prefixes, or built on `@/lib/mcp`. */
const mcpRouteFiles = allRouteFiles().filter(
  (file) =>
    mcpPrefixes.some((prefix) => underPrefix(urlPathOf(file), prefix)) ||
    readFileSync(file, "utf8").includes("@/lib/mcp/"),
);

const MCP_PAGES = [
  "src/app/(authenticated)/connect/authorize/page.tsx",
  "src/app/(admin)/admin/system/ai-connections/page.tsx",
];

function requestFor(file: string, method: string): Request {
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://club.example.test${urlPathOf(file)}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer some-token" },
    body: hasBody ? JSON.stringify({ decision: "approve" }) : undefined,
  });
}

const context = { params: Promise.resolve({ id: "grant-1", path: ["api", "mcp"] }) };

beforeEach(() => {
  touched.length = 0;
  modules.mockResolvedValue(mcpOff);
  auth.mockResolvedValue({ user: { id: "member-1", role: "ADMIN" } });
  guards.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  guards.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  guards.requireActiveSessionUser.mockResolvedValue(null);
  limits.applyRateLimit.mockResolvedValue(null);
  limits.checkRateLimit.mockResolvedValue({ success: true });
  recentAuth.mockResolvedValue({ ok: true });
});

function expectNoWork() {
  expect(touched).toEqual([]);
  expect(auth).not.toHaveBeenCalled();
  expect(guards.requireActiveSession).not.toHaveBeenCalled();
  expect(guards.requireActiveSessionUser).not.toHaveBeenCalled();
  expect(guards.requireAdmin).not.toHaveBeenCalled();
  expect(limits.applyRateLimit).not.toHaveBeenCalled();
  expect(limits.checkRateLimit).not.toHaveBeenCalled();
  expect(recentAuth).not.toHaveBeenCalled();
}

describe("the mcpServer module's routes are discovered (INV-MCP-001)", () => {
  it("finds the module's rule and every route it added", () => {
    expect(mcpRule).toBeDefined();
    // The discovery is not vacuous: each route ALP-653 shipped is in it.
    expect(mcpRouteFiles).toEqual(
      expect.arrayContaining([
        "src/app/.well-known/oauth-authorization-server/route.ts",
        "src/app/.well-known/oauth-protected-resource/[[...path]]/route.ts",
        "src/app/api/admin/mcp/grants/[id]/route.ts",
        "src/app/api/admin/mcp/grants/route.ts",
        "src/app/api/admin/mcp/settings/route.ts",
        "src/app/api/mcp/oauth/register/route.ts",
        "src/app/api/mcp/oauth/revoke/route.ts",
        "src/app/api/mcp/oauth/token/route.ts",
        "src/app/api/mcp/route.ts",
        "src/app/api/member/mcp-grants/[id]/route.ts",
        "src/app/api/member/mcp-grants/route.ts",
      ]),
    );
  });

  it("puts every route and page under the module's proxy rule", () => {
    const paths = [
      ...mcpRouteFiles.map(urlPathOf),
      ...MCP_PAGES.map(urlPathOf),
      // The protected-resource metadata is also asked for path-suffixed (RFC 9728).
      "/.well-known/oauth-protected-resource/api/mcp",
      // The admin page's pre-hub address.
      "/admin/ai-connections",
    ];
    for (const path of paths) {
      expect(getDisabledFeatureForPath(path, mcpOff), path).toBe("mcpServer");
      expect(getDisabledFeatureForPath(path, allOn), path).toBeNull();
    }
  });
});

describe("every route handler answers 404 and does nothing with the module off", () => {
  const cases = mcpRouteFiles.map((file) => [file] as const);

  it.each(cases)("%s", async (file) => {
    const routeModule = (await import(/* @vite-ignore */ resolve(file))) as Record<string, unknown>;
    const methods = HTTP_METHODS.filter((method) => typeof routeModule[method] === "function");
    expect(methods.length, file).toBeGreaterThan(0);

    for (const method of methods) {
      const request = requestFor(file, method);
      const handler = routeModule[method] as (
        request: Request,
        context: unknown,
      ) => Promise<Response>;
      const response = await handler(request, context);
      expect(response.status, `${method} ${file}`).toBe(404);
      expect(await response.json(), `${method} ${file}`).toEqual({ error: "Not found" });
      expect(request.bodyUsed, `${method} ${file} read the body`).toBe(false);
      expectNoWork();
    }
  });
});

describe("the pages with the module off", () => {
  it("the approval screen is not found, and checks no app and no member", async () => {
    const { default: ConnectAuthorizePage } = await import(
      "@/app/(authenticated)/connect/authorize/page"
    );
    await expect(
      ConnectAuthorizePage({
        searchParams: Promise.resolve({ client_id: "client-1", redirect_uri: "https://claude.ai/cb" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(touched).toEqual([]);
  });

  it("the admin page relies on the proxy rule its hub entry generates", () => {
    expect(getDisabledFeatureForPath("/admin/system/ai-connections", mcpOff)).toBe("mcpServer");
    expect(getDisabledFeatureForPath("/admin/system/ai-connections/", mcpOff)).toBe("mcpServer");
    expect(getDisabledFeatureForPath("/admin/system/ai-connections.rsc", mcpOff)).toBe(
      "mcpServer",
    );
  });
});
