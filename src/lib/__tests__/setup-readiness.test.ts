import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  renderSetupCheckReport,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

const baseEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  NEXTAUTH_URL: "https://club.example.org",
  AUTH_SECRET: "auth-secret",
  CRON_SECRET: "cron-secret",
  SEED_ADMIN_EMAIL: "admin@example.org",
  SEED_ADMIN_PASSWORD: "change-me",
  FEATURE_KIOSK: "true",
  FEATURE_CHORES: "true",
  FEATURE_FINANCE_DASHBOARD: "true",
  FEATURE_WAITLIST: "true",
  FEATURE_XERO_INTEGRATION: "true",
  FEATURE_BED_ALLOCATION: "true",
  FEATURE_INTERNET_BANKING_PAYMENTS: "true",
  STRIPE_SECRET_KEY: "sk_test_123",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
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
  XERO_CLIENT_ID: "xero-client",
  XERO_CLIENT_SECRET: "xero-secret",
  XERO_REDIRECT_URI: "https://club.example.org/api/admin/xero/callback",
  XERO_ENCRYPTION_KEY: "a".repeat(64),
  XERO_WEBHOOK_KEY: "webhook-key",
  FINANCE_XERO_CLIENT_ID: "finance-client",
  FINANCE_XERO_CLIENT_SECRET: "finance-secret",
  FINANCE_XERO_REDIRECT_URI: "https://club.example.org/api/finance/xero/callback",
  FINANCE_XERO_ENCRYPTION_KEY: "b".repeat(64),
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
  financeXeroConnected: true,
  financeXeroTokenExpiresAt: "2026-06-01T00:00:00.000Z",
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

  it("distinguishes env capability from Admin Modules activation", () => {
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
        financeXeroConnected: false,
      },
    });

    const report = renderSetupCheckReport(readiness);

    expect(report).toContain(
      "Operational Xero env capability (FEATURE_XERO_INTEGRATION): enabled"
    );
    expect(report).toContain("Operational Xero Admin Modules activation: disabled");
    expect(report).toContain("Operational Xero is inactive by env capability or Admin Modules activation.");
    expect(report).toContain(
      "Finance dashboard env capability (FEATURE_FINANCE_DASHBOARD): enabled"
    );
    expect(report).toContain("Finance dashboard Admin Modules activation: disabled");
    expect(report).toContain("Finance dashboard is inactive by env capability or Admin Modules activation.");
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
