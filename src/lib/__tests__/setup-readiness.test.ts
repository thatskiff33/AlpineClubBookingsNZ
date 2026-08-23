import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { decideClubTimeZoneBackfill } from "@/lib/config-self-heal-steps";
import {
  SETUP_STEP_IDS,
  buildSetupReadiness,
  normalizeSetupProgress,
  renderSetupCheckReport,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

const baseEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  NEXTAUTH_URL: "https://club.example.org",
  // Strong (>= 32 chars, non-placeholder) so the auth-secret strength check
  // (#2079) stays green in the "complete setup" scenario.
  AUTH_SECRET: "a".repeat(48),
  CRON_SECRET: "cron-secret",
  SEED_ADMIN_EMAIL: "admin@example.org",
  SEED_ADMIN_PASSWORD: "change-me",
  // Stripe credentials are captured in-app now (#2082); legacy STRIPE_* env vars
  // are intentionally absent here so the Stripe check does not raise the "remove
  // the legacy vars" warning. The keys are represented in the DB snapshot below.
  SMTP_HOST: "email-smtp.ap-southeast-2.amazonaws.com",
  SMTP_PORT: "587",
  AWS_SES_ACCESS_KEY_ID: "smtp-user",
  AWS_SES_SECRET_ACCESS_KEY: "smtp-secret",
  SES_SNS_TOPIC_ARN: "arn:aws:sns:ap-southeast-2:123456789012:ses",
  EMAIL_FROM: "bookings@example.org",
  SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  SENTRY_ORG: "example",
  SENTRY_PROJECT: "bookings",
  // Xero credentials are captured in-app now (#2079); legacy XERO_* env vars are
  // intentionally absent here so the operational-Xero check does not raise the
  // "remove the legacy vars" warning.
  ADDY_API_KEY: "addy-key",
  ADDY_API_SECRET: "addy-secret",
};

const completeDatabase: SetupDatabaseSnapshot = {
  adminCount: 1,
  adminModuleSettings: {
    kiosk: true,
    chores: true,
    financeDashboard: true,
    waitlist: true,
    xeroIntegration: true,
    bedAllocation: true,
    internetBankingPayments: true,
    addressAutocomplete: true,
    groupBookings: true,
    lockers: true,
    induction: true,
    workParties: true,
    promoCodes: true,
    hutLeaders: true,
    communications: true,
    skifieldConditions: true,
    twoFactor: false,
    magicLink: false,
    googleLogin: false,
    analytics: false,
    lobbyDisplay: false,
    aiAssistant: false,
    memberNotices: true,
    eventsCalendar: true,
    memberGuests: false,
    aiDiagnostics: false,
    maintenanceReports: true,
    alpineCentralServer: false,
  },
  ageTierSettingCount: 4,
  seasonCount: 2,
  cancellationPolicyCount: 3,
  bookingDefaultsConfigured: true,
  groupDiscountConfigured: true,
  membershipCancellationSettingsConfigured: true,
  membershipCancellationXeroGroupCount: 1,
  membershipCancellationArchiveContacts: false,
  operationalXeroConnected: true,
  operationalXeroTokenExpiresAt: "2026-06-01T00:00:00.000Z",
  stripeSecretKeySet: true,
  stripePublishableKeySet: true,
  stripeWebhookSecretSet: true,
  stripeNeedsReentry: false,
  xeroAccountMappingCount: 5,
  xeroHutFeeItemMappingCount: 16,
  xeroEntranceFeeMappingCount: 4,
  // The club's persisted timezone (CT-1, #2989). A configured install has one;
  // its absence is a BLOCK, so a "complete setup" fixture has to carry it.
  clubTimeZone: "Pacific/Auckland",
};

const validClubConfig = {
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://club.example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  beds: [{ id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" }],
  ageTiers: [
    {
      id: "INFANT",
      label: "Infant",
      minAge: 0,
      maxAge: 4,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 0, nonMemberCents: 0 },
        summer: { memberCents: 0, nonMemberCents: 0 },
      },
    },
    {
      id: "CHILD",
      label: "Child",
      minAge: 5,
      maxAge: 9,
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      nightlyRates: {
        winter: { memberCents: 1500, nonMemberCents: 2500 },
        summer: { memberCents: 1000, nonMemberCents: 2000 },
      },
    },
    {
      id: "YOUTH",
      label: "Youth",
      minAge: 10,
      maxAge: 17,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 3000, nonMemberCents: 4500 },
        summer: { memberCents: 2500, nonMemberCents: 3500 },
      },
    },
    {
      id: "ADULT",
      label: "Adult",
      minAge: 18,
      maxAge: null,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      nightlyRates: {
        winter: { memberCents: 4500, nonMemberCents: 6500 },
        summer: { memberCents: 3500, nonMemberCents: 5000 },
      },
    },
  ],
};

const tempDirs: string[] = [];

function makeConfigDir(config: unknown = validClubConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "club.json"), JSON.stringify(config, null, 2));
  return dir;
}

