/**
 * ALP-724 (`INV-MCP-006`): the Support area's settings reads and the privacy
 * retention save an officer's AI app connection may run: the modules, the
 * club's currency and locale, the sign-in rules, the access roles and privacy
 * retention. Switching modules, changing the sign-in rules or roles, and the
 * currency itself are website-only (`exclusions.ts`). Each route answers the
 * browser as before; the connection gets exactly the action's `returns`
 * fields (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * What a connection must never be sent here: who holds an access role (only
 * how many), the officers who last saved a setting, or the name of whoever
 * last changed the club's currency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: { member: { count: vi.fn() } },
  requireAdmin: vi.fn(),
  formatValues: vi.fn(),
  loadModules: vi.fn(),
  resolveFormat: vi.fn(),
  formatState: vi.fn(),
  inFlight: vi.fn(),
  loginSecurity: vi.fn(),
  loginRefresh: vi.fn(),
  loadRoles: vi.fn(),
  holderCounts: vi.fn(),
  retentionPreview: vi.fn(),
  retentionSettings: vi.fn(),
  saveRetention: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: h.formatValues }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadClubModuleSettings: h.loadModules,
}));
vi.mock("@/lib/club-format-settings", () => ({ resolveClubFormatWithSource: h.resolveFormat }));
vi.mock("@/lib/club-format-admin-state", () => ({ stateFromResolved: h.formatState, stateFromRow: vi.fn() }));
vi.mock("@/lib/club-format-in-flight", () => ({ countInFlightCardPayments: h.inFlight }));
vi.mock("@/lib/login-security-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/login-security-settings")),
  loadLoginSecuritySettings: h.loginSecurity,
  loadLoginSecurityRefresh: h.loginRefresh,
}));
vi.mock("@/lib/officer-sign-in-switch", () => ({ OFFICER_SIGN_IN_ENFORCED: true }));
vi.mock("@/lib/access-role-definitions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/access-role-definitions")),
  loadAccessRoleDefinitions: h.loadRoles,
}));
vi.mock("@/lib/access-role-definition-routes", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/access-role-definition-routes")),
  accessRoleDefinitionHolderCounts: h.holderCounts,
}));
vi.mock("@/lib/privacy-retention", () => ({ getPrivacyRetentionPreview: h.retentionPreview }));
vi.mock("@/lib/privacy-retention-settings", () => ({
  getPrivacyRetentionSettings: h.retentionSettings,
  savePrivacyRetentionSettings: h.saveRetention,
}));
vi.mock("@/lib/public-content-revalidation", () => ({ revalidatePublicSite: vi.fn() }));

import { GET as listAccessRoles } from "@/app/api/admin/access-roles/route";
import { GET as getClubFormat } from "@/app/api/admin/club-format/route";
import { GET as listModules } from "@/app/api/admin/modules/route";
import { GET as getRetention, PUT as putRetention } from "@/app/api/admin/privacy-retention/route";
import { GET as getOfficerTwoFactor } from "@/app/api/admin/security/officer-two-factor/route";
import { GET as getPasswordPolicy } from "@/app/api/admin/security/password-policy/route";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";

const STAMP = new Date("2026-06-30T00:00:00.000Z");
const ISO = STAMP.toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
});

describe("list_modules", () => {
  it("sends each module's state and readiness, without who switched it", async () => {
    h.formatValues.mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ" });
    h.loadModules.mockResolvedValue({
      settings: { bedAllocation: true },
      modules: [
        {
          key: "bedAllocation",
          label: "Bed allocation",
          description: "Assign beds.",
          adminEnabled: true,
          effectiveEnabled: true,
          readiness: { status: "ready", message: "Ready.", dependencies: [] },
        },
      ],
      updatedAt: ISO,
      updatedByMemberId: "officer-9",
    });
    const { connection } = await expectActionContract({ actionId: "list_modules", handler: listModules });
    expect(JSON.stringify(connection)).not.toContain("officer-9");
  });
});

describe("get_club_format", () => {
  it("sends the currency and locale, never who changed them or the Full Admin's in-flight count", async () => {
    h.resolveFormat.mockResolvedValue({});
    h.formatState.mockResolvedValue({
      currencyCode: "NZD",
      locale: "en-NZ",
      currencySource: "persisted",
      localeSource: "persisted",
      updatedAt: ISO,
      updatedByName: "Ana Reid",
      unusableStoredCurrency: null,
      unusableStoredLocale: null,
    });
    h.inFlight.mockResolvedValue({ count: 2 });
    const { connection, browser } = await expectActionContract({ actionId: "get_club_format", handler: getClubFormat });
    expect(JSON.stringify(connection)).not.toContain("Ana Reid");
    expect(connection).not.toHaveProperty("inFlight");
    expect(browser).toMatchObject({ inFlight: { count: 2 } });
  });
});

describe("the sign-in rule reads", () => {
  it("get_password_policy sends the rules without who saved them", async () => {
    h.loginSecurity.mockResolvedValue({
      policy: {
        minPasswordLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigit: true,
        requireSymbol: false,
        magicLinkTtlMinutes: 15,
        breachedPasswordCheck: true,
        sessionMaxAgeHours: 168,
      },
      updatedAt: ISO,
      updatedByMemberId: "officer-9",
    });
    const { connection } = await expectActionContract({ actionId: "get_password_policy", handler: getPasswordPolicy });
    expect(JSON.stringify(connection)).not.toContain("officer-9");
  });

  it("get_officer_two_factor_policy sends the rule", async () => {
    h.loginRefresh.mockResolvedValue({ officerTwoFactorPolicy: true, officerTwoFactorGraceDays: 14, other: "x" });
    const { connection } = await expectActionContract({
      actionId: "get_officer_two_factor_policy",
      handler: getOfficerTwoFactor,
    });
    expect(connection).toEqual({ officerTwoFactorPolicy: true, officerTwoFactorGraceDays: 14 });
  });
});

describe("list_access_roles", () => {
  it("sends each role and how many hold it, never the role picker's options", async () => {
    h.loadRoles.mockResolvedValue([
      {
        id: "role-1",
        key: "booking-officer",
        systemRole: null,
        label: "Booking Officer",
        description: "Runs bookings.",
        overviewLevel: "VIEW",
        bookingsLevel: "EDIT",
        membershipLevel: "VIEW",
        financeLevel: "NONE",
        lodgeLevel: "NONE",
        contentLevel: "NONE",
        supportLevel: "NONE",
        requiresTwoFactor: true,
        sortOrder: 1,
      },
    ]);
    h.holderCounts.mockResolvedValue(new Map([["role-1", 3]]));
    const { connection, browser } = await expectActionContract({ actionId: "list_access_roles", handler: listAccessRoles });
    expect(connection).toMatchObject({
      roles: [{ label: "Booking Officer", memberCount: 3, permissions: { bookings: "edit", finance: "none" } }],
    });
    expect(connection).not.toHaveProperty("roleOptions");
    expect(browser).toHaveProperty("roleOptions");
  });
});

describe("privacy retention", () => {
  const preview = {
    settings: DEFAULT_PRIVACY_RETENTION_SETTINGS,
    clearedBookingDietary: 2,
    emailLogs: { count: 1, rows: [{ id: "email-log-1", date: STAMP, reasons: ["older than 2 years"] }] },
    rejectedApplications: { count: 1, rows: [{ id: "application-1", date: STAMP, reasons: ["rejected"] }] },
    formerMembers: { count: 1, rows: [{ id: "member-1", date: STAMP, reasons: ["left"] }] },
    blockedMembers: { count: 1, rows: [{ id: "member-2", date: STAMP, reasons: ["open booking"] }] },
    undatedMembers: { count: 1, rows: [{ id: "member-3", date: null, reasons: ["no date"] }] },
    formerMemberCandidateCount: 2,
    memberHasMore: true,
    memberNextCursor: "member-2",
  };

  it("get_privacy_retention sends the settings and what the jobs would remove, by page", async () => {
    h.retentionPreview.mockResolvedValue(preview);
    const { connection } = await expectActionContract({
      actionId: "get_privacy_retention",
      handler: getRetention,
      args: { page: 2, memberAfter: "member-0" },
    });
    expect(connection).toMatchObject({ page: 2, canViewMembership: true, memberNextCursor: "member-2" });
    expect(h.retentionPreview).toHaveBeenCalledWith({
      page: 2, pageSize: 25, memberAfter: "member-0", includeMembers: true,
    });
  });

  it("leaves the member lists out for an officer without Membership view", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: true,
      session: adminSession({
        id: "officer-2",
        accessRoles: ["USER"],
        adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), support: "edit" },
      }),
    });
    h.retentionPreview.mockResolvedValue(preview);
    const { connection } = await expectActionContract({
      actionId: "get_privacy_retention",
      handler: getRetention,
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ canViewMembership: false });
    expect(JSON.stringify(connection)).not.toContain("member-1");
  });

  it("refuses a page that is not a positive whole number, as before", async () => {
    const response = await getRetention(new Request("https://club.example.test/api/admin/privacy-retention?page=0"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Page must be a positive whole number." });
    const cursor = await getRetention(new Request("https://club.example.test/api/admin/privacy-retention?memberAfter="));
    expect(await cursor.json()).toEqual({ error: "Invalid member cursor." });
  });

  it("update_privacy_retention saves every setting", async () => {
    const settings = { ...DEFAULT_PRIVACY_RETENTION_SETTINGS, emailLogRetentionYears: 3 };
    h.saveRetention.mockResolvedValue(settings);
    const { connection } = await expectActionContract({
      actionId: "update_privacy_retention",
      handler: putRetention,
      args: settings,
    });
    expect(connection).toEqual({ settings });
    expect(h.saveRetention).toHaveBeenCalledWith(settings, "officer-1");
  });
});
