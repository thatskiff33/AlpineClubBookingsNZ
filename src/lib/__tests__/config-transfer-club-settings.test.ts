import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { Prisma } from "@prisma/client";

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import {
  SINGLETONS,
  clubSettingsImporter,
  COMMON_EXCLUDED_COLUMNS,
  excludedColumnsFor,
} from "@/lib/config-transfer/categories/club-settings";
import type { ApplyContext, ReadDb, TxDb } from "@/lib/config-transfer/import-types";
import { buildBundle } from "@/lib/config-transfer/bundle";
import { DEFAULTS_INTENTIONALLY_PARTIAL } from "@/lib/config-transfer/categories/club-settings";
import {
  DEFAULT_BOOKING_DEFAULTS,
  DEFAULT_BOOKING_REQUEST_SETTINGS,
  DEFAULT_GROUP_DISCOUNT_SETTING,
  DEFAULT_MEMBER_GUEST_SETTINGS,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
  DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS,
  DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
  DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS,
  DEFAULT_PUBLIC_CONTENT_SETTINGS,
} from "@/config/club-settings-defaults";
import { DEFAULT_LOGIN_SECURITY_POLICY } from "@/lib/password-policy";
import { DEFAULT_FAMILY_BILLING_MODE } from "@/lib/authoritative-fees";
import { CLUB_MODULE_SETTINGS_COLUMN_SELECT } from "@/config/modules";
import { readFileSync } from "node:fs";
import path from "node:path";

// Delegate names touched by the club-settings category.
const SINGLETON_DELEGATES = [
  "clubModuleSettings",
  "bookingDefaults",
  "memberFieldsSettings",
  "bedAllocationSettings",
  "bookingRequestSettings",
  "internetBankingPaymentSettings",
  "clubIdentitySettings",
  "emailMessageSetting",
  "groupDiscountSetting",
  "membershipNominationSettings",
  "membershipLockoutSettings",
  "membershipCancellationSetting",
  // #2200 — three portable settings singletons added by the model-level audit.
  "loginSecuritySetting",
  "publicContentSettings",
  "membershipSubscriptionBillingSettings",
  // #2306 — the member-guest policy singleton (epic #2305). Only
  // approvalRequired + pendingHoldExpiryDays travel; the two open-search
  // privacy toggles are excluded by owner decision D-18.
  "memberGuestSettings",
];