describe("setup-readiness", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a complete setup without exposing secret values", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: completeDatabase,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(readiness.status).toBe("complete");
    expect(readiness.summary.blocked).toBe(0);
    expect(JSON.stringify(readiness)).not.toContain("sk_test_123");
    expect(JSON.stringify(readiness)).not.toContain("smtp-secret");
    expect(JSON.stringify(readiness)).not.toContain("xero-secret");
    expect(JSON.stringify(readiness)).not.toContain("addy-secret");

    const report = renderSetupCheckReport(readiness);
    expect(report).toContain("accounting.reports.profitandloss.read");
    expect(report).toContain("accounting.reports.balancesheet.read");
    expect(report).toContain("accounting.reports.banksummary.read");
    expect(report).not.toContain("accounting.reports.read");
  });

  it("drops the Seasons And Rates step to a warning when a membership type has rate gaps (#1930, E4)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        membershipTypeRateGaps: [
          "Club — Winter 2026 (missing INFANT, CHILD)",
          "School Group — Winter 2026 (missing flat all-ages rate)",
        ],
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const seasonsCheck = bookingCategory?.checks.find(
      (check) => check.id === "seasons-rates",
    );
    expect(seasonsCheck?.status).toBe("warning");
    expect(seasonsCheck?.message).toContain("no hut rates");
    expect(seasonsCheck?.details).toContain(
      "Missing rates: Club — Winter 2026 (missing INFANT, CHILD)",
    );
    expect(seasonsCheck?.details).toContain(
      "Missing rates: School Group — Winter 2026 (missing flat all-ages rate)",
    );
    expect(readiness.status).toBe("warning");
  });

  it("warns when the public hut-fees embed would show fewer than two rate columns (#2129)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        publicHutFeeSingleColumnSeasons: ["River Lodge — Winter 2026"],
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const seasonsCheck = readiness.categories
      .find((category) => category.id === "booking")
      ?.checks.find((check) => check.id === "seasons-rates");
    expect(seasonsCheck?.status).toBe("warning");
    // "Fewer than two", matching the `< 2` gate: zero publicly-listed priced
    // types is the likelier misconfiguration, and must not be described as one.
    expect(seasonsCheck?.message).toContain("fewer than two nightly-rate columns");
    expect(seasonsCheck?.details).toContain(
      "Single-column public rate table: River Lodge — Winter 2026",
    );
    expect(readiness.status).toBe("warning");
  });

  it("raises no hut-fees embed warning when every season has two or more rate columns (#2129)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: { ...completeDatabase, publicHutFeeSingleColumnSeasons: [] },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const seasonsCheck = readiness.categories
      .find((category) => category.id === "booking")
      ?.checks.find((check) => check.id === "seasons-rates");
    expect(seasonsCheck?.status).toBe("complete");
    expect(
      seasonsCheck?.details.some((detail) => detail.includes("Single-column")),
    ).toBe(false);
  });

  it("reports the age-tier step against the DB/seed contract when club.json is absent (#1983)", () => {
    // Age tiers are DB-only at runtime; club.json ageTiers[] is a seed input.
    // With no config file present, the expected count falls back to the seed
    // contract (4 tiers) so a populated DB still reports complete.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-noconfig-"));
    tempDirs.push(emptyDir);

    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: emptyDir,
      database: completeDatabase, // ageTierSettingCount: 4
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const ageCheck = bookingCategory?.checks.find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("complete");
    expect(ageCheck?.details).toContain("Expected age tiers: 4");
    expect(ageCheck?.details).toContain("Database age-tier settings: 4");
  });

  it("treats a valid 2-tier SUBSET club as complete, not a warning (#2009)", () => {
    // A club running only CHILD + ADULT saves 2 rows. The DB is authoritative and
    // the save route guarantees the set is a complete valid tiling, so the age
    // step must report complete with the DB's own count — NOT nag it for having
    // fewer than the 4-tier default, even though club.json still lists 4 tiers.
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(), // validClubConfig has 4 ageTiers
      database: { ...completeDatabase, ageTierSettingCount: 2 },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });

    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const ageCheck = bookingCategory?.checks.find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("complete");
    expect(ageCheck?.details).toContain("Expected age tiers: 2");
    expect(ageCheck?.details).toContain("Database age-tier settings: 2");
  });

  it("warns when a BASED_ON_AGE_TIER type exists but no tier requires a subscription (#2041 misconfig)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        basedOnAgeTierTypesWithoutSubscribingTier: ["Full", "Family"],
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const ageCheck = bookingCategory?.checks.find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("warning");
    expect(ageCheck?.message).toContain("Full, Family");
    expect(ageCheck?.details).toContain(
      "Age-tier subscription types with no subscribing tier: Full, Family",
    );
  });

  it("stays complete when the age-tier configuration is fine (no #2041 misconfig)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        basedOnAgeTierTypesWithoutSubscribingTier: [],
      },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const ageCheck = bookingCategory?.checks.find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("complete");
  });

  it("still warns when the age-tier table is empty (pre-config) (#2009)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: { ...completeDatabase, ageTierSettingCount: 0 },
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    const bookingCategory = readiness.categories.find((c) => c.id === "booking");
    const ageCheck = bookingCategory?.checks.find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("warning");
    // Pre-config falls back to the config/seed contract count as the hint.
    expect(ageCheck?.details).toContain("Expected age tiers: 4");
  });

  it("scopes rate-gap coverage to the club's configured tier subset (#2009)", async () => {
    const { computeMembershipTypeRateGaps } = await import("@/lib/setup-readiness");
    const types = [{ id: "type-full", name: "Full Member", ageGroupsApply: true }];
    const seasons = [{ id: "s-1", name: "Winter 2026" }];
    // A CHILD + ADULT club that has priced BOTH its present tiers has no gap,
    // even though INFANT and YOUTH have no rows (no guest ever classifies into
    // them). Without the subset scoping this would falsely report a gap.
    const rateRows = [
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "CHILD" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "ADULT" },
    ];
    expect(
      computeMembershipTypeRateGaps({
        types,
        seasons,
        rateRows,
        bookableAgeTiers: ["CHILD", "ADULT"],
      }),
    ).toEqual([]);
    // With the default full-four set it WOULD flag the absent tiers, proving the
    // scoping is what suppresses the false positive.
    expect(
      computeMembershipTypeRateGaps({ types, seasons, rateRows }),
    ).toEqual(["Full Member — Winter 2026 (missing INFANT, YOUTH)"]);
  });

  it("computes tier-aware membership-type rate gaps (#1930, E4 review F7)", async () => {
    const { computeMembershipTypeRateGaps } = await import("@/lib/setup-readiness");
    const types = [
      { id: "type-full", name: "Full Member", ageGroupsApply: true },
      { id: "type-club", name: "Club", ageGroupsApply: true },
      { id: "type-flat-covered", name: "Flat Fallback", ageGroupsApply: true },
      { id: "type-school", name: "School Group", ageGroupsApply: false },
      { id: "type-school-bad", name: "School (misconfigured)", ageGroupsApply: false },
    ];
    const seasons = [{ id: "s-1", name: "Winter 2026" }];
    const rateRows = [
      // Full: complete per-tier coverage — no gap.
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "INFANT" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "CHILD" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "YOUTH" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "ADULT" },
      // Club: PARTIAL tier coverage, no flat row — a booking for a missing
      // tier hard-throws, so this is a gap (the pre-fix pair-existence check
      // missed exactly this case).
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "ADULT" },
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "YOUTH" },
      // Flat Fallback: age-keyed type covered entirely by its flat row (the
      // engine falls back exact-tier -> flat) — no gap.
      { seasonId: "s-1", membershipTypeId: "type-flat-covered", ageTier: null },
      // School Group: flat type with its flat row — no gap.
      { seasonId: "s-1", membershipTypeId: "type-school", ageTier: null },
      // School (misconfigured): flat type with ONLY tier rows — shape anomaly,
      // flagged as missing its flat rate.
      { seasonId: "s-1", membershipTypeId: "type-school-bad", ageTier: "ADULT" },
    ];

    const gaps = computeMembershipTypeRateGaps({ types, seasons, rateRows });
    expect(gaps).toEqual([
      "Club — Winter 2026 (missing INFANT, CHILD)",
      "School (misconfigured) — Winter 2026 (missing flat all-ages rate)",
    ]);

    // A type with NO rows at all for a season is a gap listing every tier.
    const emptyGaps = computeMembershipTypeRateGaps({
      types: [{ id: "type-new", name: "New Type", ageGroupsApply: true }],
      seasons,
      rateRows: [],
    });
    expect(emptyGaps).toEqual([
      "New Type — Winter 2026 (missing INFANT, CHILD, YOUTH, ADULT)",
    ]);
  });

  it("surfaces missing first-boot inputs as blocked checks", () => {
    const readiness = buildSetupReadiness({
      env: {},
      configDir: makeConfigDir({ ...validClubConfig, supportEmail: "not-an-email" }),
      database: { ...completeDatabase, adminCount: 0, seasonCount: 0 },
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.summary.blocked).toBeGreaterThan(0);

    const report = renderSetupCheckReport(readiness);
    expect(report).toContain("Runtime Environment: blocked");
    expect(report).toContain("supportEmail");
    expect(report).toContain("Run the seed command");
  });

  it("reports module state from Admin Modules activation only", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          xeroIntegration: false,
          financeDashboard: false,
        },
        operationalXeroConnected: false,
      },
    });

    const report = renderSetupCheckReport(readiness);

    expect(report).toContain("Operational Xero Admin Modules activation: disabled");
    expect(report).toContain("Operational Xero is disabled in Admin Modules.");
    expect(report).toContain("Finance dashboard Admin Modules activation: disabled");
    expect(report).toContain("Finance dashboard is disabled in Admin Modules.");
    expect(report).toContain("Address autocomplete Admin Modules activation: enabled");
    expect(report).not.toContain("env capability");
  });

  it("shows reconnect-required (not connected) when stored Xero tokens no longer decrypt (#2079)", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        // A token row exists but is unreadable after an auth-secret change.
        operationalXeroConnected: false,
        operationalXeroNeedsReentry: true,
      },
    });

    const report = renderSetupCheckReport(readiness);

    expect(report).toContain(
      "reconnect Xero from the in-app setup (Admin > Xero > Setup)",
    );
    expect(report).toContain("Stored Xero tokens no longer decrypt");
    // Must NOT read as connected/complete over dead tokens.
    expect(report).not.toContain("Operational Xero is connected.");
  });

  it("distinguishes address autocomplete disabled, missing credentials, and ready states", () => {
    const disabled = buildSetupReadiness({
      env: {},
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: false,
        },
      },
    });
    const disabledReport = renderSetupCheckReport(disabled);
    expect(disabledReport).toContain(
      "Address Autocomplete: warning - Address autocomplete is disabled in Admin Modules; manual address entry remains available.",
    );
    expect(disabledReport).toContain(
      "ADDY_API_KEY and ADDY_API_SECRET are not required while the module is disabled.",
    );

    const missingCredentials = buildSetupReadiness({
      env: {
        ...baseEnv,
        ADDY_API_KEY: undefined,
        ADDY_API_SECRET: undefined,
      },
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: true,
        },
      },
    });
    const missingReport = renderSetupCheckReport(missingCredentials);
    expect(missingReport).toContain(
      "Address Autocomplete: blocked - Address autocomplete is enabled but Addy credentials are missing.",
    );
    expect(missingReport).toContain("ADDY_API_KEY is missing");
    expect(missingReport).toContain("ADDY_API_SECRET is missing");

    const ready = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        adminModuleSettings: {
          ...completeDatabase.adminModuleSettings!,
          addressAutocomplete: true,
        },
      },
    });
    const readyReport = renderSetupCheckReport(ready);
    expect(readyReport).toContain(
      "Address Autocomplete: complete - Address autocomplete is enabled and Addy credentials are configured.",
    );
    expect(readyReport).not.toContain("addy-secret");
  });

  it("treats acknowledged not-started checks as resolved for overall readiness", () => {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: {
        ...completeDatabase,
        operationalXeroConnected: false,
        operationalXeroTokenExpiresAt: null,
      },
      progress: {
        completedStepIds: [...SETUP_STEP_IDS],
        skippedStepIds: [],
      },
    });

    expect(readiness.status).toBe("complete");
    expect(readiness.summary.complete).toBe(readiness.summary.total);
    expect(readiness.summary.blocked).toBe(0);
    expect(readiness.summary.warning).toBe(0);
    expect(readiness.summary.skipped).toBe(0);
  });

  it("normalizes progress to known setup step ids", () => {
    expect(
      normalizeSetupProgress({
        completedStepIds: ["club-config", "unknown"],
        skippedStepIds: ["sentry", "unknown"],
        completedAt: "2026-05-18T00:00:00.000Z",
        completedByMemberId: "member_1",
      }),
    ).toEqual({
      completedStepIds: ["club-config"],
      skippedStepIds: ["sentry"],
      completedAt: "2026-05-18T00:00:00.000Z",
      completedByMemberId: "member_1",
    });
  });
});

