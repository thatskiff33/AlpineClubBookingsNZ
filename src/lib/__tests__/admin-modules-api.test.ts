import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  clubModuleSettingsUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildStructuredAuditLogCreateArgs,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
      upsert: mocks.clubModuleSettingsUpsert,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { GET, PUT } from "@/app/api/admin/modules/route";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };
const memberSession = { user: { id: "member-1", role: "MEMBER" } };

const allEnabled: ModuleSettingsValues = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/modules", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "x-request-id": "req-1",
      "user-agent": "vitest",
    },
  });
}

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function sliceFrom(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find schema markers for ${startMarker}`);
  }
  return source.slice(start, end);
}

describe("Admin modules schema contract", () => {
  it("persists only activation booleans for supported optional modules", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const model = sliceFrom(
      schema,
      "model ClubModuleSettings",
      "// ---------------------------------------------------------------------------\n// Booking Modifications",
    );
    const migration = readRepoFile(
      "prisma/migrations/20260518113000_add_club_module_settings/migration.sql",
    );

    expect(model).toContain("kiosk                   Boolean  @default(true)");
    expect(model).toContain("chores                  Boolean  @default(true)");
    expect(model).toContain("financeDashboard        Boolean  @default(true)");
    expect(model).toContain("waitlist                Boolean  @default(true)");
    expect(model).toContain("xeroIntegration         Boolean  @default(true)");
    expect(model).toContain("bedAllocation           Boolean  @default(true)");
    expect(model).toContain("internetBankingPayments Boolean  @default(true)");
    expect(model).not.toMatch(/secret|token|credential|tenant/i);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "ClubModuleSettings"');
    expect(migration).toContain('"financeDashboard" BOOLEAN NOT NULL DEFAULT true');
    expect(migration).toContain('INSERT INTO "ClubModuleSettings" ("id")');
    expect(
      readRepoFile(
        "prisma/migrations/20260607120000_add_bed_allocation_and_internet_banking_modules/migration.sql",
      ),
    ).toContain('"internetBankingPayments" BOOLEAN NOT NULL DEFAULT true');
  });
});

describe("Admin modules API", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.requireActiveSessionUser.mockReset();
    mocks.clubModuleSettingsFindUnique.mockReset();
    mocks.clubModuleSettingsUpsert.mockReset();
    mocks.auditLogCreate.mockReset();
    mocks.transaction.mockReset();
    mocks.buildStructuredAuditLogCreateArgs.mockClear();
    mocks.getAuditRequestContext.mockClear();

    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.clubModuleSettingsUpsert.mockImplementation(async ({ create, update }) => ({
      id: "default",
      ...create,
      ...update,
      updatedAt: new Date("2026-05-18T11:00:00.000Z"),
    }));
    mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (operations) =>
      Promise.all(operations),
    );
  });

  it("prevents non-admin users from reading settings", async () => {
    mocks.auth.mockResolvedValue(memberSession);

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.clubModuleSettingsFindUnique).not.toHaveBeenCalled();
  });

  it("returns persisted settings and module readiness metadata for admins", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({
      id: "default",
      ...allEnabled,
      waitlist: false,
      updatedAt: new Date("2026-05-18T11:00:00.000Z"),
      updatedByMemberId: "admin-1",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.waitlist).toBe(false);
    expect(body.modules).toHaveLength(7);
    expect(body.modules.map((module: { key: string }) => module.key)).toEqual([
      "kiosk",
      "chores",
      "financeDashboard",
      "waitlist",
      "xeroIntegration",
      "bedAllocation",
      "internetBankingPayments",
    ]);
    expect(body.modules[0]).toEqual(
      expect.objectContaining({
        key: "kiosk",
        adminEnabled: true,
        envVar: "FEATURE_KIOSK",
      }),
    );
  });

  it("rejects invalid update payloads before writing", async () => {
    mocks.auth.mockResolvedValue(adminSession);

    const response = await PUT(
      request({
        settings: {
          ...allEnabled,
          xeroClientSecret: "should-not-store",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.clubModuleSettingsUpsert).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("prevents non-admin users from updating settings", async () => {
    mocks.auth.mockResolvedValue(memberSession);

    const response = await PUT(request({ settings: allEnabled }));

    expect(response.status).toBe(403);
    expect(mocks.clubModuleSettingsUpsert).not.toHaveBeenCalled();
  });

  it("saves settings and audits previous and new values when modules change", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({
      id: "default",
      ...allEnabled,
      updatedAt: new Date("2026-05-18T10:00:00.000Z"),
      updatedByMemberId: "admin-0",
    });

    const nextSettings: ModuleSettingsValues = {
      ...allEnabled,
      waitlist: false,
      xeroIntegration: false,
    };

    const response = await PUT(request({ settings: nextSettings }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings).toMatchObject(nextSettings);
    expect(mocks.clubModuleSettingsUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: {
        id: "default",
        ...nextSettings,
        updatedByMemberId: "admin-1",
      },
      update: {
        ...nextSettings,
        updatedByMemberId: "admin-1",
      },
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CLUB_MODULE_SETTINGS_UPDATED",
          actor: { memberId: "admin-1" },
          entity: { type: "ClubModuleSettings", id: "default" },
          category: "admin",
          metadata: {
            changedModuleKeys: ["waitlist", "xeroIntegration"],
            changes: [
              { key: "waitlist", previous: true, next: false },
              { key: "xeroIntegration", previous: true, next: false },
            ],
            previousSettings: allEnabled,
            newSettings: nextSettings,
          },
        }),
      }),
    );
  });
});

describe("effective module state", () => {
  beforeEach(() => {
    mocks.clubModuleSettingsFindUnique.mockReset();
  });

  it("requires both deploy capability and admin activation", () => {
    expect(
      getEffectiveModuleFlags(
        {
          kiosk: true,
          chores: true,
          financeDashboard: true,
          waitlist: true,
          xeroIntegration: true,
          bedAllocation: true,
          internetBankingPayments: true,
        },
        { ...allEnabled, waitlist: false },
      ).waitlist,
    ).toBe(false);
    expect(
      getEffectiveModuleFlags(
        {
          kiosk: true,
          chores: true,
          financeDashboard: true,
          waitlist: false,
          xeroIntegration: true,
          bedAllocation: true,
          internetBankingPayments: true,
        },
        { ...allEnabled, waitlist: true },
      ).waitlist,
    ).toBe(false);
    expect(
      getEffectiveModuleFlags(
        {
          kiosk: true,
          chores: true,
          financeDashboard: true,
          waitlist: true,
          xeroIntegration: true,
          bedAllocation: true,
          internetBankingPayments: true,
        },
        { ...allEnabled, waitlist: true },
      ).waitlist,
    ).toBe(true);
  });

  it("fails closed when module settings cannot be read", async () => {
    mocks.clubModuleSettingsFindUnique.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      loadEffectiveModuleFlags({
        kiosk: true,
        chores: true,
        financeDashboard: true,
        waitlist: true,
        xeroIntegration: true,
        bedAllocation: true,
        internetBankingPayments: true,
      }),
    ).resolves.toEqual({
      kiosk: false,
      chores: false,
      financeDashboard: false,
      waitlist: false,
      xeroIntegration: false,
      bedAllocation: false,
      internetBankingPayments: false,
    });
  });
});
