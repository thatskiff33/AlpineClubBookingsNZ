/**
 * ALP-722 (`INV-MCP-006`): the Lodge Operations maintenance and food-order
 * settings actions an officer's AI app connection may run: the maintenance
 * report queue, one report's status and photo, the question set, the report
 * policy, the QR signs' switch, and the food-order settings. Each route
 * answers the browser as before; the connection gets exactly the action's
 * `returns` fields (`expectActionContract`). Every handler runs twice
 * (connection, then browser), so the write mocks answer both runs.
 *
 * What a connection must never be sent here: a reporter's contact or the
 * reporting member's email address, the photo's bytes, a QR sign's token,
 * hash or link, and the food officer's email address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    lodge: { findMany: vi.fn() },
    maintenanceReport: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    maintenanceReportQuestion: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    maintenanceReportSettings: { upsert: vi.fn() },
    foodOrderSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    logAudit: vi.fn(),
    createAuditLog: vi.fn(),
    loadMaintenanceSettings: vi.fn(),
    signStatus: vi.fn(),
    setSignActive: vi.fn(),
    foodModuleOff: vi.fn(),
    loadFoodSettings: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
  createAuditLog: h.createAuditLog,
}));
vi.mock("@/lib/maintenance-report-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/maintenance-report-settings")),
  loadMaintenanceReportSettings: h.loadMaintenanceSettings,
}));
vi.mock("@/lib/maintenance-report-tokens", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/maintenance-report-tokens")),
  getLodgeMaintenanceTokenStatus: h.signStatus,
  setLodgeMaintenanceTokenActive: h.setSignActive,
}));
vi.mock("@/lib/food-order-route", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/food-order-route")),
  foodOrderModuleOff: h.foodModuleOff,
}));
vi.mock("@/lib/food-order-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/food-order-settings")),
  loadFoodOrderSettings: h.loadFoodSettings,
}));

import { GET as getFoodSettings, PUT as putFoodSettings } from "@/app/api/admin/food-orders/settings/route";
import { GET as getReport, PATCH as patchReport } from "@/app/api/admin/maintenance-reports/[id]/route";
import { GET as getQuestions, PUT as putQuestions } from "@/app/api/admin/maintenance-reports/questions/route";
import { GET as listReports } from "@/app/api/admin/maintenance-reports/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/maintenance-reports/settings/route";
import { GET as listSigns, PATCH as switchSign } from "@/app/api/admin/maintenance-reports/tokens/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { LODGE_MAINTENANCE_MCP_ACTIONS } from "@/lib/mcp/catalogue/lodge-maintenance";

/** What the browser receives: the fixture after a JSON round trip. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  // Interactive transactions run against the same doubles.
  h.prisma.$transaction.mockImplementation(async (fn: (tx: typeof h.prisma) => unknown) => fn(h.prisma));
  h.createAuditLog.mockResolvedValue(undefined);
});

describe("the lodge maintenance entries", () => {
  it("are officer actions: reads for GET, destructive otherwise, none core", () => {
    for (const action of LODGE_MAINTENANCE_MCP_ACTIONS) {
      expect(action.summary.startsWith("Officer: "), action.id).toBe(true);
      expect(action.kind, action.id).toBe(action.method === "GET" ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("never answer a token, a sign link, a photo's bytes or anyone's contact details", () => {
    for (const action of LODGE_MAINTENANCE_MCP_ACTIONS) {
      expect(JSON.stringify(action.returns), action.id).not.toMatch(
        /token|hash|signUrl|dataUrl|Contact"|email|officerEmail|phone/i,
      );
    }
    // Minting a sign answers its bearer link once: never an action.
    expect(
      LODGE_MAINTENANCE_MCP_ACTIONS.some(
        (action) => action.path === "/api/admin/maintenance-reports/tokens" && action.method === "POST",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The maintenance report queue
// ---------------------------------------------------------------------------

const REPORTED = new Date("2026-06-20T09:00:00.000Z");

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    lodgeId: "lodge-1",
    source: "MEMBER_PORTAL",
    status: "OPEN",
    summary: "Drying room heater not working",
    reporterName: "Pat Visitor",
    reporterContact: "pat@example.com",
    photoContentType: "image/jpeg",
    photoCapturedAt: REPORTED,
    photoExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    photoDeletedAt: null,
    photoDeleteReason: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: REPORTED,
    updatedAt: REPORTED,
    lodge: { id: "lodge-1", name: "Whakapapa Lodge" },
    member: { id: "member-7", firstName: "Sam", lastName: "Skier", email: "sam@example.com" },
    answers: [{ id: "answer-1", questionLabel: "Which room?", questionType: "SHORT_TEXT", answerText: "Drying room" }],
    photoDataUrl: "data:image/jpeg;base64,AAAA",
    ...overrides,
  };
}

/** The report as a connection gets it: no contact, no member email, no photo bytes, no `updatedAt`. */
function projectedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    lodge: { id: "lodge-1", name: "Whakapapa Lodge" },
    source: "MEMBER_PORTAL",
    status: "OPEN",
    summary: "Drying room heater not working",
    selfDeclaredName: "Pat Visitor",
    member: { id: "member-7", firstName: "Sam", lastName: "Skier" },
    photo: {
      contentType: "image/jpeg",
      capturedAt: REPORTED.toISOString(),
      expiresAt: "2026-08-01T00:00:00.000Z",
      deletedAt: null,
      deleteReason: null,
      retained: true,
    },
    resolvedAt: null,
    resolutionNote: null,
    createdAt: REPORTED.toISOString(),
    answers: [{ id: "answer-1", questionLabel: "Which room?", questionType: "SHORT_TEXT", answerText: "Drying room" }],
    ...overrides,
  };
}