describe("setup-readiness club-config reconcile (D3, epic #1943)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-d3-"));
    dirs.push(dir);
    return dir;
  }

  function clubConfigCheck(configDir: string) {
    const readiness = buildSetupReadiness({ configDir });
    for (const category of readiness.categories) {
      const check = category.checks.find((c) => c.id === "club-config");
      if (check) return check;
    }
    throw new Error("club-config check not found");
  }

  it("reports blocked for a malformed primary and does NOT fall through to a valid example", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "club.json"), "{ not json");
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify({ ...validClubConfig, name: "Example Fallback" }, null, 2),
    );

    const check = clubConfigCheck(dir);
    expect(check.status).toBe("blocked");
    // Must not be silently satisfied by the example's identity.
    expect(check.message).not.toContain("Example Fallback");
  });

  it("reports blocked for a schema-invalid primary even when a valid example exists", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "club.json"),
      JSON.stringify({ ...validClubConfig, supportEmail: "garbage" }, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify(validClubConfig, null, 2),
    );

    expect(clubConfigCheck(dir).status).toBe("blocked");
  });

  it("reports a warning (not complete) for an absent primary with only an example and no DB check (#1987)", () => {
    // C8: config/club.json is an optional seed and club.example.json is a
    // placeholder — neither counts as "configured" on its own. Without a
    // primary and without a DB snapshot the gate warns; the DB is authoritative.
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify({ ...validClubConfig, name: "Adopter Club" }, null, 2),
    );

    const check = clubConfigCheck(dir);
    expect(check.status).toBe("warning");
    expect(check.message).not.toContain("Adopter Club");
  });

  it("reports a warning (not blocked) when neither file exists and the DB was not checked (#1987)", () => {
    // C8: config/club.json is only an optional seed now. With no primary on
    // disk and no DB snapshot, the gate cannot confirm configuration, so it
    // warns rather than hard-blocking.
    const check = clubConfigCheck(makeDir());
    expect(check.status).toBe("warning");
    expect(check.message).toContain("database was not checked");
  });

  it("does NOT treat a valid club.example.json alone as configured when the DB is checked (#1987)", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, "club.example.json"),
      JSON.stringify({ ...validClubConfig, name: "Placeholder Club" }, null, 2),
    );
    // DB snapshot present but no persisted identity -> not configured -> blocked.
    const readiness = buildSetupReadiness({
      configDir: dir,
      database: { ...completeDatabase, clubIdentityName: null },
    });
    const check = readiness.categories
      .flatMap((c) => c.checks)
      .find((c) => c.id === "club-config");
    expect(check?.status).toBe("blocked");
    expect(check?.message).not.toContain("Placeholder Club");
  });
});

