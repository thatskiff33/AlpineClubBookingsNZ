import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * In-handler module gate for both maintenance submit doors (#2780 security
 * review, defence in depth).
 *
 * The proxy matcher gate is the first line and has its own guard in
 * `src/config/__tests__/feature-routes.test.ts`. This suite proves the SECOND
 * line — the `loadEffectiveModuleFlags` check inside each route handler — so the
 * closure holds even if a future matcher edit drops the prefix again (the exact
 * regression this route shipped with).
 *
 * MUTATION-VERIFY SHAPE. Every other gate is set to PASS: the anonymous
 * `anonymousReportsEnabled` setting is on and the token resolves to a live lodge;
 * the member session is valid and never rate limited. So the ONLY thing that can
 * turn a request into a 404 here is the module flag. Remove the in-handler check
 * from either route and its module-off case flips to a 2xx and this suite fails.
 */

const mocks = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  loadMaintenanceReportSettings: vi.fn(),
  resolveLodgeForMaintenanceToken: vi.fn(),
  touchMaintenanceTokenLastUsed: vi.fn(),
  loadActiveMaintenanceQuestions: vi.fn(),
  createMaintenanceReport: vi.fn(),
  applyRateLimit: vi.fn(),
  applyMemberScopedRateLimit: vi.fn(),
  requireActiveSession: vi.fn(),
  lodgeFindMany: vi.fn(),
  lodgeFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  resolveAlertPayload: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/maintenance-report-settings", () => ({
  loadMaintenanceReportSettings: mocks.loadMaintenanceReportSettings,
}));
vi.mock("@/lib/maintenance-report-tokens", () => ({
  resolveLodgeForMaintenanceToken: mocks.resolveLodgeForMaintenanceToken,
  touchMaintenanceTokenLastUsed: mocks.touchMaintenanceTokenLastUsed,
}));
vi.mock("@/lib/maintenance-reports", () => ({
  MAX_MAINTENANCE_QUESTIONS: 20,
  MAX_MAINTENANCE_SUMMARY_LENGTH: 200,
  MAX_MAINTENANCE_REPORTER_NAME_LENGTH: 120,
  MAX_MAINTENANCE_REPORTER_CONTACT_LENGTH: 200,
  MaintenanceReportValidationError: class extends Error {},
  createMaintenanceReport: mocks.createMaintenanceReport,
  loadActiveMaintenanceQuestions: mocks.loadActiveMaintenanceQuestions,
}));
vi.mock("@/lib/maintenance-report-photo", () => ({
  MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH: 6_000_000,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: {
    maintenanceReportToken: {},
    maintenanceReportAnonymous: {},
    maintenanceReportMember: {},
  },
  applyRateLimit: mocks.applyRateLimit,
  applyMemberScopedRateLimit: mocks.applyMemberScopedRateLimit,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findMany: mocks.lodgeFindMany, findFirst: mocks.lodgeFindFirst },
    member: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/email", () => ({
  sendAdminMaintenanceReportAlert: mocks.sendAlert,
}));
vi.mock("@/lib/maintenance-report-alert", () => ({
  resolveMaintenanceAlertPayload: mocks.resolveAlertPayload,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  GET as anonGet,
  POST as anonPost,
} from "@/app/api/lodge-maintenance/[token]/route";
import {
  GET as memberGet,
  POST as memberPost,
} from "@/app/api/maintenance-reports/route";

function moduleFlags(maintenanceReports: boolean) {
  // The handlers read only `.maintenanceReports`; other keys are irrelevant.
  return { maintenanceReports } as Record<string, boolean>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every non-module gate set to PASS, so only the module flag can 404.
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.applyMemberScopedRateLimit.mockResolvedValue(null);
  mocks.loadMaintenanceReportSettings.mockResolvedValue({
    anonymousReportsEnabled: true,
    photosEnabled: true,
    anonymousPhotosEnabled: true,
    anonymousContactPrompt: false,
    photoRetentionDays: 30,
  });
  mocks.resolveLodgeForMaintenanceToken.mockResolvedValue({
    lodgeId: "lodge-1",
    lodgeName: "Test Lodge",
    tokenId: "tok-row-1",
  });
  mocks.loadActiveMaintenanceQuestions.mockResolvedValue([]);
  mocks.createMaintenanceReport.mockResolvedValue({
    id: "report-1",
    answerCount: 0,
    hasPhoto: false,
  });
  mocks.resolveAlertPayload.mockResolvedValue({});
  mocks.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  mocks.lodgeFindMany.mockResolvedValue([
    { id: "lodge-1", name: "Test Lodge", isDefault: true },
  ]);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1", name: "Test Lodge" });
  mocks.memberFindUnique.mockResolvedValue({
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
  });
});

const anonParams = { params: Promise.resolve({ token: "abcdef" }) };

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("anonymous QR route closes when the module is off", () => {
  it("GET 404s with the module off even though the token resolves and anonymous is on", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    const res = await anonGet(
      new NextRequest("http://localhost/api/lodge-maintenance/abcdef"),
      anonParams,
    );
    expect(res.status).toBe(404);
    // The module gate ran before the token lookup, so nothing about the token
    // was even consulted — no oracle, and no work done.
    expect(mocks.resolveLodgeForMaintenanceToken).not.toHaveBeenCalled();
  });

  it("POST 404s with the module off and creates nothing", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    const res = await anonPost(
      jsonRequest("http://localhost/api/lodge-maintenance/abcdef", {
        summary: "Leaking tap",
      }),
      anonParams,
    );
    expect(res.status).toBe(404);
    expect(mocks.createMaintenanceReport).not.toHaveBeenCalled();
    expect(mocks.resolveAlertPayload).not.toHaveBeenCalled();
  });

  it("GET proceeds with the module on (control: the 404 above is the module, not another gate)", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));
    const res = await anonGet(
      new NextRequest("http://localhost/api/lodge-maintenance/abcdef"),
      anonParams,
    );
    expect(res.status).toBe(200);
  });
});

describe("member submit route closes when the module is off", () => {
  it("GET 404s with the module off even for a valid active session", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    const res = await memberGet(new NextRequest("http://localhost/api/maintenance-reports"));
    expect(res.status).toBe(404);
    expect(mocks.lodgeFindMany).not.toHaveBeenCalled();
  });

  it("POST 404s with the module off and creates nothing", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    const res = await memberPost(
      jsonRequest("http://localhost/api/maintenance-reports", {
        lodgeId: "lodge-1",
        summary: "Broken heater",
      }),
    );
    expect(res.status).toBe(404);
    expect(mocks.createMaintenanceReport).not.toHaveBeenCalled();
  });

  it("GET proceeds with the module on (control)", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));
    const res = await memberGet(new NextRequest("http://localhost/api/maintenance-reports"));
    expect(res.status).toBe(200);
  });
});