/** Build a stub DB whose singleton delegates return the given rows (else null). */
function stubDb(rows: Record<string, Record<string, unknown> | null>): ReadDb {
  const db: Record<string, unknown> = {
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  for (const name of SINGLETON_DELEGATES) {
    db[name] = {
      findUnique: vi.fn().mockResolvedValue(rows[name] ?? null),
    };
  }
  return db as unknown as ReadDb;
}

const MODULES = {
  kiosk: false, chores: false, financeDashboard: false, waitlist: false,
  xeroIntegration: false, bedAllocation: true, internetBankingPayments: false,
  addressAutocomplete: false, groupBookings: true, lockers: true,
  induction: true, workParties: true, promoCodes: true, hutLeaders: true,
  communications: true, memberNotices: true, eventsCalendar: true,
  skifieldConditions: true,
  twoFactor: false, analytics: false,
  // Every travelling module flag is a non-null Boolean; the #2200 dry-run
  // `constraints.required` audit rejects a projected null, so the fixture must
  // carry all of them (a real DB row always does).
  lobbyDisplay: false, aiAssistant: false, memberGuests: false,
};
const EMAIL = {
  clubName: "Grads", bookingsName: "Bookings", lodgeName: "Lodge",
  emailFromName: "Grads", supportEmail: "s@x.nz", contactEmail: "c@x.nz",
  publicUrl: "https://x.nz", lodgeTravelNote: "Turn left", doorCode: "1234",
};

async function exportBundle(includeDoorCodes: boolean) {
  return buildConfigExport({
    db: stubDb({ clubModuleSettings: MODULES, emailMessageSetting: EMAIL }),
    categories: ["club-settings"],
    includeDoorCodes,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer club-settings", () => {
  it("exports present singletons as JSON and omits door codes by default", async () => {
    const { zip } = await exportBundle(false);
    const { manifest, files } = readBundle(zip);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("club-settings/club-module-settings.json");
    expect(paths).toContain("club-settings/email-message-setting.json");
    // #2171: a singleton with no persisted row is still emitted, carrying the
    // effective defaults the app reads on a miss.
    expect(paths).toContain("club-settings/booking-defaults.json");

    const email = JSON.parse(
      strFromU8(files.get("club-settings/email-message-setting.json")!),
    );
    expect(email.clubName).toBe("Grads");
    // doorCode was dropped from EmailMessageSetting (fork #15); it must never be
    // emitted here — the lodge door code travels in lodge.json instead.
    expect("doorCode" in email).toBe(false);
  });

  it("keeps the legacy singleton file and exports its priority order", async () => {
    const { zip } = await buildConfigExport({
      db: stubDb({
        bedAllocationSettings: {
          autoAllocationEnabled: false,
          allocationPriorityOrder: ["REQUESTED_ROOM"],
        },
      }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-08-06T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    expect(
      JSON.parse(
        strFromU8(files.get("club-settings/bed-allocation-settings.json")!),
      ),
    ).toEqual({
      autoAllocationEnabled: false,
      allocationPriorityOrder: ["REQUESTED_ROOM"],
    });
  });

  it("normalises an older legacy singleton file's missing priority to the canonical order", async () => {
    const plan = await clubSettingsImporter.plan({
      db: stubDb({
        bedAllocationSettings: {
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
        },
      }),
      files: new Map([
        [
          "club-settings/bed-allocation-settings.json",
          strToU8(JSON.stringify({ autoAllocationEnabled: false })),
        ],
      ]),
      manifest: {} as never,
      mode: "merge",
      resolutions: new Map(),
    });
    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual([
      {
        entity: "bed-allocation-settings",
        key: "default",
        action: "update",
        changedFields: ["allocationPriorityOrder"],
      },
    ]);
  });

  it("rejects an invalid priority in the legacy singleton during the dry-run", async () => {
    const plan = await clubSettingsImporter.plan({
      db: stubDb({}),
      files: new Map([
        [
          "club-settings/bed-allocation-settings.json",
          strToU8(JSON.stringify({ allocationPriorityOrder: ["UNKNOWN"] })),
        ],
      ]),
      manifest: {} as never,
      mode: "overwrite",
      resolutions: new Map(),
    });
    expect(plan.items).toEqual([]);
    expect(plan.errors.join(" ")).toMatch(/unknown bed-allocation priority/i);
  });

  it("round-trips the club-identity facebookUrl and leaves the email fields on their own entry (C5 #1984)", async () => {
    const IDENTITY = {
      name: "Renamed Club",
      shortName: "RC",
      hutLeaderLabel: "Warden",
      facebookUrl: "https://www.facebook.com/renamed-club",
    };
    const { zip } = await buildConfigExport({
      db: stubDb({
        clubModuleSettings: MODULES,
        emailMessageSetting: EMAIL,
        clubIdentitySettings: IDENTITY,
      }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    const { files } = readBundle(zip);

    // facebookUrl travels on the club-identity-settings entry...
    const identity = JSON.parse(
      strFromU8(files.get("club-settings/club-identity-settings.json")!),
    );
    expect(identity.facebookUrl).toBe(IDENTITY.facebookUrl);
    expect(identity.name).toBe("Renamed Club");

    // ...and NOT on the email-message-setting entry (the four email fields stay
    // there; facebookUrl must never leak across).
    const email = JSON.parse(
      strFromU8(files.get("club-settings/email-message-setting.json")!),
    );
    expect("facebookUrl" in email).toBe(false);
    expect(email.supportEmail).toBe("s@x.nz");

    // Import round-trips: an absent target plans a create carrying facebookUrl.
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    const identityItem = plan.categories[0].items.find(
      (i) => i.entity === "club-identity-settings",
    );
    expect(identityItem?.action).toBe("create");
  });

  it("plans singleton create vs update against the target DB", async () => {
    const { zip } = await exportBundle(false);
    // Target: module settings differ (update); email settings absent (create).
    const target = stubDb({
      clubModuleSettings: { ...MODULES, bedAllocation: false },
    });
    const plan = await buildImportPlan(target, zip, { mode: "merge" });
    const items = plan.categories[0].items;
    const modules = items.find((i) => i.entity === "club-module-settings");
    const email = items.find((i) => i.entity === "email-message-setting");
    expect(modules?.action).toBe("update");
    expect(modules?.changedFields).toContain("bedAllocation");
    expect(email?.action).toBe("create");
  });
});

// AI Diagnostics (AID-2, #2371): the aiDiagnostics module flag is NON-TRAVELLING
// — enabling a paid, separately-keyed product is a per-deployment decision like
// magicLink/googleLogin. Pin it so a future edit cannot silently make it travel.
describe("aiDiagnostics is non-travelling (AID-2, #2371)", () => {
  it("excludes aiDiagnostics from the travelling club-module-settings fields", () => {
    const spec = SINGLETONS.find((s) => s.entity === "club-module-settings");
    expect(spec).toBeDefined();
    // It is NOT in the exported field set...
    expect(spec?.fields).not.toContain("aiDiagnostics");
    // ...and IS classified as deliberately-excluded with a reason (#2178 guard).
    const excluded = excludedColumnsFor(spec!);
    expect(excluded).toHaveProperty("aiDiagnostics");
    expect(excluded.aiDiagnostics?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("registers NO travelling singleton for the Diagnostics settings/metering tables", () => {
    // DiagnosticsSettings holds a deployment-local spend budget; the three usage
    // tables are runtime metering. None is a config-transfer singleton, so a
    // source club's budget/usage can never land on a target.
    for (const forbidden of [
      "diagnostics-settings",
      "diagnostics-usage-monthly",
      "diagnostics-usage-event",
      "diagnostics-budget-reservation",
    ]) {
      expect(SINGLETONS.map((s) => s.entity)).not.toContain(forbidden);
    }
  });
});

// Guard against the #153 regression: every ClubModuleSettings read in this
// category (export, plan, apply) must use the shared column select so a
// retired-but-not-yet-dropped column never appears in the generated SQL (see
// CLUB_MODULE_SETTINGS_COLUMN_SELECT in src/config/modules.ts and #150/#139).
describe("club-module-settings singleton reads use the explicit column select", () => {
  it("declares the shared select on the SINGLETONS spec", () => {
    const spec = SINGLETONS.find((s) => s.entity === "club-module-settings");
    expect(spec?.select).toEqual(CLUB_MODULE_SETTINGS_COLUMN_SELECT);
  });

  it("passes the select through on export", async () => {
    const db = stubDb({ clubModuleSettings: MODULES });
    await buildConfigExport({
      db,
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    const findUnique = (
      db as unknown as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } }
    ).clubModuleSettings.findUnique;
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
  });

  it("passes the select through on plan", async () => {
    const { zip } = await exportBundle(false);
    const target = stubDb({ clubModuleSettings: MODULES });
    await buildImportPlan(target, zip, { mode: "merge" });
    const findUnique = (
      target as unknown as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } }
    ).clubModuleSettings.findUnique;
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
  });

  it("passes the select through on apply (create branch, no existing row)", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue(null);
    const tx = {
      clubModuleSettings: {
        findUnique,
        upsert,
      },
    } as unknown as TxDb;
    const files = new Map<string, Uint8Array>();
    files.set(
      "club-settings/club-module-settings.json",
      strToU8(JSON.stringify(MODULES)),
    );
    const ctx: ApplyContext = {
      tx,
      files,
      manifest: {} as unknown as ApplyContext["manifest"],
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "test-actor",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    };
    await clubSettingsImporter.apply(ctx);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      }),
    );
  });

  it("passes the select through on apply (update branch, existing row changed)", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ ...MODULES, bedAllocation: false });
    const upsert = vi.fn().mockResolvedValue(null);
    const tx = {
      clubModuleSettings: {
        findUnique,
        upsert,
      },
    } as unknown as TxDb;
    const files = new Map<string, Uint8Array>();
    files.set(
      "club-settings/club-module-settings.json",
      strToU8(JSON.stringify(MODULES)),
    );
    const ctx: ApplyContext = {
      tx,
      files,
      manifest: {} as unknown as ApplyContext["manifest"],
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "test-actor",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    };
    await clubSettingsImporter.apply(ctx);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      }),
    );
  });
});