describe("setup-readiness club-config DB-first gate (#1987, C8)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function emptyDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-c8-"));
    dirs.push(dir);
    return dir;
  }

  function clubConfigCheck(readiness: ReturnType<typeof buildSetupReadiness>) {
    const check = readiness.categories
      .flatMap((c) => c.checks)
      .find((c) => c.id === "club-config");
    if (!check) throw new Error("club-config check not found");
    return check;
  }

  it("reports not-configured (blocked) for a fresh DB with no club.json, then complete once identity is filled", () => {
    const dir = emptyDir();

    const before = buildSetupReadiness({
      configDir: dir,
      database: { ...completeDatabase, clubIdentityName: null, configuredCapacity: null },
    });
    const beforeCheck = clubConfigCheck(before);
    expect(beforeCheck.status).toBe("blocked");
    expect(beforeCheck.message).toContain("not configured yet");

    const after = buildSetupReadiness({
      configDir: dir,
      database: {
        ...completeDatabase,
        clubIdentityName: "Rimutaka Alpine Club",
        configuredCapacity: 24,
      },
    });
    const afterCheck = clubConfigCheck(after);
    expect(afterCheck.status).toBe("complete");
    expect(afterCheck.message).toContain("Rimutaka Alpine Club");
    expect(afterCheck.message).toContain("24 total beds");
    // No file was involved.
    expect(afterCheck.details).toContain(
      "Source: database (ClubIdentitySettings / EmailMessageSetting)",
    );
  });

  it("still blocks loudly on a malformed primary club.json even when the DB is configured", () => {
    const dir = emptyDir();
    fs.writeFileSync(path.join(dir, "club.json"), "{ not json");

    const readiness = buildSetupReadiness({
      configDir: dir,
      database: { ...completeDatabase, clubIdentityName: "Configured Club" },
    });
    const check = clubConfigCheck(readiness);
    expect(check.status).toBe("blocked");
    expect(check.message).toContain("invalid");
  });

  it("marks the age-tiers step complete from the fixed four DB slots without a club.json", () => {
    const dir = emptyDir();
    const readiness = buildSetupReadiness({
      configDir: dir,
      database: {
        ...completeDatabase,
        clubIdentityName: "Configured Club",
        ageTierSettingCount: 4,
      },
    });
    const ageCheck = readiness.categories
      .flatMap((c) => c.checks)
      .find((c) => c.id === "age-tiers");
    expect(ageCheck?.status).toBe("complete");
  });
});

