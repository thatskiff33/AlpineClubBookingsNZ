/**
 * ALP-718 (`INV-MCP-006`): the "my account" actions an AI app connection may
 * run, each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also an
 *   officer (`officerMemberSession`);
 * - the browser's answer is unchanged.
 *
 * Each withheld-field assertion names the bug it catches: a field the
 * website's answer carries reaching the AI provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getNoticeForMember: vi.fn(),
  listNoticesForMember: vi.fn(),
  buildMemberLodgeRoster: vi.fn(),
  modules: vi.fn(),
  prisma: {
    notificationPreference: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    noticeReadReceipt: { upsert: vi.fn() },
    auditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    member: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireActiveSession: vi.fn(async () => {
    const session = await h.auth();
    return { ok: true, session };
  }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: h.modules }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { api: { id: "api" } },
}));
// memberNoticeAsText stays real: both notice actions strip markup the same way.
vi.mock("@/lib/notices", () => ({
  getNoticeForMember: h.getNoticeForMember,
  listNoticesForMember: h.listNoticesForMember,
}));
vi.mock("@/lib/member-lodge-roster", () => ({ buildMemberLodgeRoster: h.buildMemberLodgeRoster }));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: vi.fn(async () => ({ dateFormat: "DMY", currency: "NZD", locale: "en-NZ" })),
}));
// The profile save's side effects that reach beyond the member row.
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/xero-contact-groups", () => ({ syncManagedXeroContactGroupForMember: vi.fn() }));
vi.mock("@/lib/xero-contacts", () => ({ updateXeroContact: vi.fn() }));
vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: vi.fn(),
  hasMemberXeroContactChanges: vi.fn(() => false),
  shouldRepairXeroContactNameOrder: vi.fn(async () => false),
}));
vi.mock("@/lib/member-email-inheritance", () => ({ reconcileEmailInheritanceForMemberChange: vi.fn() }));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi.fn(async () => ({ showOccupation: true, showDietaryRequirements: false })),
}));

import { GET as getRoster } from "@/app/api/lodge-roster/route";
import { GET as getAuditLog } from "@/app/api/member/audit-log/route";
import { GET as listNotices } from "@/app/api/notices/route";
import { GET as getNotice } from "@/app/api/notices/[id]/route";
import { POST as markNoticeRead } from "@/app/api/notices/[id]/read/route";
import { GET as getPrefs, PUT as putPrefs } from "@/app/api/notifications/preferences/route";
import { PUT as putProfile } from "@/app/api/profile/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { lodgeSession } from "@/lib/__tests__/helpers/sessions";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

const PREFS_ROW = {
  id: "pref-1",
  memberId: "officer-1",
  bookingConfirmation: true,
  bookingReminder: false,
  bookingBumped: true,
  bookingCancelled: true,
  bookingAddedByFamily: true,
  choreRoster: false,
  clubNotices: true,
  marketingEmails: false,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.modules.mockResolvedValue({ memberNotices: true, memberLodgeRoster: true, mcpServer: true });
  h.prisma.$transaction.mockImplementation(async (operation: unknown) =>
    Array.isArray(operation) ? Promise.all(operation) : (operation as (tx: unknown) => unknown)(h.prisma),
  );
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("get_my_notification_preferences and update_my_notification_preferences", () => {
  it("answers with the eight preferences and nothing from the row", async () => {
    h.prisma.notificationPreference.findUnique.mockResolvedValue(PREFS_ROW);
    const { connection, browser } = await expectActionContract({
      actionId: "get_my_notification_preferences",
      handler: getPrefs,
    });
    expect(connection).toEqual(browser);
    expect(allKeys(connection).has("memberId")).toBe(false);
    expect(h.prisma.notificationPreference.findUnique).toHaveBeenCalledWith({ where: { memberId: "officer-1" } });
  });

  // ALP-801: catches a read that creates the row, which let two first reads
  // race on the unique memberId and answer 500 (the race itself is proven in
  // notification-preferences-first-read.realdb.test.ts).
  it("answers a member with no saved row with the defaults and writes nothing", async () => {
    h.prisma.notificationPreference.findUnique.mockResolvedValue(null);
    const { connection } = await expectActionContract({
      actionId: "get_my_notification_preferences",
      handler: getPrefs,
    });
    const browser = await getPrefs(new Request("https://club.example.test/api/notifications/preferences"));
    // The exact bytes the website answered when this read created a row with
    // the schema defaults: same values, same key order.
    const browserText = await browser.text();
    expect(browserText).toBe(
      '{"bookingConfirmation":true,"bookingReminder":true,"bookingBumped":true,"bookingCancelled":true,' +
        '"bookingAddedByFamily":true,"choreRoster":true,"clubNotices":true,"marketingEmails":false}',
    );
    expect(connection).toEqual(JSON.parse(browserText));
    expect(h.prisma.notificationPreference.create).not.toHaveBeenCalled();
    expect(h.prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  it("changes only the preferences sent, for the member themselves", async () => {
    h.prisma.notificationPreference.findUnique.mockResolvedValue(PREFS_ROW);
    h.prisma.notificationPreference.upsert.mockResolvedValue({ ...PREFS_ROW, clubNotices: false });
    const { connection, browser } = await expectActionContract({
      actionId: "update_my_notification_preferences",
      handler: putPrefs,
      args: { clubNotices: false, marketingEmails: false },
    });
    const saved = {
      bookingConfirmation: true,
      bookingReminder: false,
      bookingBumped: true,
      bookingCancelled: true,
      bookingAddedByFamily: true,
      choreRoster: false,
      clubNotices: false,
      marketingEmails: false,
    };
    expect(connection).toEqual(saved);
    // The website is sent the same eight preferences, never the row's ids or dates.
    expect(browser).toEqual(saved);
    const upsert = h.prisma.notificationPreference.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ memberId: "officer-1" });
    expect(upsert.update).toEqual({ clubNotices: false, marketingEmails: false });
  });

  it("never lets a connection opt the member in to marketing email (INV-PRIV-026)", async () => {
    h.prisma.notificationPreference.findUnique.mockResolvedValue(PREFS_ROW);
    const action = findMcpAction("update_my_notification_preferences")!;
    expect(mcpActionInputSchema(action).safeParse({ marketingEmails: true }).success).toBe(false);
    // And the route refuses it from a connection, should anything else send it.
    const res = await putPrefs(
      new Request("https://club.example.test/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "p" },
        body: JSON.stringify({ marketingEmails: true }),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  it("keeps the website's marketing opt-in", async () => {
    h.prisma.notificationPreference.findUnique.mockResolvedValue(PREFS_ROW);
    h.prisma.notificationPreference.upsert.mockResolvedValue({ ...PREFS_ROW, marketingEmails: true });
    const res = await putPrefs(
      new Request("https://club.example.test/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketingEmails: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.prisma.notificationPreference.upsert.mock.calls[0][0].update).toEqual({ marketingEmails: true });
  });
});

describe("update_my_profile", () => {
  const stored = {
    id: "officer-1",
    canLogin: true,
    role: "ADMIN",
    accessRoles: [{ role: "USER" }, { role: "ADMIN" }],
    firstName: "Olive",
    lastName: "Officer",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "5550101",
    dateOfBirth: new Date("1980-02-03T00:00:00.000Z"),
    ageTier: "ADULT",
    occupation: "Engineer",
    lodgeScreenPhoneOptIn: false,
    email: "olive@example.test",
    xeroContactId: "xero-contact-1",
    streetAddressLine1: "1 Ridge Road",
    streetAddressLine2: null,
    streetCity: "Ohakune",
    streetRegion: "Manawatū-Whanganui",
    streetPostalCode: "4625",
    streetCountry: "NZ",
    postalAddressLine1: "PO Box 9",
    postalAddressLine2: null,
    postalCity: "Ohakune",
    postalRegion: "Manawatū-Whanganui",
    postalPostalCode: "4625",
    postalCountry: "NZ",
    profileCompletedAt: new Date("2025-01-01T00:00:00.000Z"),
  };

  beforeEach(() => {
    h.prisma.member.findUnique.mockResolvedValue(stored);
    h.prisma.member.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...stored,
      ...data,
    }));
  });

  const args = {
    firstName: "Olive",
    lastName: "Officer",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "5550199",
  };

  it("saves the member's own record and answers with the get_my_profile fields only", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "update_my_profile",
      handler: putProfile,
      args,
    });
    expect(connection).toMatchObject({ id: "officer-1", phoneNumber: "5550199" });
    for (const withheld of ["role", "accessRoles", "canLogin", "xeroContactId", "dateOfBirth", "occupation"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
    // The website's answer is the saved row, as before.
    expect(browser).toEqual(JSON.parse(JSON.stringify({ ...stored, phoneNumber: "5550199" })));
    for (const call of h.prisma.member.update.mock.calls) {
      expect(call[0].where).toEqual({ id: "officer-1" });
    }
  });

  it("keeps every stored field an app did not send", async () => {
    await expectActionContract({ actionId: "update_my_profile", handler: putProfile, args });
    const data = h.prisma.member.update.mock.calls[0][0].data as Record<string, unknown>;
    // Not read as missing: the stored values complete the profile. Only the
    // fields the app sent (and the always-saved name and phone) are written.
    expect(Object.keys(data).sort()).toEqual(Object.keys(args).sort());
  });

  it("copies the stored street address when an app sends only postalSameAsPhysical", async () => {
    await expectActionContract({
      actionId: "update_my_profile",
      handler: putProfile,
      args: { ...args, postalSameAsPhysical: true },
    });
    const data = h.prisma.member.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      postalAddressLine1: "1 Ridge Road",
      postalAddressLine2: null,
      postalCity: "Ohakune",
      postalRegion: "Manawatū-Whanganui",
      postalPostalCode: "4625",
      postalCountry: "NZ",
    });
    for (const street of ["streetAddressLine1", "streetCity", "dateOfBirth", "occupation"]) {
      expect(data, street).not.toHaveProperty(street);
    }
  });

  it("refuses a save that would leave the profile incomplete, and says which field", async () => {
    const request = new Request("https://club.example.test/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "p" },
      body: JSON.stringify({ ...args, phoneNumber: "" }),
    });
    const res = await putProfile(request as never);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ missingFields: ["phoneNumber"] });
    expect(h.prisma.member.update).not.toHaveBeenCalled();
  });

  it.each([
    ["dietary needs (INV-PRIV-022)", { dietaryRequirements: "Peanuts" }],
    ["the public lobby-screen phone opt-in", { lodgeScreenPhoneOptIn: true }],
  ])("refuses %s from a connection, which stay website-only", async (_label, extra) => {
    const offered = mcpActionInputSchema(findMcpAction("update_my_profile")!).shape;
    for (const field of Object.keys(extra)) expect(offered).not.toHaveProperty(field);
    // And the route refuses it from a connection, should anything else send it.
    const request = new Request("https://club.example.test/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "p" },
      body: JSON.stringify({ ...args, ...extra }),
    });
    const res = await putProfile(request as never);
    expect(res.status).toBe(422);
    // The refusal names the key, so the app can tell the member why.
    expect((await res.json()).formErrors).toEqual([expect.stringContaining(Object.keys(extra)[0])]);
    expect(h.prisma.member.update).not.toHaveBeenCalled();
  });
});

describe("list_notices, get_notice and mark_notice_read", () => {
  const notice = {
    id: "notice-1",
    title: "Working bee",
    bodyHtml: "<p>Bring <strong>gloves</strong>.</p>",
    publishedAt: "2026-06-30T00:00:00.000Z",
    expiresAt: null,
    pinned: true,
    requiresAcknowledgement: false,
    read: false,
    readAt: null,
    acknowledged: false,
    acknowledgedAt: null,
  };

  const { bodyHtml: _html, ...noticeFields } = notice;
  const noticeAsText = { ...noticeFields, body: "Bring gloves." };

  it("answers with one notice the member can see, its body as plain text", async () => {
    h.getNoticeForMember.mockResolvedValue(notice);
    const { connection, browser } = await expectActionContract({
      actionId: "get_notice",
      handler: getNotice,
      args: { id: "notice-1" },
    });
    expect(connection).toEqual({ notice: noticeAsText });
    expect(browser).toEqual({ notice: noticeAsText });
    expect(h.getNoticeForMember).toHaveBeenCalledWith("officer-1", "notice-1");
  });

  it("lists the member's notices with the same plain-text bodies as get_notice", async () => {
    // A field the loader might add later: the website would carry it, a connection never.
    h.listNoticesForMember.mockResolvedValue([{ ...notice, audienceSummary: "Committee: Treasurer" }]);
    const { connection, browser } = await expectActionContract({ actionId: "list_notices", handler: listNotices });
    expect(connection).toEqual({ notices: [noticeAsText] });
    expect(browser).toEqual({ notices: [{ ...noticeAsText, audienceSummary: "Committee: Treasurer" }] });
  });

  it("lists nothing for a kiosk-only account", async () => {
    h.auth.mockResolvedValue(lodgeSession());
    const res = await listNotices(new Request("https://club.example.test/api/notices"));
    expect(res.status).toBe(404);
    expect(h.listNoticesForMember).not.toHaveBeenCalled();
  });

  it("answers a notice outside the member's audience as not found", async () => {
    h.getNoticeForMember.mockResolvedValue(null);
    const res = await getNotice(new Request("https://club.example.test/api/notices/other"), {
      params: Promise.resolve({ id: "other" }),
    });
    expect(res.status).toBe(404);
  });

  it("is absent while notices are switched off", async () => {
    h.modules.mockResolvedValue({ memberNotices: false, mcpServer: true });
    const res = await getNotice(new Request("https://club.example.test/api/notices/notice-1"), {
      params: Promise.resolve({ id: "notice-1" }),
    });
    expect(res.status).toBe(404);
    expect(h.getNoticeForMember).not.toHaveBeenCalled();
  });

  it("is absent for a kiosk-only account, which never reaches the member notices page", async () => {
    h.auth.mockResolvedValue(lodgeSession());
    h.getNoticeForMember.mockResolvedValue(notice);
    for (const headers of [{}, { [MCP_PRINCIPAL_HEADER]: "p" }] as Record<string, string>[]) {
      const res = await getNotice(new Request("https://club.example.test/api/notices/notice-1", { headers }), {
        params: Promise.resolve({ id: "notice-1" }),
      });
      expect(res.status).toBe(404);
    }
    expect(h.getNoticeForMember).not.toHaveBeenCalled();
  });

  it("records the member's own read receipt", async () => {
    h.getNoticeForMember.mockResolvedValue(notice);
    const { connection, browser } = await expectActionContract({
      actionId: "mark_notice_read",
      handler: markNoticeRead,
      args: { id: "notice-1" },
    });
    expect(connection).toEqual({ ok: true });
    expect(browser).toEqual({ ok: true });
    expect(h.prisma.noticeReadReceipt.upsert.mock.calls[0][0].create).toEqual({
      noticeId: "notice-1",
      memberId: "officer-1",
    });
  });
});

describe("list_my_account_activity", () => {
  it("answers with when, what kind and what happened, from the member's own timeline", async () => {
    h.prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "log-1",
        action: "member.profile.updated",
        category: "account",
        severity: "important",
        outcome: "success",
        summary: "Member profile updated",
        description: null,
        details: null,
        metadata: JSON.stringify({ changedFields: ["phoneNumber"] }),
        createdAt: new Date("2026-06-30T00:00:00.000Z"),
        actorMemberId: "officer-1",
        subjectMemberId: "officer-1",
        entityType: "Member",
        entityId: "officer-1",
        memberId: "officer-1",
        requestId: "req-1",
        ipAddress: "203.0.113.9",
        userAgent: "Browser",
        retentionClass: null,
      },
    ]);
    h.prisma.auditLog.count.mockResolvedValue(1);
    h.prisma.member.findMany.mockResolvedValue([
      { id: "officer-1", firstName: "Olive", lastName: "Officer", email: "olive@example.test" },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_account_activity",
      handler: getAuditLog,
      args: { page: 1 },
    });
    for (const withheld of ["metadata", "ipAddress", "userAgent", "requestId", "actor", "drilldowns", "entityId"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
    // The website's timeline answer is unchanged: actor, subject, drilldowns and the category list.
    expect(browser).toEqual({
      data: [
        {
          id: "log-1",
          action: "member.profile.updated",
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Member profile updated",
          description: null,
          details: null,
          createdAt: "2026-06-30T00:00:00.000Z",
          actor: { id: "officer-1", firstName: "Olive", lastName: "Officer" },
          actorDisplayName: "You",
          subject: { id: "officer-1", firstName: "Olive", lastName: "Officer" },
          subjectDisplayName: "You",
          subjectMemberId: "officer-1",
          entityType: "Member",
          entityId: "officer-1",
          drilldowns: [],
          metadata: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      category: "all",
      categories: MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS,
    });
    // The member's own rows only: the where clause is built from their id.
    expect(JSON.stringify(h.prisma.auditLog.findMany.mock.calls[0][0].where)).toContain("officer-1");
  });
});

describe("get_lodge_roster", () => {
  it("answers with names and nights from the roster page's own loader", async () => {
    h.buildMemberLodgeRoster.mockResolvedValue({
      from: "2026-07-01",
      to: "2026-07-31",
      lodges: [
        {
          lodgeId: "lodge-1",
          lodgeName: "Main lodge",
          granularity: "FULL_NAME",
          people: [{ name: "Ana Reid", nights: ["2026-07-03"] }],
          groups: [{ label: "Family of 4", count: 4, nights: ["2026-07-04", "2026-07-05"] }],
          custodians: [{ name: null, nights: ["2026-07-01"] }],
          heldNights: ["2026-07-20"],
        },
      ],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "get_lodge_roster",
      handler: getRoster,
    });
    expect(browser).toEqual(connection);
    expect(h.buildMemberLodgeRoster).toHaveBeenCalledWith("officer-1");
  });

  it("is absent for a kiosk-only account, which never reaches the roster page (INV-PRIV-017)", async () => {
    h.auth.mockResolvedValue(lodgeSession());
    for (const headers of [{}, { [MCP_PRINCIPAL_HEADER]: "p" }] as Record<string, string>[]) {
      const res = await getRoster(new Request("https://club.example.test/api/lodge-roster", { headers }));
      expect(res.status).toBe(404);
    }
    expect(h.buildMemberLodgeRoster).not.toHaveBeenCalled();
  });

  it("is absent while the roster is switched off", async () => {
    h.modules.mockResolvedValue({ memberLodgeRoster: false, mcpServer: true });
    const res = await getRoster(new Request("https://club.example.test/api/lodge-roster"));
    expect(res.status).toBe(404);
    expect(h.buildMemberLodgeRoster).not.toHaveBeenCalled();
  });
});
