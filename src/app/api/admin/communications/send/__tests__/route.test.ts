import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The bulk-communication count and send share one recipient query (#4964,
  INV-SSOT). The count is what the officer confirms; the send is what goes out.
  This file proves, against an in-memory member table that really applies the
  `where` clause, that the two agree for every audience the page offers, and
  that the count never touches the hourly quota while the send still spends it.
  The permission each verb asks for is pinned in
  `finance-support-comms-action-route-guards.test.ts`.
*/

type FakeMember = {
  id: string;
  email: string;
  active: boolean;
  role: string;
  notificationPreference: { marketingEmails: boolean } | null;
};

const h = vi.hoisted(() => ({
  members: [] as FakeMember[],
  checkRateLimit: vi.fn(),
  sendEmail: vi.fn(),
  logAudit: vi.fn(),
}));

function matches(member: FakeMember, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = member[key as keyof FakeMember];
    if (condition && typeof condition === "object" && "in" in condition) {
      return (condition as { in: unknown[] }).in.includes(value);
    }
    return value === condition;
  });
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "admin-1" } },
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          h.members
            .filter((m) => matches(m, where))
            .map(({ id, email, notificationPreference }) => ({
              id,
              email,
              notificationPreference,
            })),
      ),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock("@/lib/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/email-theme", () => ({
  renderEmailHtml: vi.fn(async () => "<p>html</p>"),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { legacyRoleFromAccessRoles } from "@/lib/access-roles";
import { MEMBER_LEVEL_ROLE_VALUES } from "@/lib/member-roles";
import { GET, POST } from "../route";

const URL_BASE = "http://localhost/api/admin/communications/send";

function member(
  id: string,
  role: string,
  marketingEmails: boolean | null,
  active = true,
): FakeMember {
  return {
    id,
    email: `${id}@example.test`,
    active,
    role,
    notificationPreference:
      marketingEmails === null ? null : { marketingEmails },
  };
}

function countRequest(query: string) {
  return new NextRequest(`${URL_BASE}${query}`);
}

function sendRequest(recipientFilter: string) {
  return new NextRequest(URL_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: "Lodge closed", body: "Snow.", recipientFilter }),
  });
}

beforeEach(() => {
  h.members = [
    member("user-in", "USER", true),
    member("user-out", "USER", false),
    member("user-no-pref", "USER", null),
    member("user-inactive", "USER", true, false),
    member("admin-in", "ADMIN", true),
    member("admin-out", "ADMIN", false),
    member("lodge-in", "LODGE", true),
    member("school-in", "SCHOOL", true),
  ];
  h.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() });
  h.sendEmail.mockResolvedValue(undefined);
});

describe("GET /api/admin/communications/send recipient count (#4964)", () => {
  it.each([
    ["all", 4, 7],
    ["members-only", 1, 3],
    ["admins-only", 1, 2],
  ])(
    "counts %s the same as the send selects",
    async (recipientFilter, eligible, total) => {
      const countRes = await GET(
        countRequest(`?recipientFilter=${recipientFilter}`),
      );
      expect(countRes.status).toBe(200);
      const count = await countRes.json();
      expect(count).toMatchObject({
        recipientFilter,
        eligibleRecipients: eligible,
        totalRecipients: total,
      });

      const sendRes = await POST(sendRequest(recipientFilter));
      expect(sendRes.status).toBe(200);
      const sent = await sendRes.json();
      expect(sent.eligibleRecipients).toBe(count.eligibleRecipients);
      expect(sent.totalRecipients).toBe(count.totalRecipients);
    },
  );

  it("never touches the hourly quota, however often it is read", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await GET(countRequest("?recipientFilter=all"));
      expect(res.status).toBe(200);
    }
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("returns counts only, never addresses", async () => {
    const res = await GET(countRequest("?recipientFilter=all"));
    expect(JSON.stringify(await res.json())).not.toContain("@example.test");
  });

  it("still returns just the rate limit without a filter", async () => {
    const res = await GET(countRequest(""));
    const body = await res.json();
    expect(body).toEqual({ limit: expect.any(Number), windowSeconds: 3600 });
  });

  it.each(["custom", "everyone"])(
    "rejects the %s filter, which the count does not offer",
    async (recipientFilter) => {
      const res = await GET(countRequest(`?recipientFilter=${recipientFilter}`));
      expect(res.status).toBe(400);
    },
  );
});

describe("POST /api/admin/communications/send", () => {
  it("still spends the hourly quota on every send", async () => {
    await POST(sendRequest("all"));
    expect(h.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("keeps the custom filter working through the shared query", async () => {
    const res = await POST(
      new NextRequest(URL_BASE, {
        method: "POST",
        body: JSON.stringify({
          subject: "Hi",
          body: "There",
          recipientFilter: "custom",
          memberIds: ["user-in", "user-out", "user-inactive"],
        }),
      }),
    );
    expect(await res.json()).toMatchObject({
      totalRecipients: 2,
      eligibleRecipients: 1,
    });
  });

  it("rejects the custom filter without memberIds", async () => {
    const res = await POST(
      new NextRequest(URL_BASE, {
        method: "POST",
        body: JSON.stringify({
          subject: "Hi",
          body: "There",
          recipientFilter: "custom",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("audience wording (#4964)", () => {
  // The page's `AUDIENCES` descriptions, the Audiences table in
  // docs/guides/communications.md and the changelog fragment say in words who
  // each audience reaches. A client page cannot import the server-only recipient
  // query, so this pins the role facts those words rest on: if it fails, change
  // the words in those three places together with the query.
  it("keeps the role scope the page and guide describe", () => {
    // Members Only reaches these roles and nothing else.
    expect([...MEMBER_LEVEL_ROLE_VALUES]).toEqual(["USER"]);
    // Member.role is ADMIN only for the Full Admin access role, with or
    // without the member token; other admin roles leave it USER, so Members
    // Only reaches them and Admins Only does not.
    expect(legacyRoleFromAccessRoles(["ADMIN"])).toBe("ADMIN");
    expect(legacyRoleFromAccessRoles(["ADMIN", "USER"])).toBe("ADMIN");
    expect(
      legacyRoleFromAccessRoles(["ADMIN_MEMBERSHIP", "FINANCE_ADMIN"]),
    ).toBe("USER");
  });
});