// Guard against the class of bug where an upstream schema change drops/renames a
// column that a singleton allowlist still names — the club-settings apply uses an
// untyped delegate, so typecheck can't catch it and it only fails at write time
// on the server (as EmailMessageSetting.doorCode did after fork #15). This
// validates every singleton field against the real Prisma model columns.
describe("club-settings allowlists match the Prisma schema", () => {
  it("every singleton field is a real column on its model", () => {
    const columnsByModel = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.map((f) => f.name))]),
    );
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const modelName = spec.delegate[0].toUpperCase() + spec.delegate.slice(1);
      const columns = columnsByModel.get(modelName);
      if (!columns) {
        problems.push(`delegate "${spec.delegate}" → no Prisma model "${modelName}"`);
        continue;
      }
      for (const field of spec.fields) {
        if (!columns.has(field)) problems.push(`${modelName}.${field} is not a column`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// Reverse drift guard (#2178). The block above checks fields ⊆ columns (a spec
// naming a column that no longer exists). This checks the OTHER direction:
// columns ⊆ fields ∪ optInFields ∪ excluded. Every real column on each model
// must be either exported or named in the deliberate exclusion set with a
// reason, so a newly added column belongs to neither and fails here — someone
// has to classify it as should-travel or deliberately-excluded rather than it
// silently never travelling (as useFeeScheduleItemCodes / magicLink / googleLogin
// did before this audit).
describe("club-settings allowlists account for every column (reverse guard)", () => {
  const modelsByName = new Map(
    Prisma.dmmf.datamodel.models.map((m) => [m.name, m]),
  );
  const modelNameOf = (delegate: string) =>
    delegate[0].toUpperCase() + delegate.slice(1);

  it("every model column is exported or named in the exclusion set with a reason", () => {
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const modelName = modelNameOf(spec.delegate);
      const model = modelsByName.get(modelName);
      if (!model) {
        problems.push(`delegate "${spec.delegate}" → no Prisma model "${modelName}"`);
        continue;
      }
      const excluded = excludedColumnsFor(spec);
      const accountedFor = new Set([
        ...spec.fields,
        ...(spec.optInFields ?? []),
        ...Object.keys(excluded),
      ]);
      for (const field of model.fields) {
        // Relations are not DB columns; only scalar/enum fields map to columns.
        if (field.kind === "object") continue;
        if (!accountedFor.has(field.name)) {
          problems.push(
            `${modelName}.${field.name} is neither exported nor excluded — classify it (#2178)`,
          );
          continue;
        }
        // An excluded column must carry a non-empty reason.
        if (field.name in excluded && !excluded[field.name]?.trim()) {
          problems.push(`${modelName}.${field.name} excluded without a reason`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("no column is both exported and excluded", () => {
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const exported = new Set([...spec.fields, ...(spec.optInFields ?? [])]);
      // Merged set: a COMMON_EXCLUDED_COLUMNS entry added to `fields` is just as
      // contradictory as a per-spec one, and the defaults-coverage test skips the
      // DEFAULTS_INTENTIONALLY_PARTIAL singletons, so it must be caught here.
      for (const col of Object.keys(excludedColumnsFor(spec))) {
        if (exported.has(col)) {
          problems.push(`${spec.entity}.${col} is in both fields and excluded`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every model-specific exclusion names a real column (no stale exclusions)", () => {
    // COMMON_EXCLUDED_COLUMNS is a tolerant superset (e.g. BookingDefaults has
    // no timestamps), so only the per-spec `excluded` entries are checked here.
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const columns = new Set(
        (modelsByName.get(modelNameOf(spec.delegate))?.fields ?? []).map(
          (f) => f.name,
        ),
      );
      for (const col of Object.keys(spec.excluded ?? {})) {
        if (!columns.has(col)) {
          problems.push(`${spec.entity}.${col} is excluded but not a column`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the shared exclusion set covers the singleton id/audit/timestamp columns", () => {
    // Membership assertion so the shared set cannot be silently emptied.
    expect(Object.keys(COMMON_EXCLUDED_COLUMNS).sort()).toEqual([
      "createdAt",
      "id",
      "updatedAt",
      "updatedByMemberId",
    ]);
  });
});

// ---------------------------------------------------------------------------
// #2171 — a singleton the club has NEVER SAVED still travels, carrying the
// effective defaults every read site synthesises on a miss, so an import
// reproduces the source club instead of leaving the target's own values alone.
// ---------------------------------------------------------------------------

type SingletonSpy = {
  findUnique: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
};

/** Apply-side stub: every singleton delegate with a findUnique + upsert spy. */
function stubTx(rows: Record<string, Record<string, unknown> | null>): {
  tx: TxDb;
  delegates: Record<string, SingletonSpy>;
} {
  const delegates: Record<string, SingletonSpy> = {};
  for (const name of SINGLETON_DELEGATES) {
    delegates[name] = {
      findUnique: vi.fn().mockResolvedValue(rows[name] ?? null),
      upsert: vi.fn().mockResolvedValue(null),
    };
  }
  return { tx: delegates as unknown as TxDb, delegates };
}

function applyCtx(
  tx: TxDb,
  files: Map<string, Uint8Array>,
  mode: "merge" | "overwrite",
): ApplyContext {
  return {
    tx,
    files,
    manifest: {} as unknown as ApplyContext["manifest"],
    mode,
    resolutions: new Map(),
    actorMemberId: "test-actor",
    imageRemap: new Map(),
    notes: { doorCodesWritten: [] },
  };
}

/** Export from a source club whose singleton rows have never been saved. */
async function exportFromUnsavedClub() {
  return buildConfigExport({
    db: stubDb({}),
    categories: ["club-settings"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

function readJson(files: Map<string, Uint8Array>, entity: string) {
  return JSON.parse(strFromU8(files.get(`club-settings/${entity}.json`)!));
}

describe("club-settings exports effective defaults for an unsaved singleton (#2171)", () => {
  it("emits an entry for EVERY singleton, not only the persisted ones", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);
    for (const spec of SINGLETONS) {
      expect(files.has(`club-settings/${spec.entity}.json`)).toBe(true);
    }
  });

  it("carries the values the app reads on a miss, sourced from the getters' own defaults", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);

    // Read-site `?? x` defaults, now shared constants.
    expect(readJson(files, "booking-defaults")).toEqual({
      nonMemberHoldEnabled: DEFAULT_BOOKING_DEFAULTS.nonMemberHoldEnabled,
      nonMemberHoldDays: DEFAULT_BOOKING_DEFAULTS.nonMemberHoldDays,
      waitlistCrossLodgeOrder: DEFAULT_BOOKING_DEFAULTS.waitlistCrossLodgeOrder,
    });
    expect(readJson(files, "booking-request-settings")).toEqual({
      ...DEFAULT_BOOKING_REQUEST_SETTINGS,
    });
    expect(readJson(files, "group-discount-setting")).toEqual({
      ...DEFAULT_GROUP_DISCOUNT_SETTING,
    });

    // A `false` default must survive the export, not collapse to null.
    expect(
      readJson(files, "booking-request-settings").showPricingToNonMembers,
    ).toBe(false);

    // A nullable column whose default IS null still exports as null.
    expect(readJson(files, "membership-lockout-settings")).toEqual({
      // #2543/#2561: the three-way `mode` REPLACED the boolean `enabled`, whose
      // column was backfilled into it and dropped in the same release. A bundle
      // exported now carries the mode alone — `toEqual` is exact, so this fails if
      // the legacy key ever creeps back into the exported field list.
      mode: DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.mode,
      financialYearEndMonthOverride: null,
      textFallbackEnabled:
        DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.textFallbackEnabled,
      // #2178: the fee-schedule paid-detection toggle now travels too.
      useFeeScheduleItemCodes:
        DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS.useFeeScheduleItemCodes,
    });

    // Default COPY travels too, so the target reads the same words.
    expect(readJson(files, "membership-cancellation-setting").warningText).toBe(
      DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS.warningText,
    );
  });

  it("exports the two override-only identity singletons as 'no override', never the install's own club.json identity", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);
    expect(readJson(files, "club-identity-settings")).toEqual({
      name: null,
      shortName: null,
      hutLeaderLabel: null,
      facebookUrl: null,
    });
    expect(readJson(files, "email-message-setting")).toEqual({
      clubName: null,
      bookingsName: null,
      emailFromName: null,
      supportEmail: null,
      contactEmail: null,
      publicUrl: null,
    });
  });

  it("round-trips into a target that HAS a row: the target moves to the source's effective values", async () => {
    const { zip } = await exportFromUnsavedClub();
    // The target explicitly saved a longer quote window than the source runs on.
    const targetRow = {
      ...DEFAULT_BOOKING_REQUEST_SETTINGS,
      quoteResponseTtlDays: 30,
    };
    const plan = await buildImportPlan(
      stubDb({ bookingRequestSettings: targetRow }),
      zip,
      { mode: "merge" },
    );
    const item = plan.categories[0].items.find(
      (i) => i.entity === "booking-request-settings",
    );
    expect(item?.action).toBe("update");
    expect(item?.changedFields).toEqual(["quoteResponseTtlDays"]);

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({ bookingRequestSettings: targetRow });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(delegates.bookingRequestSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          quoteResponseTtlDays:
            DEFAULT_BOOKING_REQUEST_SETTINGS.quoteResponseTtlDays,
        }),
      }),
    );
  });

  it("round-trips into a target with NO row: it creates the row, and every value it creates is the default the target already read", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({});
    const result = await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));

    // Effect on what the app reads: none. Effect on the database: the row is
    // MATERIALISED — the cost the owner accepted on #2171. Except for the two
    // all-null override-only singletons, which create nothing (test below).
    expect(result.created).toBe(
      SINGLETONS.length - DEFAULTS_INTENTIONALLY_PARTIAL.size,
    );
    expect(delegates.bookingRequestSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { id: "default", ...DEFAULT_BOOKING_REQUEST_SETTINGS },
      }),
    );
    expect(delegates.groupDiscountSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { id: "default", ...DEFAULT_GROUP_DISCOUNT_SETTING },
      }),
    );
  });

  it.each(["merge", "overwrite"] as const)(
    "creates NO row for an all-null override-only singleton (%s), so boot-time identity self-heal still fires",
    async (mode) => {
      // Regression guard. clubIdentitySelfHealStep.isPresent keys purely on the
      // ClubIdentitySettings ROW existing, and the self-heal runner is skipped
      // while clubConfigSource !== "primary". If an import planted an all-null
      // row on such an install, that presence check would be satisfied forever
      // and the identity would never be copied from config/club.json once it
      // was fixed — clubIdentityName in the setup snapshot would stay null.
      const { zip } = await exportFromUnsavedClub();
      const { files } = readBundle(zip);
      const { tx, delegates } = stubTx({});
      await clubSettingsImporter.apply(applyCtx(tx, files, mode));

      expect(delegates.clubIdentitySettings.upsert).not.toHaveBeenCalled();
      expect(delegates.emailMessageSetting.upsert).not.toHaveBeenCalled();
      // A singleton with real defaults is unaffected — it still materialises.
      expect(delegates.groupDiscountSetting.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it("previews that same no-op as Unchanged rather than promising a New row", async () => {
    const { zip } = await exportFromUnsavedClub();
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    const items = new Map(
      plan.categories[0].items.map((i) => [i.entity, i]),
    );
    for (const entity of DEFAULTS_INTENTIONALLY_PARTIAL) {
      expect(items.get(entity)?.action).toBe("unchanged");
      expect(items.get(entity)?.changedFields).toBeUndefined();
    }
    expect(items.get("group-discount-setting")?.action).toBe("create");
  });

  it("still creates an identity row when the bundle carries a real override", async () => {
    // The skip is about an EMPTY file, not about identity being untransferable:
    // a source club that saved its identity moves it across as normal.
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/club-identity-settings.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(
            JSON.stringify({
              name: "Source Alpine Club",
              shortName: null,
              hutLeaderLabel: null,
              facebookUrl: null,
            }),
          ),
        },
      ],
      appVersion: "0.12.2",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({});
    const result = await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(result.created).toBe(1);
    expect(delegates.clubIdentitySettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: "Source Alpine Club" }),
      }),
    );
  });

  it("still imports an older bundle that omits a singleton entirely (no format-version bump needed)", async () => {
    // A bundle exported before this change: one singleton present, the rest
    // absent. The importer is files-first, so the absent ones stay untouched.
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/group-discount-setting.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(
            JSON.stringify({ minGroupSize: 8, summerOnly: false, enabled: true }),
          ),
        },
      ],
      appVersion: "0.12.2",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });

    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.categories[0].items.map((i) => i.entity)).toEqual([
      "group-discount-setting",
    ]);
    expect(plan.categories[0].errors).toEqual([]);

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({});
    const result = await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(result.created).toBe(1);
    expect(delegates.groupDiscountSetting.upsert).toHaveBeenCalledTimes(1);
    expect(delegates.bookingRequestSettings.upsert).not.toHaveBeenCalled();
  });
});

