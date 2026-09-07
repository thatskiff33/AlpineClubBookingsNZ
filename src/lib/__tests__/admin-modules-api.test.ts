import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  clubModuleSettingsUpsert: vi.fn(),
  // #2573: analytics readiness is a DATABASE read now, not an env-var check.
  analyticsSettingsFindUnique: vi.fn<
    () => Promise<Record<string, unknown> | null>
  >(async () => null),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
  invalidatePublicLayoutConfig: vi.fn(),
  revalidatePublicSite: vi.fn(),
}));

vi.mock("@/lib/public-layout-cache", () => ({
  PUBLIC_LAYOUT_CACHE_TAGS: {
    modules: "public-layout:modules",
    capacity: "public-layout:capacity",
  },
  invalidatePublicLayoutConfig: mocks.invalidatePublicLayoutConfig,
}));

// #2352 F3: a module toggle is rendered INTO the public layout, so the route now
// clears the full-route ISR store as well as the tagged data caches. Stubbed
// because `revalidatePath` needs a static-generation store that no unit test has;
// the shared helper's own behaviour is covered by public-content-invalidation-contract.
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: mocks.revalidatePublicSite,
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
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
    analyticsSettings: {
      findUnique: mocks.analyticsSettingsFindUnique,
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

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const memberSession = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

const allEnabled: ModuleSettingsValues = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as ModuleSettingsValues;

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
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
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
    // End the slice at the ClubModuleSettings/Lodge boundary, NOT at the distant
    // "Booking Modifications" section header. This guard's promise is about
    // ClubModuleSettings — "persists only activation booleans, never a secret,
    // token, credential or tenant column" — and the old far marker over-reached
    // across the whole Lodge model, which is core and unrelated. That was harmless
    // until #2780 gave a lodge a legitimate `LodgeMaintenanceReportToken?`
    // relation, whose model name contains "token" and tripped the guard on a model
    // it was never meant to police. Bounding the slice to ClubModuleSettings keeps
    // the real guarantee intact and precise.
    // Both sides of this merge fixed the same over-wide slice independently.
    // Main's bound is the tighter one and subsumes this branch's, so it is kept.
    // End the slice at the model's own closing brace, not at a distant section
    // banner. The banner sat hundreds of lines past ClubModuleSettings, so every
    // model declared in between was scanned as if it belonged to it — and the
    // `not.toMatch(/secret|.../)` guard below then fired on a NEIGHBOUR's docblock
    // (ServerNzSettings, whose comment exists to say its API key is NOT stored
    // there) rather than on anything ClubModuleSettings persists. A Prisma model
    // body holds no nested braces, so the first line-initial `}` ends it.
    const model = sliceFrom(schema, "model ClubModuleSettings", "\n}");
    const migration = readRepoFile(
      "prisma/migrations/20260518113000_add_club_module_settings/migration.sql",
    );

    expect(model).toContain("kiosk                   Boolean  @default(false)");
    expect(model).toContain("chores                  Boolean  @default(false)");
    expect(model).toContain("financeDashboard        Boolean  @default(false)");
    expect(model).toContain("waitlist                Boolean  @default(false)");
    expect(model).toContain("xeroIntegration         Boolean  @default(false)");
    expect(model).toContain("bedAllocation           Boolean  @default(false)");
    expect(model).toContain("internetBankingPayments Boolean  @default(false)");
    expect(model).toContain("addressAutocomplete     Boolean  @default(false)");
    expect(model).toContain("analytics               Boolean  @default(false)");
    expect(model).toContain("groupBookings           Boolean  @default(true)");
    expect(model).not.toMatch(/secret|token|credential|tenant/i);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "ClubModuleSettings"');
    expect(migration).toContain('INSERT INTO "ClubModuleSettings" ("id")');
    expect(
      readRepoFile(
        "prisma/migrations/20260607120000_add_bed_allocation_and_internet_banking_modules/migration.sql",
      ),
    ).toContain('"internetBankingPayments" BOOLEAN NOT NULL DEFAULT true');
    const defaultRepairMigration = readRepoFile(
      "prisma/migrations/20260627120000_core_module_defaults_off/migration.sql",
    );
    expect(defaultRepairMigration).toContain(
      'ALTER COLUMN "financeDashboard" SET DEFAULT false',
    );
    expect(defaultRepairMigration).toContain('"updatedByMemberId" IS NULL');
    expect(
      readRepoFile(
        "prisma/migrations/20260628160000_add_address_autocomplete_module/migration.sql",
      ),
    ).toContain('"addressAutocomplete" BOOLEAN NOT NULL DEFAULT false');
    expect(
      readRepoFile(
        "prisma/migrations/20260702143000_add_analytics_module/migration.sql",
      ),
    ).toContain('"analytics" BOOLEAN NOT NULL DEFAULT false');
    expect(model).toContain("lobbyDisplay            Boolean  @default(false)");
    expect(
      readRepoFile(
        "prisma/migrations/20260712130000_add_lobby_display/migration.sql",
      ),
    ).toContain('"lobbyDisplay" BOOLEAN NOT NULL DEFAULT false');
  });
});

