/**
 * ALP-723 (`INV-MCP-006`): the site settings, site style and mountain
 * conditions actions an officer's AI app connection may run, each held to its
 * contract (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields, whatever else the route's answer carries. An app's site
 * style save never writes the logo, never completes setup, and must send the
 * custom CSS rather than clear it by leaving it out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  saveClubTheme: vi.fn(),
  saveClubThemeStyle: vi.fn(),
  getClubThemeForAdmin: vi.fn(),
  fetchWhakapapaCurlData: vi.fn(),
  prisma: {
    clubIdentitySettings: { findUnique: vi.fn(), upsert: vi.fn() },
    publicContentSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    pageContent: { findMany: vi.fn(), findUnique: vi.fn() },
    committeeRole: { findMany: vi.fn(), findFirst: vi.fn() },
    privacyHostingSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    whakapapaReportCache: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (event: unknown) => ({ data: event }),
  getAuditRequestContext: () => ({ id: "req-1", ipAddress: "203.0.113.9", userAgent: "vitest" }),
  logAudit: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));
vi.mock("@/lib/public-layout-cache", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/public-layout-cache")),
  invalidatePublicClubIdentity: vi.fn(),
}));
vi.mock("@/lib/club-identity-settings", () => ({ primeClubIdentitySync: vi.fn() }));
vi.mock("@/lib/email-theme", () => ({ primeEmailPalette: vi.fn() }));
vi.mock("@/lib/club-theme", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-theme")),
  getClubThemeForAdmin: h.getClubThemeForAdmin,
  saveClubTheme: h.saveClubTheme,
  saveClubThemeStyle: h.saveClubThemeStyle,
}));
vi.mock("@/lib/whakapapa-report.server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/whakapapa-report.server")),
  fetchWhakapapaCurlData: h.fetchWhakapapaCurlData,
}));

import { GET as getContactRole, PUT as setContactRole } from "@/app/api/admin/club-contact/route";
import { GET as getIdentity, PUT as updateIdentity } from "@/app/api/admin/club-identity/route";
import {
  GET as getMountain,
  PATCH as updateMountainSettings,
  POST as refreshMountain,
  PUT as replaceMountainReport,
} from "@/app/api/admin/mountain-conditions/route";
import { GET as getPrivacyHosting, PUT as updatePrivacyHosting } from "@/app/api/admin/privacy-hosting/route";
import { GET as getPublicSettings, PUT as updatePublicSettings } from "@/app/api/admin/public-content-settings/route";
import { GET as getSiteStyle, PUT as updateSiteStyle } from "@/app/api/admin/site-style/route";
import { NextRequest } from "next/server";

import { buildActionRequest, expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction } from "@/lib/mcp/catalogue";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { emptyWhakapapaSectionVisibility, type WhakapapaCurlData } from "@/lib/whakapapa-report";

const identityRow = {
  name: "Ruapehu Alpine Club",
  shortName: "RAC",
  hutLeaderLabel: "Hut leader",
  facebookUrl: "https://facebook.com/example-club",
  legalName: "Ruapehu Alpine Club Incorporated",
  postalAddress: "PO Box 1\nOhakune",
};

const publicSettingsRow = {
  membershipTypes: true,
  entranceFees: true,
  hutFees: true,
  bookingPolicySummary: false,
  cancellationPolicy: true,
  annualFees: false,
  showBookNow: true,
  bookNowTarget: "PAGE" as const,
  bookNowPageId: "page-1",
  committeePhotoDisplay: "CIRCLE" as const,
};

/** The site style as the theme loaders return it, with the inline logo an app is never sent. */
const theme = {
  brandGold: "#c89b3c",
  brandDeep: "#1d3557",
  brandSafety: "#e63946",
  headingFontKey: "INTER",
  bodyFontKey: "LORA",
  logoUrl: "/api/images/logo-1",
  logoDataUrl: "data:image/png;base64,AAAA",
  rawCss: ".hero{margin:0}",
  completedAt: "2026-06-01T00:00:00.000Z",
  contrastWarnings: [{ id: "accent-on-surface", label: "Accent on surface", ratio: 3.1, message: "Low contrast" }],
};

const report: WhakapapaCurlData = {
  updated: "Updated 7am",
  roadStatus: { name: "Bruce Road", status: "Open", wheelRequirements: "Chains", roadContent: "Take care" },
  facilities: [{ name: "Ticket office", status: "Open" }],
  foodAndDrink: [{ name: "Cafe", status: "Closed" }],
  lifts: [{ name: "Sky Waka", status: "Open" }],
  conditions: [{ name: "Top", temperature: "-2", wind: "Light", snowBase: "120cm", snowfall24h: "5cm", snowfall7d: "20cm" }],
  trails: [{ name: "Happy Valley", trails: [{ name: "Learner slope", status: "Open", groomed: true, difficulty: "Easy", size: "Small" }] }],
  visibility: emptyWhakapapaSectionVisibility(),
};