// #2178 — the newly-travelling MembershipLockoutSettings.useFeeScheduleItemCodes
// must round-trip on import, AND a bundle exported by an older version that omits
// the field must still import unchanged (field-level missing-field tolerance, no
// bundle format-version bump needed).
describe("membership-lockout useFeeScheduleItemCodes round-trips (#2178)", () => {
  it("updates an existing target when the bundle carries the flag on", async () => {
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/membership-lockout-settings.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(
            JSON.stringify({
              enabled: true,
              financialYearEndMonthOverride: null,
              textFallbackEnabled: true,
              useFeeScheduleItemCodes: true,
            }),
          ),
        },
      ],
      appVersion: "0.13.2",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    const target = {
      ...DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
      useFeeScheduleItemCodes: false,
    };
    const plan = await buildImportPlan(
      stubDb({ membershipLockoutSettings: target }),
      zip,
      { mode: "merge" },
    );
    const item = plan.categories[0].items.find(
      (i) => i.entity === "membership-lockout-settings",
    );
    expect(item?.action).toBe("update");
    expect(item?.changedFields).toEqual(["useFeeScheduleItemCodes"]);

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({ membershipLockoutSettings: target });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(delegates.membershipLockoutSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ useFeeScheduleItemCodes: true }),
      }),
    );
  });

  it("leaves the field untouched when an OLDER bundle omits it", async () => {
    // Pre-#2178 export: the three original fields, no useFeeScheduleItemCodes.
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/membership-lockout-settings.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(
            JSON.stringify({
              enabled: true,
              financialYearEndMonthOverride: null,
              textFallbackEnabled: true,
            }),
          ),
        },
      ],
      appVersion: "0.12.2",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    // Target already runs with the flag ON; the older bundle must not clear it.
    const target = {
      ...DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
      useFeeScheduleItemCodes: true,
    };
    const plan = await buildImportPlan(
      stubDb({ membershipLockoutSettings: target }),
      zip,
      { mode: "overwrite" },
    );
    const item = plan.categories[0].items.find(
      (i) => i.entity === "membership-lockout-settings",
    );
    expect(item?.action).toBe("unchanged");
    expect(plan.categories[0].errors).toEqual([]);

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({ membershipLockoutSettings: target });
    await clubSettingsImporter.apply(applyCtx(tx, files, "overwrite"));
    // No write at all: the only bundle fields equal the target, and the omitted
    // useFeeScheduleItemCodes is never touched.
    expect(delegates.membershipLockoutSettings.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2200 — the three settings singletons the model-level completeness audit
// classified PORTABLE (login/security policy, public-content visibility policy,
// membership billing policy) now export, import, and round-trip like the rest of
// the club-settings category, and their effective defaults stay bound to the
// Prisma schema so the exporter cannot drift from what an unsaved club reads.
// ---------------------------------------------------------------------------

/** Extract the raw token inside `@default(...)` for a field, from the schema. */
function schemaDefaultToken(
  schema: string,
  modelName: string,
  fieldName: string,
): string | null {
  const lines = schema.split(/\r?\n/);
  let inModel = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.match(new RegExp(`^model\\s+${modelName}\\s*\\{`))) {
      inModel = true;
      continue;
    }
    if (inModel && line.startsWith("}")) break;
    if (inModel && line.match(new RegExp(`^${fieldName}\\s`))) {
      const m = line.match(/@default\(([^)]*)\)/);
      return m ? m[1].replace(/^"|"$/g, "") : null;
    }
  }
  return null;
}

