import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Admin page URLs are served only at their exact spelling (epic #4468, C4
// #4801). Next matches a moved page's `beforeFiles` rewrite without regard to
// letter case, while the proxy, the module gate and the layout guard decide on
// the path as written (escaped spellings are refused too, as a precaution).
// So the proxy answers a registered page's old or hub path spelled any other
// way with the same 404 a missing page gets, before anything reads the path.
// `isInexactAdminPagePath` is the rule; `admin-hubs-registry.test.ts` holds
// its cases, and `next-config-admin-hub-urls.test.ts` shows the rewrite that
// makes it load-bearing.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  themeState: vi.fn(),
  clubIdentity: vi.fn(),
  emailSettings: vi.fn(),
  moduleFlags: vi.fn(),
}));

vi.mock("@/lib/club-theme", () => ({ getWebsiteThemeRenderState: mocks.themeState }));
vi.mock("@/lib/club-identity-settings", () => ({ getClubIdentity: mocks.clubIdentity }));
vi.mock("@/lib/email-message-settings", () => ({
  loadEmailMessageSettings: mocks.emailSettings,
}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: mocks.moduleFlags }));

import { MODULE_KEYS } from "@/config/modules";
import { CSP_HEADER } from "@/lib/csp";
import { resetSetupGateCache } from "@/lib/setup-gate";
import { ADMIN_PAGES } from "@/lib/admin-hubs";
import proxy from "@/proxy";

function request(url: string, method = "GET") {
  return new NextRequest(`https://example.org${url}`, { method });
}

const concrete = (registryPath: string) => registryPath.replace(/\[[^\]/]+\]/g, "x123");

/** Every static segment below `/admin` capitalised. */
const capitalised = (registryPath: string) =>
  concrete(registryPath)
    .split("/")
    .map((segment, index) =>
      index < 2 || segment === "x123" ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("/");

const MOVED = ADMIN_PAGES.filter((page) => page.moved);

beforeEach(() => {
  vi.clearAllMocks();
  resetSetupGateCache();
  mocks.themeState.mockResolvedValue({ isComplete: true, css: "" });
  mocks.clubIdentity.mockResolvedValue({ name: "Example Alpine Club" });
  mocks.emailSettings.mockResolvedValue({
    clubName: "Example Alpine Club",
    contactEmail: "office@example.org",
  });
  mocks.moduleFlags.mockResolvedValue(Object.fromEntries(MODULE_KEYS.map((key) => [key, true])));
});

describe("the proxy serves admin pages only at their exact spelling", () => {
  it("PREMISE: pages have moved, and the request path reaches the proxy as written", () => {
    expect(MOVED.length).toBeGreaterThan(0);
    expect(request("/admin/Site%2Dstyle").nextUrl.pathname).toBe("/admin/Site%2Dstyle");
  });

  it.each(MOVED.map((page) => [page.id, page.oldPath, page.hubPath]))(
    "passes %s at its old URL %s, and refuses it respelled at either path",
    async (_id, oldPath, hubPath) => {
      const exact = await proxy(request(oldPath));
      expect(exact.status).toBe(200);
      expect(exact.headers.get("x-middleware-next")).toBe("1");

      for (const url of [
        capitalised(oldPath),
        capitalised(hubPath),
        oldPath.toUpperCase(),
        `${oldPath.slice(0, -1)}%${oldPath.charCodeAt(oldPath.length - 1).toString(16).toUpperCase()}`,
      ]) {
        const response = await proxy(request(`${url}?tab=x`));
        expect(response.status, url).toBe(404);
        expect(response.headers.get("x-middleware-next"), url).toBeNull();
        expect(await response.text(), url).toContain("Page not found");
        expect(response.headers.get(CSP_HEADER), url).toBeTruthy();
      }
    },
  );

  it("refuses every registered page, moved or not, respelled; other verbs get the empty 404", async () => {
    const passed: string[] = [];
    for (const page of ADMIN_PAGES) {
      for (const url of [capitalised(page.oldPath), capitalised(page.hubPath)]) {
        if ((await proxy(request(url))).status !== 404) passed.push(url);
      }
    }
    expect(passed).toEqual([]);
    const post = await proxy(request("/admin/Site-Style", "POST"));
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("");
  });

  it("passes a dynamic segment of any spelling, and an unregistered path, to the app", async () => {
    for (const url of ["/admin/members/AbC%20D", "/admin/xero/records/Booking/b-1", "/admin/Nope"]) {
      const response = await proxy(request(url));
      expect(response.headers.get("x-middleware-next"), url).toBe("1");
    }
  });
});
