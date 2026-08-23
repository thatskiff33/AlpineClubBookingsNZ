import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    commsPortal: false,
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