/**
 * The club-timezone readiness step (CT-1, #2989).
 *
 * Setup is not finished until the club's timezone is stored explicitly, so the
 * not-yet-stored state is a BLOCK — but a friendly one: it has to name the zone
 * actually in force and say that the app stores it on the next boot, or an
 * operator reads a normal post-migration state as a broken site.
 *
 * The one exception is an environment that names no place (`TZ=UTC`): the owner
 * decided on 23 Aug 2026 (#2989) that such a deployment is DEFAULTED to
 * `Pacific/Auckland` rather than blocked — and warned about, both before the
 * first boot records it and after, because the row carries no provenance and the
 * boot backfill always runs before anybody can open `/admin/setup`.
 *
 * Every case below pins `process.env.TZ` rather than inheriting the host's or the
 * CI runner's zone, and restores it by ASSIGNING the captured value back (#2485).
 * Nothing here formats a date, so the frozen clock is not involved.
 */
describe("setup-readiness club timezone (CT-1, #2989)", () => {
  const hostTimeZone = captureHostTimeZone();
  const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

  afterEach(() => {
    hostTimeZone.restore();
    if (originalNextPublicTz === undefined) {
      delete process.env.NEXT_PUBLIC_TZ;
    } else {
      process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function pinEnvironmentZone(zone: string | null) {
    if (zone === null) {
      // Assign before deleting: only an assignment invalidates Node's cached
      // zone. `hostTimeZone.restore()` puts the original back the same way.
      process.env.TZ = "Pacific/Auckland";
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
    delete process.env.NEXT_PUBLIC_TZ;
  }

  function clubTimeZoneCheck(database?: SetupDatabaseSnapshot) {
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    const check = readiness.categories
      .flatMap((category) => category.checks)
      .find((candidate) => candidate.id === "club-time-zone");
    if (!check) throw new Error("club-time-zone check is missing");
    return check;
  }

  it("is a required foundation step pointing at the club time page", () => {
    pinEnvironmentZone("Pacific/Auckland");
    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: completeDatabase,
    });
    const foundation = readiness.categories.find(
      (category) => category.id === "foundation",
    );

    const check = foundation?.checks.find(
      (candidate) => candidate.id === "club-time-zone",
    );
    expect(check).toBeDefined();
    expect(check?.required).toBe(true);
    expect(check?.href).toBe("/admin/club-time");
    expect(SETUP_STEP_IDS).toContain("club-time-zone");
  });

  it("is complete and NAMES the stored zone", () => {
    pinEnvironmentZone("America/Denver");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: "Australia/Sydney",
    });

    expect(check.status).toBe("complete");
    // Naming it is the point: an upgraded club has to be able to see at a glance
    // that it was not moved.
    expect(check.message).toContain("Australia/Sydney");
    expect(check.details.join(" ")).toContain("Australia/Sydney");
  });

  it("reports the canonical spelling of a stored alias", () => {
    pinEnvironmentZone("Pacific/Auckland");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: "australia/sydney",
    });

    expect(check.status).toBe("complete");
    expect(check.message).toContain("Australia/Sydney");
    expect(check.details.join(" ")).toContain("australia/sydney");
  });

  it("blocks when nothing is stored, naming the zone in force and how it gets stored", () => {
    // The state a fresh install, and an existing install between
    // `prisma migrate deploy` and its first boot, is in.
    pinEnvironmentZone("Australia/Sydney");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: null,
    });

    expect(check.status).toBe("blocked");
    const text = `${check.message} ${check.details.join(" ")}`;
    expect(text).toContain("Australia/Sydney");
    expect(text).toMatch(/has not been stored yet/i);
    expect(text).toMatch(/next time it starts|next boot/i);
    expect(text).toContain("npm run config:self-heal");
  });

  it("blocks when the snapshot simply omits the field (an older caller)", () => {
    pinEnvironmentZone("Australia/Sydney");
    const withoutTimeZone: SetupDatabaseSnapshot = { ...completeDatabase };
    delete withoutTimeZone.clubTimeZone;

    const check = clubTimeZoneCheck(withoutTimeZone);

    expect(check.status).toBe("blocked");
  });

  it("names the built-in default as the zone to be stored when the environment says nothing", () => {
    pinEnvironmentZone(null);

    const check = clubTimeZoneCheck({ ...completeDatabase, clubTimeZone: null });

    expect(check.status).toBe("blocked");
    const text = `${check.message} ${check.details.join(" ")}`;
    expect(text).toContain("Pacific/Auckland");
    expect(text).toMatch(/No TZ or NEXT_PUBLIC_TZ is set/i);
  });

  it.each([
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
  ])(
    "names the place TZ=%s actually means (%s) as the zone about to be stored",
    (raw, expected) => {
      // The readiness message has to agree with what the next boot will really
      // record. Before the #2989 review both this step and the backfill ran the
      // operator-input validator over the environment, so this said
      // "Pacific/Auckland" to a London club and then the backfill wrote it.
      pinEnvironmentZone(raw);

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: null,
      });

      expect(check.status).toBe("blocked");
      const text = `${check.message} ${check.details.join(" ")}`;
      expect(text).toContain(expected);
      expect(text).not.toContain("Pacific/Auckland");
      // And it shows the raw value too, so the interpretation is visible.
      expect(text).toContain(raw);
    },
  );

  it.each(["UTC", "Etc/GMT-12", "SystemV/EST5"])(
    "warns rather than blocking when TZ=%s names no place, and says what will be stored instead",
    (raw) => {
      // Owner decision, 23 Aug 2026 (#2989). This state used to be blocked with
      // nothing recorded. It is now a WARNING — the owner said not to block
      // setup — and it must still be honest about the two things that make it a
      // warning rather than a clean step: the environment value could not be
      // used, and the zone about to be recorded is a DEFAULT rather than the one
      // this deployment was running on.
      pinEnvironmentZone(raw);

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: null,
      });

      expect(check.status).toBe("warning");
      const text = `${check.message} ${check.details.join(" ")}`;
      expect(text).toContain(raw);
      expect(text).toContain("Pacific/Auckland");
      expect(text).toMatch(/not a place|name no place/i);
      expect(text).toMatch(/default/i);
      expect(text).toContain("/admin/club-time");
    },
  );

  it.each(["UTC", "Etc/GMT-12"])(
    "keeps warning AFTER the boot has recorded the default, for TZ=%s",
    (raw) => {
      // The state an operator actually meets. The boot backfill runs from
      // `instrumentation.node.ts` before anybody can open /admin/setup, so by
      // the time this page renders the row exists — and without this branch a
      // club that has been on UTC for years reads a clean "complete" naming a
      // zone nobody chose, which is exactly what the owner's decision says must
      // not happen.
      pinEnvironmentZone(raw);

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: "Pacific/Auckland",
      });

      expect(check.status).toBe("warning");
      const text = `${check.message} ${check.details.join(" ")}`;
      expect(text).toContain(raw);
      expect(text).toContain("Pacific/Auckland");
      // It does not claim to know whether the zone was chosen or defaulted — the
      // row records no provenance — so it asks, and names both ways out.
      expect(text).toMatch(/acknowledge/i);
      expect(text).toContain("/admin/club-time");
    },
  );

  it("PREMISE: the same stored default is COMPLETE once the environment names a place", () => {
    // Without this leg the two assertions above cannot tell a real condition
    // from a step that warns whenever Pacific/Auckland is stored.
    pinEnvironmentZone("Europe/London");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: "Pacific/Auckland",
    });

    expect(check.status).toBe("complete");
  });

  it("does not warn about a stored zone that is not the default, whatever TZ says", () => {
    // The other half of the condition: the post-boot warning is about the value
    // the backfill would have invented, so a club on any other zone has plainly
    // configured itself and must not be nagged.
    pinEnvironmentZone("UTC");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: "Australia/Sydney",
    });

    expect(check.status).toBe("complete");
    expect(check.message).toContain("Australia/Sydney");
  });

  it("reports 'not checked' rather than a remedy when the timezone row could not be READ", () => {
    // An un-migrated database: every other setting answered and this one query
    // failed. "The app stores it on the next start" is the remedy for an absent
    // row and is no remedy at all for an absent table, so this state gets its
    // own message.
    pinEnvironmentZone("Australia/Sydney");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: null,
      clubTimeZoneUnreadable: true,
    });

    expect(check.status).toBe("warning");
    const text = `${check.message} ${check.details.join(" ")}`;
    expect(text).toMatch(/could not be read/i);
    expect(text).toMatch(/migrate/i);
    expect(text).not.toMatch(/next time it starts/i);
    // It does not answer the question from the environment either.
    expect(text).not.toContain("Australia/Sydney");
  });

  it("blocks on a stored value that does not validate, and says what the app is using meanwhile", () => {
    // Only database surgery or an ICU that dropped the zone gets you here. The
    // app keeps answering from the fallback, so the details must not imply the
    // stored value is in force.
    pinEnvironmentZone("Europe/London");

    const check = clubTimeZoneCheck({
      ...completeDatabase,
      clubTimeZone: "NZT",
    });

    expect(check.status).toBe("blocked");
    const text = `${check.message} ${check.details.join(" ")}`;
    expect(text).toContain("NZT");
    expect(text).toContain("Europe/London");
  });

  it.each([
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["EST5EDT", "America/New_York"],
  ])(
    "does not contradict itself about the fallback when TZ=%s is a legacy alias",
    (raw, expected) => {
      // #2989 fix round, finding F1b. The step names the zone the reader is
      // falling back to — which comes from `resolveClubTimeZone`, whose
      // environment leg uses the PRESERVATION rule — and then explained where it
      // came from using the OPERATOR-INPUT validator. For all thirty-six legacy
      // aliases the two disagree, so the details said, in consecutive sentences,
      // "falling back to Europe/London" and then "the TZ value ("GB") is not a
      // named place either, so the built-in New Zealand default applies".
      pinEnvironmentZone(raw);

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: "NZT",
      });
      const text = `${check.message} ${check.details.join(" ")}`;

      expect(check.status).toBe("blocked");
      expect(text).toContain(expected);
      // The contradiction, in the exact words it used to appear in.
      expect(text).not.toMatch(/is not a named place either/i);
      expect(text).not.toMatch(
        /built-in New Zealand default applies until the club's timezone is set again/i,
      );
      // And the raw spelling is still shown, so the interpretation is visible.
      expect(text).toContain(raw);
    },
  );

  it("PREMISE: it DOES say the environment is no help when TZ really names no place", () => {
    // The leg that makes the assertions above mean something: with an
    // environment value that neither rule can use, the sentence they refuse to
    // see is the correct one and must still be printed.
    pinEnvironmentZone("Etc/GMT-12");

    const check = clubTimeZoneCheck({ ...completeDatabase, clubTimeZone: "NZT" });
    const text = `${check.message} ${check.details.join(" ")}`;

    expect(check.status).toBe("blocked");
    expect(text).toMatch(/is not a named place either/i);
    expect(text).toContain("Pacific/Auckland");
  });

  it("blocks on a stored fixed offset", () => {
    pinEnvironmentZone("Pacific/Auckland");

    expect(
      clubTimeZoneCheck({ ...completeDatabase, clubTimeZone: "Etc/GMT-12" })
        .status,
    ).toBe("blocked");
    expect(
      clubTimeZoneCheck({ ...completeDatabase, clubTimeZone: "" }).status,
    ).toBe("blocked");
  });

  it("renders an unusable stored value bounded and printable", () => {
    // The report is printed into an operator's terminal by `setup:check`, and a
    // value that failed validation never came through the validated write path,
    // so nothing bounds its bytes. Naming what is stored is what makes the
    // failure fixable, so it is sanitised rather than withheld.
    pinEnvironmentZone("Pacific/Auckland");
    const hostile = `Pacific/\u0007${"x".repeat(300)}`;

    const readiness = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database: { ...completeDatabase, clubTimeZone: hostile },
    });
    const check = readiness.categories
      .flatMap((category) => category.checks)
      .find((candidate) => candidate.id === "club-time-zone");
    const rendered = renderSetupCheckReport(readiness);

    expect(check?.status).toBe("blocked");
    // The control character never reaches the terminal, and the value is capped
    // so one stored string cannot flood the report.
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("x".repeat(100));
    expect(rendered).toContain("Pacific/?xxx");
  });

  it("reports 'not checked' rather than an answer when the database was not reached", () => {
    // `setup:check` before the database is up. The environment cannot answer
    // this question, because the environment is exactly what this setting stops
    // being authoritative.
    pinEnvironmentZone("Australia/Sydney");

    const check = clubTimeZoneCheck(undefined);

    expect(check.status).toBe("warning");
    expect(check.message).toBe("Database state was not checked.");
    expect(check.details.join(" ")).not.toContain("Australia/Sydney");
  });

  it("says in plain English that this is not the server's timezone, in every state", () => {
    // The single most common operator misunderstanding, so it is stated on the
    // step whatever state the step is in.
    pinEnvironmentZone("Australia/Sydney");

    for (const database of [
      undefined,
      { ...completeDatabase, clubTimeZone: null },
      { ...completeDatabase, clubTimeZone: "NZT" },
      { ...completeDatabase, clubTimeZone: "Australia/Sydney" },
      { ...completeDatabase, clubTimeZone: null, clubTimeZoneUnreadable: true },
    ]) {
      const details = clubTimeZoneCheck(database).details.join(" ");
      expect(details).toMatch(/not the server/i);
      expect(details).toMatch(/database/i);
    }
    // Including the two states that depend on the environment rather than on the
    // snapshot: an unusable TZ, and an alias that names a real place.
    for (const raw of ["UTC", "GB"]) {
      pinEnvironmentZone(raw);
      const details = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: null,
      }).details.join(" ");
      expect(details).toMatch(/not the server/i);
      expect(details).toMatch(/database/i);
    }
  });

  it.each([
    "GB",
    "NZ-CHAT",
    "EST5EDT",
    "Australia/Sydney",
    "australia/sydney",
    "UTC",
    "Etc/GMT-12",
    null,
  ])(
    "promises exactly what the next boot will record, for TZ=%s",
    (raw) => {
      // The checklist and the backfill are two descriptions of one fact. They
      // read the environment through the same classification but they are
      // different code, and this is the assertion that stops them drifting: the
      // zone the step NAMES has to be the zone `decideClubTimeZoneBackfill`
      // would write. Before the #2989 review both were wrong in the same way,
      // which is exactly why agreement alone is not enough — the two
      // it.each blocks above pin what the right answer IS.
      pinEnvironmentZone(raw);
      const decision = decideClubTimeZoneBackfill();

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: null,
      });

      expect(check.message).toContain(decision.timeZone);
      expect(check.details.join(" ")).toContain(decision.timeZone);
    },
  );

  it.each(["UTC", "Etc/GMT-12"])(
    "agrees with the backfill that TZ=%s is a DEFAULT and not a preserved zone",
    (raw) => {
      // The other half of the agreement. Both sides now record
      // `Pacific/Auckland` for this input, so "they name the same zone" is no
      // longer discriminating on its own — what has to agree is that neither
      // presents it as the zone the deployment was using.
      pinEnvironmentZone(raw);
      expect(decideClubTimeZoneBackfill().kind).toBe("defaulted");

      const check = clubTimeZoneCheck({
        ...completeDatabase,
        clubTimeZone: null,
      });
      const text = `${check.message} ${check.details.join(" ")}`;

      expect(check.status).toBe("warning");
      expect(text).toMatch(/default/i);
      // And it never claims the value came out of the environment, which is the
      // sentence state 5 uses and the one thing that is not true here.
      expect(text).not.toMatch(/keeping exactly the timezone this deployment/i);
      expect(text).not.toContain("Australia/Sydney");
    },
  );

  it("does not depend on the wall clock", () => {
    // Two different `now` values, one identical answer.
    pinEnvironmentZone("Australia/Sydney");
    const database = { ...completeDatabase, clubTimeZone: null };

    const early = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database,
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    const late = buildSetupReadiness({
      env: baseEnv,
      configDir: makeConfigDir(),
      database,
      now: new Date("2031-12-31T23:59:59.000Z"),
    });
    const pick = (readiness: typeof early) =>
      readiness.categories
        .flatMap((category) => category.checks)
        .find((candidate) => candidate.id === "club-time-zone");

    expect(pick(early)).toEqual(pick(late));
  });
});