const CONTACT_DETAILS = /pat@example\.com|sam@example\.com|base64/;

describe("list_maintenance_reports", () => {
  it("answers a page of reports with the reporter's name but no contact details", async () => {
    // The list select carries no photo bytes.
    const listRow: Record<string, unknown> = reportRow();
    delete listRow.photoDataUrl;
    h.prisma.maintenanceReport.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    h.prisma.maintenanceReport.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    h.prisma.maintenanceReport.findMany.mockResolvedValue([listRow]);
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-1", name: "Whakapapa Lodge" }]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_maintenance_reports",
      handler: listReports,
      args: { status: "OPEN", lodgeId: "lodge-1", page: 1, pageSize: 25 },
    });

    expect(h.prisma.maintenanceReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "OPEN", lodgeId: "lodge-1" }, skip: 0, take: 25 }),
    );
    expect(connection).toEqual({
      reports: [projectedReport()],
      lodges: [{ id: "lodge-1", name: "Whakapapa Lodge" }],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
      outstandingCount: 3,
    });
    expect(JSON.stringify(connection)).not.toMatch(CONTACT_DETAILS);
    expect(browser).toMatchObject({
      reports: [{ selfDeclaredContact: "pat@example.com", member: { email: "sam@example.com" } }],
    });
  });
});

describe("get_maintenance_report", () => {
  it("answers the report without the photo's bytes, and audits that the connection opened no photo", async () => {
    h.prisma.maintenanceReport.findUnique.mockResolvedValue(reportRow());

    const { connection, browser } = await expectActionContract({
      actionId: "get_maintenance_report",
      handler: getReport,
      args: { id: "report-1" },
    });

    expect(connection).toEqual({ report: projectedReport() });
    expect(JSON.stringify(connection)).not.toMatch(CONTACT_DETAILS);
    expect(browser).toMatchObject({ report: { photo: { dataUrl: "data:image/jpeg;base64,AAAA" } } });
    // Connection first, then browser: only the browser was handed the photo.
    expect(h.logAudit.mock.calls.map(([entry]) => JSON.parse(entry.details))).toEqual([
      { photoOpened: false },
      { photoOpened: true },
    ]);
  });
});

describe("set_maintenance_report_status", () => {
  it("resolves the report with its note as the officer and answers it", async () => {
    h.prisma.maintenanceReport.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select && "lodge" in args.select
        ? reportRow({ status: "RESOLVED", resolvedAt: REPORTED, resolutionNote: "Replaced the fuse." })
        : { id: "report-1", status: "OPEN", photoDataUrl: "data:...", photoDeletedAt: null },
    );

    const { connection, browser } = await expectActionContract({
      actionId: "set_maintenance_report_status",
      handler: patchReport,
      args: { id: "report-1", status: "RESOLVED", note: "Replaced the fuse." },
    });

    expect(h.prisma.maintenanceReport.update).toHaveBeenCalledWith({
      where: { id: "report-1" },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolvedById: "officer-1",
        resolutionNote: "Replaced the fuse.",
      }),
    });
    expect(connection).toEqual({
      report: projectedReport({
        status: "RESOLVED",
        resolvedAt: REPORTED.toISOString(),
        resolutionNote: "Replaced the fuse.",
      }),
    });
    expect(browser).toMatchObject({ report: { status: "RESOLVED", selfDeclaredContact: "pat@example.com" } });
  });
});

