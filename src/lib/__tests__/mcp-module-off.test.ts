/**
 * The `mcpServer` module switched off (ALP-653, `INV-MCP-001`).
 *
 * Every route and page the module adds answers as if it did not exist, and
 * does no work first: no session read, no rate-limit count, no database
 * access, no request body read. The route files are discovered from disk, so
 * a route added later under one of the module's prefixes, or one that reaches
 * into `@/lib/mcp`, is held to the same rule without anyone listing it here.
 *
 * The member reads the module added beside older routes (`MCP_READ_HANDLERS`)
 * cannot sit under a proxy prefix, so the handler's own check is their gate
 * and only the method the module added is held to it.
 *
 * The admin page has no gate of its own: like every admin page since #4799 it
 * is gated by the proxy rule its hub registry entry's `mcpServer` flag
 * generates, and its data comes only through the API routes gated below.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// The original's pure helpers stay: the roster loader's imports read them at
// module scope. Only the flag read is replaced.
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: modules,
}));
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
// The older DELETE beside `GET /api/bookings/[id]` pulls in the whole booking
// engine, none of which the read uses.
vi.mock("@/lib/booking-delete", () => ({ deleteBooking: vi.fn() }));
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
import { MCP_ACTIONS, mcpActionRouteFile } from "@/lib/mcp/catalogue";
import { walkDir } from "@/lib/step-up-route-census-ast";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

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

/**
 * The member reads ALP-653 added for an AI app action to call. Each sits in or
 * beside a route that is older than the module, so it names the one method
 * the module owns.
 */
const MCP_READ_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  "src/app/api/bookings/[id]/route.ts": ["GET"],
  "src/app/api/bookings/mine/route.ts": ["GET"],
  // ALP-718: the roster page's loader and one notice, for `get_lodge_roster`
  // and `get_notice`.
  "src/app/api/lodge-roster/route.ts": ["GET"],
  "src/app/api/notices/[id]/route.ts": ["GET"],
  "src/app/api/notices/route.ts": ["GET"],
  "src/app/api/profile/summary/route.ts": ["GET"],
  // ALP-796: the dashboard card's loader, for `list_work_parties`.
  "src/app/api/work-parties/route.ts": ["GET"],
};

/**
 * Catalogued action routes no website page calls that are nonetheless not the
 * module's: each is older than it, so switching the module off must leave it
 * as it was. Shrinks only; a new entry needs a reason a reviewer accepts.
 */
const PRE_MODULE_ROUTES_WITHOUT_WEBSITE_CALLER: Readonly<Record<string, string>> = {
  "src/app/api/bookings/drafts/route.ts":
    "draft bookings (Issue 7, April 2026), long before the module; its website caller has since gone",
  "src/app/api/admin/booking-requests/[id]/price/route.ts":
    "officer pricing of a booking request (#733, June 2026), long before the module; the quote workflow replaced its website caller",
};

/**
 * The website files a catalogued path could be called from: everything under
 * `src` but the API routes themselves, the module's own code, tests, and the
 * proxy and route-flag tables that name a path without calling it.
 */
function websiteSources(): ReadonlyArray<readonly [string, string]> {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) {
        if (entry !== "__tests__") walk(path);
      } else if (/\.tsx?$/.test(entry)) {
        found.push(path);
      }
    }
  };
  walk("src");
  return found
    .filter(
      (file) =>
        !file.startsWith("src/app/api/") &&
        !file.startsWith("src/lib/mcp/") &&
        !file.startsWith("src/config/") &&
        file !== "src/proxy.ts" &&
        !/\.test\.tsx?$/.test(file),
    )
    .map((file) => [file, readFileSync(file, "utf8")] as const);
}

/**
 * Whether any website file spells `path` as a string or template literal, a
 * dynamic segment matching an interpolation or a literal value. Per path, not
 * per method: a website caller of one method counts for every method.
 */
