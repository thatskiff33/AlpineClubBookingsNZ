/**
 * ALP-653: `servingMcpConnection` decides, for a route handler with no
 * `request` argument, whether the request being served is an AI app
 * connection. Presence of the internal principal header is enough; outside a
 * request (no headers to read) it is not a connection.
 *
 * ALP-718: `memberOnlySessionUser` is the session a route decides with, and
 * `connectionJson` the answer it sends; both differ only for a connection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: h.headers }));

import type { Session } from "next-auth";

import { hasAdminAccess } from "@/lib/access-roles";
import {
  ADMIN_PERMISSION_AREAS,
  bookingManagementAuthorizationRole,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";
import {
  connectionJson,
  memberOnlySessionUser,
  servingMcpConnection,
} from "@/lib/mcp-connection-request";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { isOrganisationAccount } from "@/lib/organisation-account";

function connectionRequest(): Request {
  return new Request("https://club.example.test/api/x", {
    headers: { [MCP_PRINCIPAL_HEADER]: "anything" },
  });
}

beforeEach(() => {
  h.headers.mockReset();
});

describe("servingMcpConnection", () => {
  it("is true when the principal header is present", async () => {
    h.headers.mockResolvedValue(new Headers({ [MCP_PRINCIPAL_HEADER]: "anything" }));
    await expect(servingMcpConnection()).resolves.toBe(true);
  });

  it("is false for a browser request without it", async () => {
    h.headers.mockResolvedValue(new Headers({ cookie: "session=1" }));
    await expect(servingMcpConnection()).resolves.toBe(false);
  });

  it("is false outside a request, where reading headers throws", async () => {
    h.headers.mockRejectedValue(new Error("headers was called outside a request scope"));
    await expect(servingMcpConnection()).resolves.toBe(false);
  });
});

describe("memberOnlySessionUser (ALP-718)", () => {
  const officer = {
    id: "officer-1",
    email: "officer@example.test",
    name: "Olive Officer",
    role: "ADMIN",
    accessRoles: ["USER", "ADMIN", "ADMIN_BOOKINGS"],
    canLogin: true,
    adminPermissionMatrix: Object.fromEntries(ADMIN_PERMISSION_AREAS.map((area) => [area.key, "edit"])),
    forcePasswordChange: false,
    isEmailVerified: true,
  } as unknown as Session["user"];

  it("takes every officer power from a connection, keeping the member", () => {
    const user = memberOnlySessionUser(connectionRequest(), officer);
    expect(user.id).toBe("officer-1");
    expect(user.role).toBe("USER");
    expect(user.accessRoles).toEqual(["USER"]);
    expect(hasAdminAccess(officer)).toBe(true);
    expect(hasAdminAccess(user)).toBe(false);
    expect(bookingManagementAuthorizationRole(user)).toBe("USER");
    for (const { key } of ADMIN_PERMISSION_AREAS) {
      expect(hasAdminAreaAccess(officer, { area: key, level: "edit" }), key).toBe(true);
      expect(hasAdminAreaAccess(user, { area: key, level: "view" }), key).toBe(false);
    }
  });

  it("keeps the member role whichever shape the role assignments take, and no other", () => {
    const assigned = { ...officer, accessRoles: [{ role: "USER" }, { role: "ADMIN" }] } as unknown as Session["user"];
    expect(memberOnlySessionUser(connectionRequest(), assigned).accessRoles).toEqual(["USER"]);
    const adminOnly = { ...officer, accessRoles: ["ADMIN"] } as unknown as Session["user"];
    expect(memberOnlySessionUser(connectionRequest(), adminOnly).accessRoles).toEqual([]);
  });

  it("keeps an organisation an organisation, so its connection is refused what the account is (ALP-796)", () => {
    const organisation = { ...officer, role: "USER", accessRoles: ["ORG", "ADMIN"] } as unknown as Session["user"];
    const user = memberOnlySessionUser(connectionRequest(), organisation);
    expect(user.accessRoles).toEqual(["ORG"]);
    expect(user.role).toBe("SCHOOL");
    expect(isOrganisationAccount(user)).toBe(true);
    expect(hasAdminAccess(user)).toBe(false);

    const legacySchool = { ...officer, role: "SCHOOL", accessRoles: [] } as unknown as Session["user"];
    expect(isOrganisationAccount(memberOnlySessionUser(connectionRequest(), legacySchool))).toBe(true);
    expect(isOrganisationAccount(memberOnlySessionUser(connectionRequest(), officer))).toBe(false);
  });

  it("leaves a browser's session user exactly as it is", () => {
    expect(memberOnlySessionUser(new Request("https://club.example.test/api/x"), officer)).toBe(officer);
  });
});

describe("connectionJson (ALP-718)", () => {
  const body = { id: "n1", title: "Hut working bee", internal: "officer note" };

  it("sends a connection only the fields its action returns", async () => {
    const res = connectionJson(connectionRequest(), body, { id: true, title: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "n1", title: "Hut working bee" });
  });

  it("sends a browser the whole answer", async () => {
    const res = connectionJson(new Request("https://club.example.test/api/x"), body, { id: true });
    expect(await res.json()).toEqual(body);
  });

  it("passes a refusal through unchanged, so the app can read why", async () => {
    const refusal = { error: "Validation failed", details: { firstName: ["Required"] } };
    const res = connectionJson(connectionRequest(), refusal, { id: true }, { status: 422 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refusal);
  });
});