describe("#2200 portable singletons export/import and stay schema-bound", () => {
  const SCHEMA = readFileSync(
    path.resolve(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );

  it("emits an entry for each of the three new singletons, carrying schema-default values on a miss", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);

    expect(readJson(files, "login-security-setting")).toEqual({
      ...DEFAULT_LOGIN_SECURITY_POLICY,
    });
    expect(readJson(files, "public-content-settings")).toEqual({
      ...DEFAULT_PUBLIC_CONTENT_SETTINGS,
    });
    expect(readJson(files, "membership-subscription-billing-settings")).toEqual({
      ...DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS,
    });
  });

  it("never exports the instance-local Book-Now destination fields", async () => {
    const { zip } = await exportFromUnsavedClub();
    const { files } = readBundle(zip);
    const publicContent = readJson(files, "public-content-settings");
    expect("bookNowTarget" in publicContent).toBe(false);
    expect("bookNowPageId" in publicContent).toBe(false);
  });

  it("round-trips a saved login-security policy: create on an absent target, update on a differing one", async () => {
    const saved = {
      minPasswordLength: 16,
      requireUppercase: true,
      requireLowercase: true,
      requireDigit: true,
      requireSymbol: false,
      magicLinkTtlMinutes: 30,
    };
    const { zip } = await buildConfigExport({
      db: stubDb({ loginSecuritySetting: saved }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.14.0",
      prismaMigration: null,
      generatedAt: "2026-07-23T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    expect(readJson(files, "login-security-setting")).toEqual(saved);

    // Absent target → create.
    const createPlan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(
      createPlan.categories[0].items.find((i) => i.entity === "login-security-setting")?.action,
    ).toBe("create");

    // Differing target → update, only the changed field reported.
    const target = { ...saved, minPasswordLength: 12 };
    const plan = await buildImportPlan(
      stubDb({ loginSecuritySetting: target }),
      zip,
      { mode: "merge" },
    );
    const item = plan.categories[0].items.find(
      (i) => i.entity === "login-security-setting",
    );
    expect(item?.action).toBe("update");
    expect(item?.changedFields).toEqual(["minPasswordLength"]);

    const { tx, delegates } = stubTx({ loginSecuritySetting: target });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(delegates.loginSecuritySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ minPasswordLength: 16 }) }),
    );
  });

  it("round-trips the billing policy (invoiceDueDays + familyBillingMode)", async () => {
    const saved = { invoiceDueDays: 45, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" };
    const { zip } = await buildConfigExport({
      db: stubDb({ membershipSubscriptionBillingSettings: saved }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.14.0",
      prismaMigration: null,
      generatedAt: "2026-07-23T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    expect(readJson(files, "membership-subscription-billing-settings")).toEqual(saved);

    const target = { invoiceDueDays: 30, familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" };
    const { tx, delegates } = stubTx({ membershipSubscriptionBillingSettings: target });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    expect(delegates.membershipSubscriptionBillingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          invoiceDueDays: 45,
          familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
        }),
      }),
    );
  });

  it("round-trips public-content visibility gates (gates + committee-photo mode travel in both modes)", async () => {
    const saved = {
      membershipTypes: true, entranceFees: true, hutFees: false,
      bookingPolicySummary: true, cancellationPolicy: false, annualFees: true,
      showBookNow: false,
      // The committee-photo display mode is portable public-page config too: a
      // non-default enum value travels like the gates.
      committeePhotoDisplay: "CIRCLE",
    };
    const { zip } = await buildConfigExport({
      db: stubDb({ publicContentSettings: { ...saved, bookNowTarget: "PAGE", bookNowPageId: "pg_source" } }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.14.0",
      prismaMigration: null,
      generatedAt: "2026-07-23T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    // The instance-local destination fields were dropped; only policy travels.
    expect(readJson(files, "public-content-settings")).toEqual(saved);

    const { tx, delegates } = stubTx({});
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    // A `false` gate is non-blank, so it is written on create.
    expect(delegates.publicContentSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { id: "default", ...saved } }),
    );
  });

  it("imports an OLDER bundle that omits the new singletons, leaving each untouched (no format-version bump)", async () => {
    // A pre-#2200 export: only one legacy singleton present.
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/group-discount-setting.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(JSON.stringify(DEFAULT_GROUP_DISCOUNT_SETTING)),
        },
      ],
      appVersion: "0.13.0",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-23T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({});
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    // Files-first: the three new singletons are absent, so none is written.
    expect(delegates.loginSecuritySetting.upsert).not.toHaveBeenCalled();
    expect(delegates.publicContentSettings.upsert).not.toHaveBeenCalled();
    expect(delegates.membershipSubscriptionBillingSettings.upsert).not.toHaveBeenCalled();
  });

  it("keeps each new singleton's effective default bound to the Prisma schema column default", () => {
    // The exporter emits these on a miss; if a schema default changes without the
    // constant, an unsaved club would export a stale value. Bind them together.
    const cases: Array<[string, Record<string, unknown>]> = [
      ["LoginSecuritySetting", { ...DEFAULT_LOGIN_SECURITY_POLICY }],
      ["PublicContentSettings", { ...DEFAULT_PUBLIC_CONTENT_SETTINGS }],
      ["MembershipSubscriptionBillingSettings", { ...DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS }],
    ];
    const problems: string[] = [];
    for (const [model, defaults] of cases) {
      for (const [field, value] of Object.entries(defaults)) {
        const token = schemaDefaultToken(SCHEMA, model, field);
        if (token === null) {
          problems.push(`${model}.${field}: no @default() in schema`);
        } else if (token !== String(value)) {
          problems.push(`${model}.${field}: schema @default(${token}) != constant ${String(value)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the billing family-mode default in lockstep with DEFAULT_FAMILY_BILLING_MODE", () => {
    expect(DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS.familyBillingMode).toBe(
      DEFAULT_FAMILY_BILLING_MODE,
    );
  });

  it("ties the member-guest pending-hold bounds to the shared constants (#2306)", () => {
    // The importer's bounds and the bounds MG2's admin route will enforce are
    // the same two numbers. Written as literals they were free to drift; this
    // pins them to MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN/MAX.
    const spec = SINGLETONS.find((entry) => entry.entity === "member-guest-settings");
    expect(spec, "the member-guest-settings singleton is not registered").toBeDefined();
    expect(spec!.constraints?.pendingHoldExpiryDays).toEqual({
      required: true,
      min: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
      max: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
    });
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeGreaterThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
    );
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeLessThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
    );
  });
});

// ---------------------------------------------------------------------------
// Owner decision D-18 (#2306/#2307, epic #2305). The member-guest singleton is a
// deliberate SPLIT: the two POLICY fields travel, the two PRIVACY toggles never
// do. The reverse guard above only demands that every column be classified
// somehow; these tests pin WHICH side of the split each column is on, and prove
// it behaviourally — because MG2 (#2307) adds the admin route that lets an admin
// turn open member search on, and from that point a bundle able to carry the
// toggle would be a way to widen a target club's member privacy without its own
// admin ever choosing to.
// ---------------------------------------------------------------------------
describe("D-18: the two open-search privacy toggles never travel", () => {
  const spec = () =>
    SINGLETONS.find((entry) => entry.entity === "member-guest-settings")!;

  it("classifies the split exactly: two fields exported, two excluded with reasons", () => {
    expect(spec().fields).toEqual(["approvalRequired", "pendingHoldExpiryDays"]);
    const excluded = spec().excluded ?? {};
    expect(Object.keys(excluded).sort()).toEqual([
      "openMemberSearchEnabled",
      "openMemberSearchIncludesMinors",
    ]);
    // A reason is not decoration: the reverse guard accepts any non-empty string,
    // so pin that both name the owner judgement rather than being back-filled
    // with "not needed".
    for (const reason of Object.values(excluded)) {
      expect(reason).toMatch(/OWNER JUDGEMENT \(#2306, D-18\)/);
    }
  });

  it("omits both toggles from the exported file even when the source club has them ON", async () => {
    const { zip } = await buildConfigExport({
      db: stubDb({
        memberGuestSettings: {
          approvalRequired: false,
          pendingHoldExpiryDays: 21,
          openMemberSearchEnabled: true,
          openMemberSearchIncludesMinors: true,
        },
      }),
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.14.0",
      prismaMigration: null,
      generatedAt: "2026-07-30T00:00:00.000Z",
    });
    const { files } = readBundle(zip);
    const exported = readJson(files, "member-guest-settings");
    // The policy half travels...
    expect(exported).toEqual({ approvalRequired: false, pendingHoldExpiryDays: 21 });
    // ...and the privacy half is absent, not merely false.
    expect("openMemberSearchEnabled" in exported).toBe(false);
    expect("openMemberSearchIncludesMinors" in exported).toBe(false);
  });

  it("refuses to apply the toggles even when a HAND-EDITED bundle carries them true", async () => {
    // The real attack shape: a bundle is a zip an operator can edit. Applying it
    // must move the policy fields and leave the target's privacy posture alone.
    const files = new Map<string, Uint8Array>([
      [
        "club-settings/member-guest-settings.json",
        strToU8(
          JSON.stringify({
            approvalRequired: false,
            pendingHoldExpiryDays: 30,
            openMemberSearchEnabled: true,
            openMemberSearchIncludesMinors: true,
          }),
        ),
      ],
    ]);
    const { tx, delegates } = stubTx({
      memberGuestSettings: { ...DEFAULT_MEMBER_GUEST_SETTINGS },
    });
    await clubSettingsImporter.apply(applyCtx(tx, files, "overwrite"));

    expect(delegates.memberGuestSettings.upsert).toHaveBeenCalledTimes(1);
    const args = delegates.memberGuestSettings.upsert.mock.calls[0][0];
    for (const half of [args.create, args.update]) {
      expect(half).not.toHaveProperty("openMemberSearchEnabled");
      expect(half).not.toHaveProperty("openMemberSearchIncludesMinors");
    }
    expect(args.update).toEqual({ approvalRequired: false, pendingHoldExpiryDays: 30 });
  });

  it("never reports a privacy toggle as a changed field in the dry-run either", async () => {
    // An admin reviewing the plan must not be shown a privacy change the apply
    // will not make (and vice versa).
    const zip = buildBundle({
      entries: [
        {
          path: "club-settings/member-guest-settings.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(
            JSON.stringify({
              ...DEFAULT_MEMBER_GUEST_SETTINGS,
              openMemberSearchEnabled: true,
              openMemberSearchIncludesMinors: true,
            }),
          ),
        },
      ],
      appVersion: "0.14.0",
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-30T00:00:00.000Z",
    });
    const plan = await buildImportPlan(
      stubDb({ memberGuestSettings: { ...DEFAULT_MEMBER_GUEST_SETTINGS } }),
      zip,
      { mode: "overwrite" },
    );
    const item = plan.categories
      .flatMap((category) => category.items)
      .find((entry) => entry.entity === "member-guest-settings");
    expect(item?.action).toBe("unchanged");
    expect(item?.changedFields ?? []).toEqual([]);
  });
});

describe("every singleton spec declares defaults for every field it exports", () => {
  it("covers each exported field, and only the two override-only singletons opt out", () => {
    // Assert the MEMBERSHIP of the exemption set, not just its effect: without
    // this, adding a third entity silently exempts a real singleton from the
    // coverage check below and the test stays green.
    expect([...DEFAULTS_INTENTIONALLY_PARTIAL].sort()).toEqual([
      "club-identity-settings",
      "email-message-setting",
    ]);
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const defaults = spec.defaults();
      if (DEFAULTS_INTENTIONALLY_PARTIAL.has(spec.entity)) {
        // These two must stay EMPTY: exporting an install-local fallback
        // identity would rename the target club.
        expect(Object.keys(defaults)).toEqual([]);
        continue;
      }
      for (const field of spec.fields) {
        if (!(field in defaults) || defaults[field] === undefined) {
          problems.push(`${spec.entity}.${field} has no declared default`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #2200 — singleton dry-run validation. Config transfer bypasses the admin API,
// so the singleton parser mirrors its bounds: an out-of-range Int, a present
// null on a required field, or an invalid enum must fail the DRY-RUN (plan
// errors), not the write. (Prisma 7's DMMF strips isRequired, so `required` is
// declared per-field in the spec `constraints`.)
// ---------------------------------------------------------------------------

function singletonBundle(entity: string, obj: Record<string, unknown>) {
  return buildBundle({
    entries: [
      {
        path: `club-settings/${entity}.json`,
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(JSON.stringify(obj)),
      },
    ],
    appVersion: "0.14.0",
    prismaMigration: null,
    includedCategories: ["club-settings"],
    doorCodesIncluded: false,
    generatedAt: "2026-07-23T00:00:00.000Z",
  });
}

describe("#2200 singleton dry-run validation (bounds, required, enum)", () => {
  it("rejects invoiceDueDays outside the admin 1–365 range", async () => {
    for (const bad of [0, -5, 999999]) {
      const zip = singletonBundle("membership-subscription-billing-settings", {
        invoiceDueDays: bad,
        familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
      });
      const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
      expect(plan.errors.join(" ")).toMatch(/invoiceDueDays — .*out of range.*1–365/);
    }
  });

  it("accepts an in-range invoiceDueDays and a valid familyBillingMode", async () => {
    const zip = singletonBundle("membership-subscription-billing-settings", {
      invoiceDueDays: 45,
      familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors).toEqual([]);
  });

  it("rejects an invalid familyBillingMode enum value", async () => {
    const zip = singletonBundle("membership-subscription-billing-settings", {
      invoiceDueDays: 30,
      familyBillingMode: "NOT_A_MODE",
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(
      /familyBillingMode — .*is not a valid FamilyBillingMode/,
    );
  });

  it("rejects a present null on a required login-security field", async () => {
    const zip = singletonBundle("login-security-setting", {
      minPasswordLength: null,
      requireUppercase: false,
      requireLowercase: false,
      requireDigit: false,
      requireSymbol: false,
      magicLinkTtlMinutes: 15,
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/minPasswordLength — null is not allowed/);
  });

  it("rejects a present null on a required public-content gate", async () => {
    const zip = singletonBundle("public-content-settings", {
      membershipTypes: null,
      entranceFees: false,
      hutFees: false,
      bookingPolicySummary: false,
      cancellationPolicy: false,
      annualFees: false,
      showBookNow: true,
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/membershipTypes — null is not allowed/);
  });

  // The pre-existing twelve singletons carry the same per-field `constraints`
  // as the three #2200 additions (nullability audit). Representative coverage:
  // a required-null reject, a nullable-null accept, and a mirrored range bound.
  it("rejects a present null on a required booking-defaults field", async () => {
    const zip = singletonBundle("booking-defaults", {
      nonMemberHoldEnabled: null,
      nonMemberHoldDays: 7,
      waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(
      /nonMemberHoldEnabled — null is not allowed/,
    );
  });

  it("accepts a null on the nullable membership-lockout financialYearEndMonthOverride", async () => {
    // financialYearEndMonthOverride is Int? (null = follow Xero's accounting
    // year), so a present null must NOT fail the dry-run.
    const zip = singletonBundle("membership-lockout-settings", {
      enabled: true,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors).toEqual([]);
  });

  it("still enforces the 1–12 bound when financialYearEndMonthOverride is present", async () => {
    for (const bad of [0, 13]) {
      const zip = singletonBundle("membership-lockout-settings", {
        enabled: true,
        financialYearEndMonthOverride: bad,
        textFallbackEnabled: true,
        useFeeScheduleItemCodes: false,
      });
      const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
      expect(plan.errors.join(" ")).toMatch(
        /financialYearEndMonthOverride — .*out of range.*1–12/,
      );
    }
  });

  it("rejects group-discount minGroupSize outside the admin 2–200 range", async () => {
    for (const bad of [1, 201]) {
      const zip = singletonBundle("group-discount-setting", {
        minGroupSize: bad,
        summerOnly: true,
        enabled: false,
      });
      const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
      expect(plan.errors.join(" ")).toMatch(
        /minGroupSize — .*out of range.*2–200/,
      );
    }
  });

  it("rejects booking-defaults nonMemberHoldDays outside the admin 1–365 range", async () => {
    const zip = singletonBundle("booking-defaults", {
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 366,
      waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
    });
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(
      /nonMemberHoldDays — .*out of range.*1–365/,
    );
  });
});

describe("a pre-#2543 bundle's `enabled` key still imports to the right mode (#2543/#2561)", () => {
  /**
   * BUNDLE-FORMAT compatibility, which outlives the column. #2561 dropped `enabled`
   * from the database, but bundle FILES exported before #2543 are still on
   * operators' disks and in their backups, and each still records a real decision:
   * whether that club gated bookings on unpaid subscriptions.
   *
   * `enabled` is no longer an exported field, so without the reconcile hook it would
   * be an unknown key — silently dropped, with the target keeping its own mode while
   * the dry-run reported no change to the policy. A club importing a pre-#2543
   * bundle to turn the lockout OFF would be told it worked while every unpaid member
   * went on being refused. These cases are the guarantee that does not happen.
   */
  function lockoutBundle(
    row: Record<string, unknown>,
    appVersion = "0.13.2",
  ) {
    return buildBundle({
      entries: [
        {
          path: "club-settings/membership-lockout-settings.json",
          category: "club-settings",
          rowCount: 1,
          bytes: strToU8(JSON.stringify(row)),
        },
      ],
      appVersion,
      prismaMigration: null,
      includedCategories: ["club-settings"],
      doorCodesIncluded: false,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
  }

  const targetOnNonMemberPricing = {
    ...DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
    mode: "NON_MEMBER_PRICING",
  };

  it.each(["merge", "overwrite"] as const)(
    "a PRE-#2543 bundle (enabled only) writes the derived mode — %s mode",
    async (mode) => {
      // Before the reconcile hook: `enabled = false` was written, the dry-run said
      // "changed: enabled", the operator believed the lockout was off, and every
      // unpaid member went on being repriced and refused. Members over-charged,
      // silently, against a dry-run that said otherwise.
      const zip = lockoutBundle(
        {
          enabled: false,
          financialYearEndMonthOverride: null,
          textFallbackEnabled: true,
          useFeeScheduleItemCodes: false,
        },
        "0.13.1",
      );

      const plan = await buildImportPlan(
        stubDb({ membershipLockoutSettings: targetOnNonMemberPricing }),
        zip,
        { mode },
      );
      const item = plan.categories[0].items.find(
        (i) => i.entity === "membership-lockout-settings",
      );
      expect(item?.action).toBe("update");
      // The dry-run TELLS the operator the policy is moving, and names the field
      // that actually exists. `enabled` is no longer a column, so it can never
      // appear here — if it did, the apply would raise on an unknown Prisma field.
      expect(item?.changedFields).toContain("mode");
      expect(item?.changedFields).not.toContain("enabled");

      const { files } = readBundle(zip);
      const { tx, delegates } = stubTx({
        membershipLockoutSettings: targetOnNonMemberPricing,
      });
      await clubSettingsImporter.apply(applyCtx(tx, files, mode));
      const upsertArgs =
        delegates.membershipLockoutSettings.upsert.mock.calls[0][0];
      // The boolean's MEANING lands on the column that exists.
      expect(upsertArgs.update).toEqual(
        expect.objectContaining({ mode: "NO_BLOCK" }),
      );
      // ...and the dropped column's name never reaches Prisma.
      expect(upsertArgs.update).not.toHaveProperty("enabled");
      expect(upsertArgs.create).not.toHaveProperty("enabled");
    },
  );

  it("a null mode in MERGE mode still writes a mode derived from the boolean", async () => {
    // A source club that upgraded to the expand release but never opened the panel
    // exported `mode: null, enabled: false`. Merge mode drops the null, so without
    // the hook the target would be left on its own NON_MEMBER_PRICING while the
    // bundle plainly said the lockout was off.
    const zip = lockoutBundle({
      mode: null,
      enabled: false,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({
      membershipLockoutSettings: targetOnNonMemberPricing,
    });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    const upsertArgs = delegates.membershipLockoutSettings.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual(
      expect.objectContaining({ mode: "NO_BLOCK" }),
    );
    expect(upsertArgs.update).not.toHaveProperty("enabled");
  });

  it("a recognised mode in the bundle WINS over a stale legacy boolean beside it", async () => {
    // A post-#2543 expand-release bundle can carry both keys, and they can disagree
    // (that release wrote the boolean from the mode, but a hand-edited file need
    // not). The mode is the authority; the boolean is ignored rather than mapped.
    const zip = lockoutBundle({
      mode: "NON_MEMBER_PRICING",
      enabled: false,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });

    const { files } = readBundle(zip);
    const { tx, delegates } = stubTx({
      membershipLockoutSettings: {
        ...DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
        mode: "NO_BLOCK",
      },
    });
    await clubSettingsImporter.apply(applyCtx(tx, files, "merge"));
    const upsertArgs = delegates.membershipLockoutSettings.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toEqual(
      expect.objectContaining({ mode: "NON_MEMBER_PRICING" }),
    );
    expect(upsertArgs.update).not.toHaveProperty("enabled");
  });

  it("an UNRECOGNISED mode string is refused by the dry-run, not silently trusted", async () => {
    const zip = lockoutBundle({
      mode: "CHARGE_DOUBLE",
      enabled: true,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });
    const plan = await buildImportPlan(
      stubDb({ membershipLockoutSettings: targetOnNonMemberPricing }),
      zip,
      { mode: "merge" },
    );
    expect(plan.categories[0].errors.join(" ")).toContain("mode");
  });

  it("an unrecognised mode is refused EVEN WITH a legacy boolean the hook could have derived from", async () => {
    // The hook runs before the validation loop now, so it must NOT overwrite a mode
    // the bundle actually states. If it did, `mode: "CHARGE_DOUBLE", enabled: true`
    // would be silently "corrected" to HARD_BLOCK and a typo in a hand-edited file
    // would move a club's booking policy with no error at all.
    const zip = lockoutBundle({
      mode: "HRD_BLOCK",
      enabled: false,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: false,
    });
    const plan = await buildImportPlan(
      stubDb({ membershipLockoutSettings: targetOnNonMemberPricing }),
      zip,
      { mode: "merge" },
    );
    expect(plan.categories[0].errors.join(" ")).toMatch(
      /mode — "HRD_BLOCK" is not a valid SubscriptionLockoutMode/,
    );
  });

  it.each(["merge", "overwrite"] as const)(
    "a present null mode with NOTHING to derive from fails the dry-run — %s mode",
    async (mode) => {
      // The residual `mode` had while it carried no `required` rule. `mode` is now a
      // NOT NULL column, and nothing upstream can fix this file: there is no
      // `enabled` key for the hook to read, so the null survives to the write. On a
      // target with no settings row the apply's create branch passes the payload
      // unfiltered (`create: { id: "default", ...data }`), and overwrite mode passes
      // it unfiltered on the update branch too, so Prisma gets `mode: null` against
      // a non-nullable enum and the whole import transaction aborts on a raw driver
      // error instead of a dry-run message. It must fail HERE.
      const zip = lockoutBundle({
        mode: null,
        financialYearEndMonthOverride: null,
        textFallbackEnabled: true,
        useFeeScheduleItemCodes: false,
      });
      const plan = await buildImportPlan(stubDb({}), zip, { mode });
      expect(plan.categories[0].errors.join(" ")).toMatch(
        /mode — null is not allowed \(required setting\)/,
      );
    },
  );

  it("requiring mode costs a PRE-#2543 bundle nothing, because the key is absent rather than null", async () => {
    // The reason `required` is safe here: `parseSingleton` skips a field that is not
    // in the record at all, so the rule can only ever fire on a PRESENT null. A
    // bundle exported before #2543 carries `enabled` and no `mode` key, and must
    // still import cleanly.
    const zip = lockoutBundle(
      {
        enabled: true,
        financialYearEndMonthOverride: null,
        textFallbackEnabled: true,
        useFeeScheduleItemCodes: false,
      },
      "0.13.1",
    );
    const plan = await buildImportPlan(stubDb({}), zip, { mode: "overwrite" });
    expect(plan.errors).toEqual([]);
    expect(plan.categories[0].errors).toEqual([]);
  });
});