function hasWebsiteCaller(
  path: string,
  sources: ReadonlyArray<readonly [string, string]>,
): boolean {
  const body = path
    .split("/")
    .map((segment) =>
      /^\[.+\]$/.test(segment)
        ? "(?:\\$\\{[^}]+\\}|[^\"'`/?]+)"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  const pattern = new RegExp(`["'\`]${body}(?:["'\`?]|\\$\\{)`);
  return sources.some(([, text]) => pattern.test(text));
}

function underMcpPrefix(file: string): boolean {
  return mcpPrefixes.some((prefix) => underPrefix(urlPathOf(file), prefix));
}

/** Every route the module adds: under one of its prefixes, or built on `@/lib/mcp`. */
const mcpRouteFiles = allRouteFiles().filter(
  (file) => underMcpPrefix(file) || readFileSync(file, "utf8").includes("@/lib/mcp/"),
);
/** The ones the proxy rule covers whole, whatever the method. */
const mcpPrefixedRouteFiles = mcpRouteFiles.filter(underMcpPrefix);

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

const context = { params: Promise.resolve({ id: "grant-1" }) };

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

describe("the mcpServer module's routes are discovered (INV-MCP-001)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("finds the module's rule and every route it added", () => {
    expect(mcpRule).toBeDefined();
    // The discovery is not vacuous: each route ALP-653 shipped is in it.
    expect(mcpRouteFiles).toEqual(
      expect.arrayContaining([
        "src/app/.well-known/oauth-authorization-server/route.ts",
        "src/app/.well-known/oauth-protected-resource/api/mcp/route.ts",
        "src/app/.well-known/oauth-protected-resource/route.ts",
        "src/app/api/admin/mcp/grants/[id]/route.ts",
        "src/app/api/admin/mcp/grants/route.ts",
        "src/app/api/admin/mcp/settings/route.ts",
        "src/app/api/mcp/oauth/register/route.ts",
        "src/app/api/mcp/oauth/revoke/route.ts",
        "src/app/api/mcp/oauth/token/route.ts",
        "src/app/api/mcp/route.ts",
        "src/app/api/member/mcp-grants/[id]/route.ts",
        "src/app/api/member/mcp-grants/route.ts",
        ...Object.keys(MCP_READ_HANDLERS),
      ]),
    );
  });

  it("lists every route built on the module that no proxy prefix covers", () => {
    // A new one must say which of its methods the module owns.
    expect(mcpRouteFiles.filter((file) => !underMcpPrefix(file))).toEqual(
      Object.keys(MCP_READ_HANDLERS).sort(),
    );
  });

  it("gates every catalogued action route no website page calls (ALP-796 review)", () => {
    // Discovery by `@/lib/mcp/` import misses a read built only on
    // `@/lib/mcp-connection-request`, so the catalogue is read directly: a
    // route that exists for an AI app alone must be held to the module switch.
    const sources = websiteSources();
    // The scan is not blind either way.
    expect(hasWebsiteCaller("/api/club-posts", sources)).toBe(true);
    expect(hasWebsiteCaller("/api/bookings/[id]/cancel", sources)).toBe(true);
    expect(hasWebsiteCaller("/api/profile/summary", sources)).toBe(false);

    const ungated = MCP_ACTIONS.filter((action) => !hasWebsiteCaller(action.path, sources))
      .map((action) => ({ file: mcpActionRouteFile(action), method: action.method }))
      .filter(
        ({ file, method }) =>
          !(MCP_READ_HANDLERS[file]?.includes(method) ?? false) &&
          !(file in PRE_MODULE_ROUTES_WITHOUT_WEBSITE_CALLER),
      );
    expect(ungated).toEqual([]);
    for (const file of Object.keys(PRE_MODULE_ROUTES_WITHOUT_WEBSITE_CALLER)) {
      expect(mcpRouteFiles, `${file} is the module's now: list it above`).not.toContain(file);
    }
  });

  it("serves the metadata address the endpoint's 401 names, with the bare path's handler (RFC 9728)", async () => {
    const { mcpProtectedResourceMetadataUrl } = await import("@/lib/mcp/oauth");
    const named = new URL(mcpProtectedResourceMetadataUrl()).pathname;
    expect(mcpRouteFiles.map(urlPathOf)).toContain(named);

    const bare = await import("@/app/.well-known/oauth-protected-resource/route");
    const suffixed = await import("@/app/.well-known/oauth-protected-resource/api/mcp/route");
    expect(suffixed.GET).toBe(bare.GET);
  });

  it("puts every route and page under the module's proxy rule", () => {
    const paths = [
      ...mcpPrefixedRouteFiles.map(urlPathOf),
      ...MCP_PAGES.map(urlPathOf),
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
    const methods = HTTP_METHODS.filter(
      (method) =>
        typeof routeModule[method] === "function" &&
        (MCP_READ_HANDLERS[file]?.includes(method) ?? true),
    );
    expect(methods.length, file).toBe(MCP_READ_HANDLERS[file]?.length ?? methods.length);
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