const reportRow = {
  source: "whakapapa-report",
  payload: report,
  config: { sourceUrl: "https://www.whakapapa.com/report", selectorOverrides: { item: '[class*="row_"]' } },
  fetchedAt: new Date("2026-06-30T19:00:00.000Z"),
  frozenUntil: new Date("2026-07-01T07:00:00.000Z"),
  updatedAt: new Date("2026-06-30T19:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
});

describe("club identity and Contact page actions", () => {
  it("get_club_identity and update_club_identity read and replace the identity", async () => {
    h.prisma.clubIdentitySettings.findUnique.mockResolvedValue(identityRow);
    h.prisma.clubIdentitySettings.upsert.mockResolvedValue(identityRow);

    const read = await expectActionContract({ actionId: "get_club_identity", handler: getIdentity });
    expect(read.connection).toEqual({ settings: identityRow });

    await expectActionContract({
      actionId: "update_club_identity",
      handler: updateIdentity,
      args: { name: "Ruapehu Alpine Club", shortName: "", hutLeaderLabel: null, facebookUrl: "" },
    });
    expect(h.prisma.clubIdentitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ name: "Ruapehu Alpine Club", shortName: null, facebookUrl: null }),
      }),
    );
  });

  it("get_contact_page_role and set_contact_page_role read and choose an active committee role", async () => {
    h.prisma.publicContentSettings.findUnique.mockResolvedValue({ contactCommitteeRoleKey: "secretary" });
    h.prisma.committeeRole.findMany.mockResolvedValue([{ key: "secretary", name: "Secretary" }]);
    h.prisma.committeeRole.findFirst.mockResolvedValue({ id: "role-1" });
    h.prisma.publicContentSettings.upsert.mockResolvedValue({ contactCommitteeRoleKey: "secretary" });

    const read = await expectActionContract({ actionId: "get_contact_page_role", handler: getContactRole });
    expect(read.connection).toEqual({
      contactCommitteeRoleKey: "secretary",
      roles: [{ key: "secretary", name: "Secretary" }],
    });

    const saved = await expectActionContract({
      actionId: "set_contact_page_role",
      handler: setContactRole,
      args: { contactCommitteeRoleKey: "secretary" },
    });
    expect(saved.connection).toEqual({ contactCommitteeRoleKey: "secretary" });
  });
});

describe("public content settings and privacy hosting actions", () => {
  it("get_public_content_settings and update_public_content_settings read and replace the settings", async () => {
    h.prisma.publicContentSettings.findUnique.mockResolvedValue(publicSettingsRow);
    h.prisma.pageContent.findMany.mockResolvedValue([{ id: "page-1", title: "Book", path: "/book-info" }]);
    h.prisma.pageContent.findUnique.mockResolvedValue({ published: true });
    h.prisma.publicContentSettings.upsert.mockResolvedValue(publicSettingsRow);

    const read = await expectActionContract({ actionId: "get_public_content_settings", handler: getPublicSettings });
    expect(read.connection).toEqual({
      settings: publicSettingsRow,
      pages: [{ id: "page-1", title: "Book", path: "/book-info" }],
    });

    const saved = await expectActionContract({
      actionId: "update_public_content_settings",
      handler: updatePublicSettings,
      args: publicSettingsRow,
    });
    expect(saved.connection).toEqual({ settings: publicSettingsRow });
  });

  it("get_privacy_hosting_disclosure and update_privacy_hosting_disclosure read and set the disclosure", async () => {
    const settings = { hostingProvider: "Example Cloud", dataLocation: "New Zealand" };
    h.prisma.privacyHostingSettings.findUnique.mockResolvedValue(settings);
    h.prisma.privacyHostingSettings.upsert.mockResolvedValue(settings);

    const read = await expectActionContract({ actionId: "get_privacy_hosting_disclosure", handler: getPrivacyHosting });
    expect(read.connection).toEqual({ settings });

    const saved = await expectActionContract({
      actionId: "update_privacy_hosting_disclosure",
      handler: updatePrivacyHosting,
      args: settings,
    });
    expect(saved.connection).toEqual({ settings });
  });
});