describe("delete_maintenance_report_photo", () => {
  it("deletes the photo once, audits it as important, and answers the report", async () => {
    const deleted = { photoDataUrl: null, photoContentType: null, photoDeletedAt: REPORTED, photoDeleteReason: "Shows a face" };
    h.prisma.maintenanceReport.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select && "lodge" in args.select
        ? reportRow(deleted)
        : { id: "report-1", status: "OPEN", photoDataUrl: "data:...", photoDeletedAt: null },
    );
    h.prisma.maintenanceReport.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const { connection, browser } = await expectActionContract({
      actionId: "delete_maintenance_report_photo",
      handler: patchReport,
      args: { id: "report-1", reason: "Shows a face" },
    });

    expect(h.prisma.maintenanceReport.updateMany).toHaveBeenCalledWith({
      where: { id: "report-1", photoDataUrl: { not: null } },
      data: expect.objectContaining({ photoDataUrl: null, photoDeletedById: "officer-1", photoDeleteReason: "Shows a face" }),
    });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "maintenance.report.photo_deleted", severity: "important" }),
    );
    expect(connection).toEqual({
      report: projectedReport({
        photo: {
          contentType: null,
          capturedAt: REPORTED.toISOString(),
          expiresAt: "2026-08-01T00:00:00.000Z",
          deletedAt: REPORTED.toISOString(),
          deleteReason: "Shows a face",
          retained: false,
        },
      }),
    });
    expect(browser).toMatchObject({ report: { photo: { dataUrl: null, retained: false } } });
  });
});

// ---------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------

const QUESTION = {
  id: "q-1",
  label: "Which room?",
  helpText: "As on the door sign",
  type: "SINGLE_CHOICE",
  required: true,
  choices: ["Bunk room", "Drying room"],
  sortOrder: 0,
  active: true,
};

describe("get_maintenance_report_questions", () => {
  it("answers the active questions and the editor's limits", async () => {
    h.prisma.maintenanceReportQuestion.findMany.mockResolvedValue([QUESTION]);

    const { connection, browser } = await expectActionContract({
      actionId: "get_maintenance_report_questions",
      handler: getQuestions,
    });

    expect(connection).toEqual({
      questions: [QUESTION],
      limits: {
        maxQuestions: expect.any(Number),
        maxLabelLength: expect.any(Number),
        maxHelpLength: expect.any(Number),
        maxChoices: expect.any(Number),
        maxChoiceLength: expect.any(Number),
      },
    });
    expect(browser).toEqual(connection);
  });
});

describe("update_maintenance_report_questions", () => {
  it("keeps a known question, deactivates the rest, and answers the saved set", async () => {
    h.prisma.maintenanceReportQuestion.findMany.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select && "label" in args.select ? [QUESTION] : [{ id: "q-1" }, { id: "q-2" }],
    );

    const { connection, browser } = await expectActionContract({
      actionId: "update_maintenance_report_questions",
      handler: putQuestions,
      args: {
        questions: [
          {
            id: "q-1",
            label: "Which room?",
            helpText: "As on the door sign",
            type: "SINGLE_CHOICE",
            required: true,
            choices: ["Bunk room", "Drying room"],
          },
        ],
      },
    });

    expect(h.prisma.maintenanceReportQuestion.update).toHaveBeenCalledWith({
      where: { id: "q-1" },
      data: expect.objectContaining({ label: "Which room?", sortOrder: 0, active: true }),
    });
    expect(h.prisma.maintenanceReportQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["q-2"] } },
      data: { active: false },
    });
    expect(connection).toEqual({ questions: [QUESTION] });
    expect(browser).toEqual({ questions: [QUESTION] });
  });
});

// ---------------------------------------------------------------------------
// The maintenance report policy
// ---------------------------------------------------------------------------

const POLICY = {
  anonymousReportsEnabled: true,
  photosEnabled: true,
  anonymousPhotosEnabled: false,
  photoRetentionDays: 30,
  anonymousContactPrompt: true,
};

