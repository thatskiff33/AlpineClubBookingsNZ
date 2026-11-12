/**
 * POST /api/admin/menu-role (C14 #4811).
 *
 * While hubs are off the route is a 404 before authentication. While they are
 * on it stores only a menu role the caller actually holds, and the cookie is
 * a preference: HttpOnly, SameSite=Lax, Path=/admin, no Max-Age.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  live: false,
}));

vi.mock("@/lib/admin-hubs/release", () => ({
  get ADMIN_HUBS_LIVE() {
    return mocks.live;
  },
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.findUnique } },
}));

import { DELETE, GET, POST } from "@/app/api/admin/menu-role/route";
import { ADMIN_MENU_ROLE_COOKIE } from "@/lib/admin-menu-role";
import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";

const treasurerDefinition = DEFAULT_ACCESS_ROLE_DEFINITIONS.find(
  (row) => row.systemRole === "FINANCE_ADMIN",
);

function treasurerMember() {
  return {
    canLogin: true,
    accessRoles: [
      { role: "FINANCE_ADMIN", roleDefinition: treasurerDefinition },
    ],
  };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/menu-role", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function admit() {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
}

beforeEach(() => {
  mocks.live = false;
  mocks.requireAdmin.mockReset();
  mocks.findUnique.mockReset();
});

describe("POST /api/admin/menu-role", () => {
  it("answers 404 before authentication while hubs are off", async () => {
    const response = await POST(post({ role: "FINANCE_ADMIN" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("404s a non-POST method before authentication while hubs are off", async () => {
    expect((await GET()).status).toBe(404);
    expect((await DELETE()).status).toBe(404);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it("refuses a non-admin through requireAdmin and sets nothing", async () => {
    mocks.live = true;
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden });

    const response = await POST(post({ role: "FINANCE_ADMIN" }));
    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: "any-admin" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("sets the cookie for a role the member holds", async () => {
    mocks.live = true;
    admit();
    mocks.findUnique.mockResolvedValue(treasurerMember());

    const response = await POST(post({ role: "FINANCE_ADMIN" }));
    expect(response.status).toBe(200);
    const cookie = response.cookies.get(ADMIN_MENU_ROLE_COOKIE);
    expect(cookie?.value).toBe("FINANCE_ADMIN");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/admin");
    expect(cookie?.secure).toBe(false);
    expect(cookie?.maxAge).toBeUndefined();
  });

  it("refuses a role the member does not hold and sets nothing", async () => {
    mocks.live = true;
    admit();
    mocks.findUnique.mockResolvedValue(treasurerMember());

    const response = await POST(post({ role: "ADMIN_BOOKINGS" }));
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("clears the cookie when role is null", async () => {
    mocks.live = true;
    admit();
    mocks.findUnique.mockResolvedValue(treasurerMember());

    const response = await POST(post({ role: null }));
    expect(response.status).toBe(200);
    const cookie = response.cookies.get(ADMIN_MENU_ROLE_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.path).toBe("/admin");
    expect(cookie?.httpOnly).toBe(true);
  });

  it("rejects a malformed body", async () => {
    mocks.live = true;
    admit();
    const response = await POST(post({ role: "" }));
    expect(response.status).toBe(400);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("marks the cookie Secure in production", async () => {
    mocks.live = true;
    admit();
    mocks.findUnique.mockResolvedValue(treasurerMember());
    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await POST(post({ role: "FINANCE_ADMIN" }));
      expect(response.cookies.get(ADMIN_MENU_ROLE_COOKIE)?.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers 405 after any-admin for a non-POST method while hubs are on", async () => {
    mocks.live = true;
    admit();
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: "any-admin" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