/*
  The Modules page's "Set up ->" affordance, contracted against the source.

  Google Analytics is the first module whose setup lives IN-APP but has no setup
  route of its own: the owner's #2573 decision put its configuration on the
  Integrations hub as a peer card that opens in place, and expressly ruled out a
  dedicated `/admin/analytics/setup`. The page renders the link only when
  `MODULE_SETUP_HREFS` has an entry for the module key, so without one analytics
  reported "Needs setup" with no clickable route to the very screen this release
  moved in-app — two rows from the Xero and Google sign-in cards that do show it,
  and on the screen where the hard cutover is most likely to be met by an operator
  who has not read the release note. `docs/UPGRADING.md` states the badge "points
  at Integrations", so the docs asserted it too.

  A source-text parse rather than a render: the page is a `"use client"` component
  whose data comes from `fetch`, and what is under test is a registration, not
  behaviour. Deliberately NOT phrased as "every module that can report
  credentials_missing has an href" — `addressAutocomplete` can, and correctly has
  none, because its credentials are deploy-time environment variables with no
  in-app screen to link to.
*/
describe("Modules page setup affordance", () => {
  it("deep-links the analytics module at the Integrations hub", () => {
    const page = readRepoFile("src/app/(admin)/admin/modules/page.tsx");
    const map = sliceFrom(page, "const MODULE_SETUP_HREFS", "};");

    expect(map).toContain('analytics: "/admin/integrations"');
    // The two that were already there, so a careless rewrite of the map is caught
    // rather than silently dropping them.
    expect(map).toContain('xeroIntegration: "/admin/xero/setup"');
    expect(map).toContain('googleLogin: "/admin/google/setup"');
    // The route the owner ruled out must not reappear anywhere on the page.
    expect(page).not.toContain("/admin/analytics/setup");
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
    vi.unstubAllEnvs();

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
    expect(body.modules).toHaveLength(MODULE_KEYS.length);
    expect(body.modules.map((module: { key: string }) => module.key)).toEqual([
      ...MODULE_KEYS,
    ]);
    expect(body.modules[0]).toEqual(
      expect.objectContaining({
        key: "kiosk",
        adminEnabled: true,
      }),
    );
    expect(body.modules[0]).not.toHaveProperty("envVar");
  });

  it("reports address autocomplete setup without exposing Addy credential values", async () => {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({
      id: "default",
      ...allEnabled,
      updatedAt: new Date("2026-05-18T11:00:00.000Z"),
      updatedByMemberId: "admin-1",
    });
    vi.stubEnv("ADDY_API_KEY", "secret-addy-key");
    vi.stubEnv("ADDY_API_SECRET", "");

    const response = await GET();
    const body = await response.json();
    const addy = body.modules.find(
      (module: { key: string }) => module.key === "addressAutocomplete",
    );

    expect(addy.readiness.status).toBe("credentials_missing");
    expect(JSON.stringify(addy)).not.toContain("secret-addy-key");
  });

  /*
    #2573 turned analytics readiness from an env-var check into a DATABASE read, and
    both directions matter. The old assertion could pass with the env var simply
    unset, which after the hard cutover proves nothing at all.
  */
  async function analyticsReadiness() {
    mocks.auth.mockResolvedValue(adminSession);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({
      id: "default",
      ...allEnabled,
      updatedAt: new Date("2026-05-18T11:00:00.000Z"),
      updatedByMemberId: "admin-1",
    });
    const response = await GET();
    const body = await response.json();
    return body.modules.find(
      (module: { key: string }) => module.key === "analytics",
    );
  }

  it("reports analytics as unconfigured when no measurement id is stored", async () => {
    mocks.analyticsSettingsFindUnique.mockResolvedValue(null);
    // Set deliberately: the environment value must NOT make the module look ready,
    // because nothing reads it any more. This is the hard-cutover assertion.
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-FROMENVIRONMENT");

    const analytics = await analyticsReadiness();

    expect(analytics.readiness.status).toBe("credentials_missing");
    expect(analytics.readiness.message).toContain("Admin → Integrations");
    expect(analytics.readiness.message).not.toContain(
      "NEXT_PUBLIC_GA_MEASUREMENT_ID",
    );
    expect(JSON.stringify(analytics)).not.toContain("G-FROMENVIRONMENT");
  });

  it("reports analytics as ready once a valid measurement id is stored", async () => {
    mocks.analyticsSettingsFindUnique.mockResolvedValue({
      measurementId: "G-STORED1234",
      consentBannerEnabled: true,
      bannerMessage: null,
      consentRevision: 1,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedByMemberId: "admin-1",
    });
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");

    const analytics = await analyticsReadiness();

    expect(analytics.readiness.status).toBe("ready");
    // The measurement id is configuration, not confidential — but the modules
    // payload has no business carrying it, so it must not leak in here either.
    expect(JSON.stringify(analytics)).not.toContain("G-STORED1234");
  });

  it("reports analytics as unconfigured when the stored measurement id is invalid", async () => {
    // Reachable through a database restore or a manual fix, and section 8 requires
    // an invalid id to mean no analytics rather than a broken tag.
    mocks.analyticsSettingsFindUnique.mockResolvedValue({
      measurementId: "GTM-ABCDEF",
      consentBannerEnabled: true,
      bannerMessage: null,
      consentRevision: 1,
      updatedAt: null,
      updatedByMemberId: null,
    });

    expect((await analyticsReadiness()).readiness.status).toBe(
      "credentials_missing",
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
    // #2352 F3: the capacity tag is cleared by revalidatePublicSite() itself, so
    // the route passes only the tag that is specific to this write.
    expect(mocks.revalidatePublicSite).toHaveBeenCalledWith("public-layout:modules");
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
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
    // The PUT handler's pre-write read must use the explicit column select
    // (#153) so it stays blue/green-safe for a later DROP of a retired column,
    // matching the invariant #150 established for the other reads. The
    // upsert's implicit RETURNING needs the same select (#175) — Prisma
    // names every column on a write, too.
    expect(mocks.clubModuleSettingsFindUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
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

  it("is controlled solely by admin activation", () => {
    expect(
      getEffectiveModuleFlags({ ...allEnabled, waitlist: false }).waitlist,
    ).toBe(false);
    expect(
      getEffectiveModuleFlags({ ...allEnabled, waitlist: true }).waitlist,
    ).toBe(true);
  });

  it("fails closed when module settings cannot be read", async () => {
    mocks.clubModuleSettingsFindUnique.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(loadEffectiveModuleFlags()).resolves.toEqual(
      Object.fromEntries(MODULE_KEYS.map((key) => [key, false])),
    );
  });
});