describe("site style actions", () => {
  it("get_site_style sends the style without the inline logo's bytes", async () => {
    h.getClubThemeForAdmin.mockResolvedValue(theme);

    const { connection, browser } = await expectActionContract({ actionId: "get_site_style", handler: getSiteStyle });

    expect(connection).toMatchObject({ theme: { logoUrl: "/api/images/logo-1", rawCss: ".hero{margin:0}" } });
    expect((connection as { theme: Record<string, unknown> }).theme).not.toHaveProperty("logoDataUrl");
    expect(browser).toMatchObject({ theme: { logoDataUrl: "data:image/png;base64,AAAA" } });
  });

  it("update_site_style saves only the colours, fonts and CSS, through the save that never writes the logo", async () => {
    h.saveClubThemeStyle.mockResolvedValue(theme);
    const style = {
      brandGold: "#112233",
      brandDeep: "#1d3557",
      brandSafety: "#e63946",
      headingFontKey: theme.headingFontKey,
      bodyFontKey: theme.bodyFontKey,
      rawCss: ".hero{margin:0}",
    };

    // Built from the catalogue entry as the dispatcher builds it. Run as a
    // connection only: the browser's save sends the whole theme, logo included.
    const action = findMcpAction("update_site_style")!;
    const { request } = buildActionRequest(action, style, true);
    const response = await updateSiteStyle(request as NextRequest);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { theme: Record<string, unknown> };
    expect(Object.keys(answer).sort()).toEqual(Object.keys(action.returns).sort());
    expect(Object.keys(answer.theme).sort()).toEqual(Object.keys(action.returns.theme as object).sort());

    expect(h.saveClubThemeStyle).toHaveBeenCalledWith(style);
    expect(h.saveClubTheme).not.toHaveBeenCalled();
  });

  it("refuses a connection's save that would change the logo, complete setup, or clear the custom CSS by leaving it out", async () => {
    for (const extra of [
      { rawCss: "", logoUrl: "/api/images/other" },
      { rawCss: "", logoDataUrl: "data:image/png;base64,BBBB" },
      { rawCss: "", completeSetup: true },
      {},
    ]) {
      const response = await updateSiteStyle(
        new NextRequest("https://club.example.test/api/admin/site-style", {
          method: "PUT",
          headers: { "content-type": "application/json", [MCP_PRINCIPAL_HEADER]: "test-principal" },
          body: JSON.stringify({ brandGold: "#112233", brandDeep: "#1d3557", brandSafety: "#e63946", headingFontKey: theme.headingFontKey, bodyFontKey: theme.bodyFontKey, ...extra }),
        }),
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(h.saveClubTheme).not.toHaveBeenCalled();
    expect(h.saveClubThemeStyle).not.toHaveBeenCalled();
  });
});

describe("mountain conditions actions", () => {
  beforeEach(() => {
    h.prisma.whakapapaReportCache.findUnique.mockResolvedValue(reportRow);
    h.prisma.whakapapaReportCache.upsert.mockResolvedValue(reportRow);
    h.fetchWhakapapaCurlData.mockResolvedValue(report);
  });

  it("get_mountain_conditions_report sends the stored report and where it is read from", async () => {
    const { connection } = await expectActionContract({ actionId: "get_mountain_conditions_report", handler: getMountain });

    expect(connection).toMatchObject({
      record: { config: { sourceUrl: "https://www.whakapapa.com/report" }, frozenUntil: "2026-07-01T07:00:00.000Z" },
    });
  });

  it("refresh_mountain_conditions_report fetches from the stored source and never runs the website's preview", async () => {
    const { connection } = await expectActionContract({ actionId: "refresh_mountain_conditions_report", handler: refreshMountain });

    // The preview answers `{ preview }` and stores nothing; the refresh stores.
    expect(connection).not.toHaveProperty("preview");
    expect(h.prisma.whakapapaReportCache.upsert).toHaveBeenCalled();
    expect(h.fetchWhakapapaCurlData).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: "https://www.whakapapa.com/report" }),
    );
  });

  it("replace_mountain_conditions_report saves a report sent as JSON text", async () => {
    const { connection } = await expectActionContract({
      actionId: "replace_mountain_conditions_report",
      handler: replaceMountainReport,
      args: { rawJson: JSON.stringify(report) },
    });

    expect(connection).toMatchObject({ message: expect.stringContaining("paused for 12 hours") });
  });

  it("update_mountain_conditions_settings saves which sections show, or the source", async () => {
    await expectActionContract({
      actionId: "update_mountain_conditions_settings",
      handler: updateMountainSettings,
      args: { visibility: { lifts: false } },
    });
    expect(h.prisma.whakapapaReportCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ payload: expect.objectContaining({ visibility: expect.objectContaining({ lifts: false, trails: true }) }) }),
      }),
    );

    h.prisma.whakapapaReportCache.upsert.mockClear();
    await expectActionContract({
      actionId: "update_mountain_conditions_settings",
      handler: updateMountainSettings,
      args: { config: { sourceUrl: "https://www.whakapapa.com/report", selectorOverrides: { item: '[class*="row_"]' } } },
    });
    expect(h.prisma.whakapapaReportCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { config: expect.objectContaining({ sourceUrl: "https://www.whakapapa.com/report" }) } }),
    );
  });
});