describe("get_maintenance_report_settings", () => {
  it("answers the policy and the retention window's bounds", async () => {
    h.loadMaintenanceSettings.mockResolvedValue(POLICY);

    const { connection, browser } = await expectActionContract({
      actionId: "get_maintenance_report_settings",
      handler: getSettings,
    });

    expect(connection).toEqual({
      settings: POLICY,
      limits: { photoRetentionDaysMin: expect.any(Number), photoRetentionDaysMax: expect.any(Number) },
    });
    expect(browser).toEqual(connection);
  });
});

describe("update_maintenance_report_settings", () => {
  it("saves the policy as the officer, audits opening the QR form as important, and answers it", async () => {
    h.loadMaintenanceSettings.mockResolvedValue({ ...POLICY, anonymousReportsEnabled: false });
    h.prisma.maintenanceReportSettings.upsert.mockResolvedValue({
      id: "default",
      ...POLICY,
      updatedByMemberId: "officer-1",
      updatedAt: REPORTED,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "update_maintenance_report_settings",
      handler: putSettings,
      args: POLICY,
    });

    expect(h.prisma.maintenanceReportSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { ...POLICY, updatedByMemberId: "officer-1" } }),
    );
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "maintenance.anonymous_reports.enabled", severity: "important" }),
    );
    expect(connection).toEqual({ settings: POLICY });
    expect(browser).toEqual({ settings: POLICY });
  });
});

// ---------------------------------------------------------------------------
// The QR signs
// ---------------------------------------------------------------------------

describe("list_maintenance_report_signs", () => {
  it("answers each active lodge's sign status and no token", async () => {
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-1", name: "Whakapapa Lodge" }]);
    const status = { active: true, createdAt: REPORTED, rotatedAt: REPORTED, lastUsedAt: REPORTED };
    h.signStatus.mockResolvedValue(status);

    const { connection, browser } = await expectActionContract({
      actionId: "list_maintenance_report_signs",
      handler: listSigns,
    });

    expect(h.signStatus).toHaveBeenCalledWith("lodge-1");
    expect(connection).toEqual({ signs: [{ lodgeId: "lodge-1", lodgeName: "Whakapapa Lodge", sign: asJson(status) }] });
    expect(browser).toEqual(connection);
  });
});

describe("set_maintenance_report_sign_active", () => {
  it("pauses the lodge's sign without minting, audits it, and answers ok", async () => {
    h.setSignActive.mockResolvedValue(true);

    const { connection, browser } = await expectActionContract({
      actionId: "set_maintenance_report_sign_active",
      handler: switchSign,
      args: { lodgeId: "lodge-1", active: false },
    });

    expect(h.setSignActive).toHaveBeenCalledWith("lodge-1", false);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "maintenance.qr_token.paused" }));
    expect(connection).toEqual({ ok: true });
    expect(browser).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Food-order settings
// ---------------------------------------------------------------------------

describe("get_food_order_settings", () => {
  it("answers the officer's label and never the officer's address", async () => {
    h.foodModuleOff.mockResolvedValue(false);
    h.loadFoodSettings.mockResolvedValue({ officerEmail: "food@example.com", officerLabel: "Food officer" });

    const { connection, browser } = await expectActionContract({
      actionId: "get_food_order_settings",
      handler: getFoodSettings,
    });

    expect(connection).toEqual({ settings: { officerLabel: "Food officer" } });
    expect(browser).toEqual({ settings: { officerEmail: "food@example.com", officerLabel: "Food officer" } });
  });
});

describe("update_food_order_settings", () => {
  it("saves the address and label in one serialisable transaction and answers the label", async () => {
    h.foodModuleOff.mockResolvedValue(false);
    h.prisma.foodOrderSettings.findUnique.mockResolvedValue({ officerEmail: null, officerLabel: "Food officer" });
    h.prisma.foodOrderSettings.upsert.mockResolvedValue({ officerEmail: "food@example.com", officerLabel: "Catering" });

    const { connection, browser } = await expectActionContract({
      actionId: "update_food_order_settings",
      handler: putFoodSettings,
      args: { officerEmail: "food@example.com", officerLabel: "Catering" },
    });

    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(h.prisma.foodOrderSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { officerEmail: "food@example.com", officerLabel: "Catering", updatedByMemberId: "officer-1" },
      }),
    );
    expect(connection).toEqual({ settings: { officerLabel: "Catering" } });
    expect(browser).toEqual({ settings: { officerEmail: "food@example.com", officerLabel: "Catering" } });
  });
});
