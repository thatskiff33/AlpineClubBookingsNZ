import fs from "node:fs";
import path from "node:path";
import { clubConfigSchema, type ClubConfig } from "../config/schema";
import {
  DEFAULT_ADMIN_MODULE_SETTINGS,
  getEffectiveModuleState,
  normalizeAdminModuleSettings,
  type AdminModuleKey,
  type AdminModuleSettingsSnapshot,
} from "./admin-modules";

export const SETUP_STEP_IDS = [
  "club-config",
  "runtime-env",
  "seed-admin",
  "feature-flags",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "stripe",
  "email-ses",
  "sentry",
  "xero-operational",
  "xero-finance",
  "xero-mappings",
] as const;

export type SetupStepId = typeof SETUP_STEP_IDS[number];
export type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
export type SetupCategoryId =
  | "foundation"
  | "booking"
  | "integrations"
  | "finance";

export interface SetupProgressState {
  completedStepIds: SetupStepId[];
  skippedStepIds: SetupStepId[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

interface SetupProgressInput {
  completedStepIds?: readonly string[];
  skippedStepIds?: readonly string[];
  completedAt?: string | null;
  completedByMemberId?: string | null;
}

export interface SetupDatabaseSnapshot {
  adminCount: number;
  adminModuleSettings?: AdminModuleSettingsSnapshot | null;
  ageTierSettingCount: number;
  seasonCount: number;
  cancellationPolicyCount: number;
  bookingDefaultsConfigured: boolean;
  groupDiscountConfigured: boolean;
  membershipCancellationSettingsConfigured: boolean;
  membershipCancellationXeroGroupCount: number;
  membershipCancellationArchiveContacts: boolean;
  operationalXeroConnected: boolean;
  operationalXeroTokenExpiresAt: string | null;
  financeXeroConnected: boolean;
  financeXeroTokenExpiresAt: string | null;
  xeroAccountMappingCount: number;
  xeroHutFeeItemMappingCount: number;
  xeroEntranceFeeMappingCount: number;
}

export interface SetupStepCheck {
  id: SetupStepId;
  title: string;
  description: string;
  status: SetupStatus;
  required: boolean;
  message: string;
  details: string[];
  href?: string;
  action?: {
    type: "provider-test";
    provider: "stripe" | "smtp" | "sentry" | "xero" | "finance-xero";
    label: string;
  };
  progress: "open" | "completed" | "skipped";
}

export interface SetupCategory {
  id: SetupCategoryId;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

export interface SetupReadiness {
  status: SetupStatus;
  summary: {
    total: number;
    complete: number;
    warning: number;
    blocked: number;
    skipped: number;
  };
  categories: SetupCategory[];
  generatedAt: string;
}

type Env = Record<string, string | undefined>;

interface ClubConfigReadResult {
  sourcePath: string;
  exists: boolean;
  config: ClubConfig | null;
  issues: string[];
}

const CATEGORY_ORDER: SetupCategoryId[] = [
  "foundation",
  "booking",
  "integrations",
  "finance",
];

const CATEGORY_META: Record<
  SetupCategoryId,
  { title: string; description: string }
> = {
  foundation: {
    title: "Foundation",
    description: "Club identity, runtime env, administrator account, and feature switches.",
  },
  booking: {
    title: "Booking Rules",
    description: "Capacity, age tiers, rates, seasons, cancellation, and hold settings.",
  },
  integrations: {
    title: "Operational Integrations",
    description: "Stripe, email, Sentry, and operational Xero setup state.",
  },
  finance: {
    title: "Finance",
    description: "Finance Xero connection and Xero chart/item mappings.",
  },
};

const MODULE_CONTROLS = [
  {
    key: "kiosk",
    label: "Lodge kiosk",
    envVar: "FEATURE_KIOSK",
  },
  {
    key: "chores",
    label: "Chores and roster",
    envVar: "FEATURE_CHORES",
  },
  {
    key: "financeDashboard",
    label: "Finance dashboard",
    envVar: "FEATURE_FINANCE_DASHBOARD",
  },
  {
    key: "waitlist",
    label: "Waitlist",
    envVar: "FEATURE_WAITLIST",
  },
  {
    key: "xeroIntegration",
    label: "Operational Xero",
    envVar: "FEATURE_XERO_INTEGRATION",
  },
  {
    key: "bedAllocation",
    label: "Bed allocation",
    envVar: "FEATURE_BED_ALLOCATION",
  },
  {
    key: "internetBankingPayments",
    label: "Internet Banking payments",
    envVar: "FEATURE_INTERNET_BANKING_PAYMENTS",
  },
] as const satisfies readonly {
  key: AdminModuleKey;
  label: string;
  envVar: string;
}[];

const FEATURE_FLAGS = MODULE_CONTROLS.map((module) => module.envVar);

const REQUIRED_RUNTIME_ENV = [
  "DATABASE_URL",
  "NEXTAUTH_URL",
  "CRON_SECRET",
  "SEED_ADMIN_EMAIL",
  "SEED_ADMIN_PASSWORD",
] as const;

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function hasEnv(env: Env, name: string): boolean {
  return Boolean(readEnv(env, name));
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLikelyStripeSecret(value: string | undefined): boolean {
  return Boolean(
    value &&
      (value.startsWith("sk_test_") ||
        value.startsWith("sk_live_") ||
        value.startsWith("rk_")),
  );
}

function isLikelyStripePublishable(value: string | undefined): boolean {
  return Boolean(value && (value.startsWith("pk_test_") || value.startsWith("pk_live_")));
}

function isHexEncryptionKey(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-fA-F]{64}$/.test(value));
}

function isEnabledFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function toStatusScore(status: SetupStatus): number {
  switch (status) {
    case "blocked":
      return 4;
    case "warning":
      return 3;
    case "not_started":
      return 2;
    case "complete":
      return 1;
  }
}

function worstStatus(statuses: SetupStatus[]): SetupStatus {
  return statuses.reduce<SetupStatus>((worst, status) =>
    toStatusScore(status) > toStatusScore(worst) ? status : worst
  , "complete");
}

function normalizeStepIds(ids: readonly string[] | undefined): SetupStepId[] {
  const valid = new Set<string>(SETUP_STEP_IDS);
  return Array.from(new Set(ids ?? [])).filter((id): id is SetupStepId =>
    valid.has(id),
  );
}

export function normalizeSetupProgress(
  progress?: SetupProgressInput | null,
): SetupProgressState {
  return {
    completedStepIds: normalizeStepIds(progress?.completedStepIds),
    skippedStepIds: normalizeStepIds(progress?.skippedStepIds),
    completedAt: progress?.completedAt ?? null,
    completedByMemberId: progress?.completedByMemberId ?? null,
  };
}

function readClubConfig(configDir: string): ClubConfigReadResult {
  const primaryPath = path.join(configDir, "club.json");
  const examplePath = path.join(configDir, "club.example.json");
  const sourcePath = fs.existsSync(primaryPath) ? primaryPath : examplePath;

  if (!fs.existsSync(sourcePath)) {
    return {
      sourcePath,
      exists: false,
      config: null,
      issues: [`No club config found at ${primaryPath} or ${examplePath}`],
    };
  }

  try {
    const parsedJson = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const result = clubConfigSchema.safeParse(parsedJson);
    if (!result.success) {
      return {
        sourcePath,
        exists: true,
        config: null,
        issues: result.error.issues.map((issue) => {
          const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "root";
          return `${fieldPath}: ${issue.message}`;
        }),
      };
    }

    return {
      sourcePath,
      exists: true,
      config: result.data,
      issues: [],
    };
  } catch (error) {
    return {
      sourcePath,
      exists: true,
      config: null,
      issues: [
        error instanceof Error
          ? `Invalid JSON in ${sourcePath}: ${error.message}`
          : `Invalid JSON in ${sourcePath}`,
      ],
    };
  }
}

function buildProgressState(
  id: SetupStepId,
  progress: SetupProgressState,
): "open" | "completed" | "skipped" {
  if (progress.completedStepIds.includes(id)) return "completed";
  if (progress.skippedStepIds.includes(id)) return "skipped";
  return "open";
}

function applyProgress(
  check: Omit<SetupStepCheck, "progress">,
  progress: SetupProgressState,
): SetupStepCheck {
  return {
    ...check,
    progress: buildProgressState(check.id, progress),
  };
}

function buildClubConfigCheck(
  club: ClubConfigReadResult,
  progress: SetupProgressState,
): SetupStepCheck {
  const capacity =
    club.config?.beds.reduce((total, bed) => total + bed.capacity, 0) ?? 0;
  const details = club.config
    ? [
        `Source: ${club.sourcePath}`,
        `Club: ${club.config.name}`,
        `Configured capacity: ${capacity} beds`,
      ]
    : [`Source: ${club.sourcePath}`, ...club.issues];

  return applyProgress(
    {
      id: "club-config",
      title: "Club Config",
      description: "Club identity, contact details, bed capacity, age tiers, and default rates.",
      status: club.config ? "complete" : "blocked",
      required: true,
      message: club.config
        ? `${club.config.name} is configured with ${capacity} total beds.`
        : "A valid config/club.json or config/club.example.json is required.",
      details,
      href: "/admin/setup",
    },
    progress,
  );
}

function buildRuntimeEnvCheck(env: Env, progress: SetupProgressState): SetupStepCheck {
  const missing: string[] = REQUIRED_RUNTIME_ENV.filter((name) => !hasEnv(env, name));
  if (!hasEnv(env, "AUTH_SECRET") && !hasEnv(env, "NEXTAUTH_SECRET")) {
    missing.push("AUTH_SECRET or NEXTAUTH_SECRET");
  }
  const issues = [...missing];
  if (hasEnv(env, "NEXTAUTH_URL") && !isHttpUrl(readEnv(env, "NEXTAUTH_URL"))) {
    issues.push("NEXTAUTH_URL must be a valid http(s) URL");
  }
  const authTrustHost = readEnv(env, "AUTH_TRUST_HOST");
  if (authTrustHost && authTrustHost !== "true" && authTrustHost !== "false") {
    issues.push("AUTH_TRUST_HOST must be true or false");
  }

  return applyProgress(
    {
      id: "runtime-env",
      title: "Runtime Environment",
      description: "Database, auth, app origin, cron, and seed-admin environment contract.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? "Required runtime variables are present and well formed."
          : "Required runtime variables are missing or invalid.",
      details:
        issues.length === 0
          ? REQUIRED_RUNTIME_ENV.map((name) => `${name}: set`).concat([
              hasEnv(env, "AUTH_SECRET")
                ? "AUTH_SECRET: set"
                : "NEXTAUTH_SECRET: set",
            ])
          : issues.map((issue) => `Fix ${issue}`),
    },
    progress,
  );
}

function buildSeedAdminCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "seed-admin",
        title: "First Admin",
        description: "Seeded administrator account used to access setup and admin tools.",
        status: "warning",
        required: true,
        message: "Database state was not checked.",
        details: ["Run setup:check again inside an environment with database access, or review /admin/setup after login."],
        href: "/admin/members",
      },
      progress,
    );
  }

  const adminCount = db?.adminCount ?? 0;
  return applyProgress(
    {
      id: "seed-admin",
      title: "First Admin",
      description: "Seeded administrator account used to access setup and admin tools.",
      status: adminCount > 0 ? "complete" : "blocked",
      required: true,
      message:
        adminCount > 0
          ? `${adminCount} administrator account${adminCount === 1 ? "" : "s"} found.`
          : "Run the seed command after setting SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.",
      details:
        adminCount > 0
          ? ["Admin login is available."]
          : ["Command: npm run db:seed"],
      href: "/admin/members",
    },
    progress,
  );
}

function buildModuleLayerState(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  moduleKey: AdminModuleKey,
) {
  const control = MODULE_CONTROLS.find((item) => item.key === moduleKey);
  if (!control) {
    throw new Error(`Unknown module key: ${moduleKey}`);
  }

  const adminActivation =
    db?.adminModuleSettings === undefined
      ? DEFAULT_ADMIN_MODULE_SETTINGS
      : normalizeAdminModuleSettings(db.adminModuleSettings);
  const envCapability = MODULE_CONTROLS.reduce(
    (flags, item) => ({
      ...flags,
      [item.key]: isEnabledFlag(readEnv(env, item.envVar)),
    }),
    {} as Record<AdminModuleKey, boolean>,
  );
  const effective = getEffectiveModuleState(envCapability, adminActivation);

  return {
    envVar: control.envVar,
    envEnabled: envCapability[moduleKey],
    adminChecked: Boolean(db && db.adminModuleSettings),
    adminEnabled: adminActivation[moduleKey],
    effectiveEnabled: effective[moduleKey],
  };
}

function formatModuleActivationDetail(
  db: SetupDatabaseSnapshot | undefined,
  enabled: boolean,
) {
  if (!db) return "Admin Modules activation: not checked";
  if (!db.adminModuleSettings) {
    return "Admin Modules activation: default active until settings are saved";
  }
  return `Admin Modules activation: ${enabled ? "enabled" : "disabled"}`;
}

function buildFeatureFlagCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const envDetails = MODULE_CONTROLS.map((module) => {
    const layer = buildModuleLayerState(env, db, module.key);
    return `${module.label} env capability (${module.envVar}): ${
      layer.envEnabled ? "enabled" : hasEnv(env, module.envVar) ? "disabled" : "unset"
    }`;
  });
  const adminDetails = MODULE_CONTROLS.map((module) => {
    const layer = buildModuleLayerState(env, db, module.key);
    return `${module.label} ${formatModuleActivationDetail(db, layer.adminEnabled)}`;
  });
  const effectiveDetails = MODULE_CONTROLS.map((module) => {
    const layer = buildModuleLayerState(env, db, module.key);
    return `${module.label} effective state: ${
      layer.effectiveEnabled ? "enabled" : "disabled"
    }`;
  });
  const envConfigured = FEATURE_FLAGS.every((name) => hasEnv(env, name));
  const adminChecked = Boolean(db && db.adminModuleSettings);

  return applyProgress(
    {
      id: "feature-flags",
      title: "Module Controls",
      description: "Deploy env capability plus Admin Modules club activation for optional modules.",
      status: envConfigured && adminChecked ? "complete" : "warning",
      required: false,
      message:
        envConfigured && adminChecked
          ? "Module env capabilities and Admin Modules activation were checked."
          : "Module controls are layered; set env capability flags and review Admin Modules activation.",
      details: [
        ...envDetails,
        ...adminDetails,
        ...effectiveDetails,
      ],
    },
    progress,
  );
}

function buildBookingPolicyCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "booking-policies",
        title: "Booking Policies",
        description: "Non-member hold, cancellation rules, minimum stays, and group discount.",
        status: "warning",
        required: true,
        message: "Database booking policies were not checked.",
        details: ["Review this in /admin/setup after migrations and seed data have run."],
        href: "/admin/booking-policies",
      },
      progress,
    );
  }

  const hasCancellation = (db?.cancellationPolicyCount ?? 0) > 0;
  const hasDefaults = Boolean(db?.bookingDefaultsConfigured);
  const complete = hasCancellation && hasDefaults;
  return applyProgress(
    {
      id: "booking-policies",
      title: "Booking Policies",
      description: "Non-member hold, cancellation rules, minimum stays, and group discount.",
      status: complete ? "complete" : "warning",
      required: true,
      message: complete
        ? "Default booking policies are configured."
        : "Review booking policies before accepting live bookings.",
      details: [
        `Cancellation rules: ${db?.cancellationPolicyCount ?? 0}`,
        `Booking defaults: ${hasDefaults ? "configured" : "not configured"}`,
        `Group discount: ${db?.groupDiscountConfigured ? "configured" : "using defaults"}`,
      ],
      href: "/admin/booking-policies",
    },
    progress,
  );
}

function buildMembershipCancellationCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "membership-cancellation",
        title: "Membership Cancellation",
        description: "Warning text, rejoin process text, and Xero cancellation handling.",
        status: "warning",
        required: false,
        message: "Membership cancellation settings were not checked.",
        details: ["Review this in /admin/setup after migrations have run."],
        href: "/admin/setup",
      },
      progress,
    );
  }

  return applyProgress(
    {
      id: "membership-cancellation",
      title: "Membership Cancellation",
      description: "Warning text, rejoin process text, and Xero cancellation handling.",
      status: db.membershipCancellationSettingsConfigured ? "complete" : "warning",
      required: false,
      message: db.membershipCancellationSettingsConfigured
        ? "Membership cancellation settings have been saved."
        : "Default membership cancellation settings are available; review and save club-specific copy before enabling requests.",
      details: [
        `Xero cancelled contact groups: ${db.membershipCancellationXeroGroupCount}`,
        `Archive cancelled Xero contacts: ${
          db.membershipCancellationArchiveContacts ? "enabled" : "disabled"
        }`,
      ],
      href: "/admin/setup",
    },
    progress,
  );
}

function buildAgeTierCheck(
  club: ClubConfigReadResult,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "age-tiers",
        title: "Age And Membership Rules",
        description: "Age boundaries and whether each age tier needs a subscription to book.",
        status: "warning",
        required: true,
        message: "Database age-tier settings were not checked.",
        details: ["The CLI validated config age tiers; seeded database settings are checked in /admin/setup."],
        href: "/admin/age-tier-settings",
      },
      progress,
    );
  }

  const expected = club.config?.ageTiers.length ?? 0;
  const actual = db?.ageTierSettingCount ?? 0;
  const complete = expected > 0 && actual >= expected;
  return applyProgress(
    {
      id: "age-tiers",
      title: "Age And Membership Rules",
      description: "Age boundaries and whether each age tier needs a subscription to book.",
      status: complete ? "complete" : "warning",
      required: true,
      message: complete
        ? "Database age-tier settings are populated."
        : "Seed or review age-tier settings before member imports.",
      details: [
        `Config age tiers: ${expected || "unknown"}`,
        `Database age-tier settings: ${actual}`,
      ],
      href: "/admin/age-tier-settings",
    },
    progress,
  );
}

function buildSeasonRateCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "seasons-rates",
        title: "Seasons And Rates",
        description: "Season windows and member/non-member nightly rates in integer cents.",
        status: "warning",
        required: true,
        message: "Database seasons and rates were not checked.",
        details: ["Run seed data or configure seasons from /admin/seasons after login."],
        href: "/admin/seasons",
      },
      progress,
    );
  }

  const seasonCount = db?.seasonCount ?? 0;
  return applyProgress(
    {
      id: "seasons-rates",
      title: "Seasons And Rates",
      description: "Season windows and member/non-member nightly rates in integer cents.",
      status: seasonCount > 0 ? "complete" : "blocked",
      required: true,
      message:
        seasonCount > 0
          ? `${seasonCount} season${seasonCount === 1 ? "" : "s"} configured.`
          : "At least one active season with rates is needed before bookings can price correctly.",
      details: [`Configured seasons: ${seasonCount}`],
      href: "/admin/seasons",
    },
    progress,
  );
}

function buildStripeCheck(env: Env, progress: SetupProgressState): SetupStepCheck {
  const issues = [
    !isLikelyStripeSecret(readEnv(env, "STRIPE_SECRET_KEY"))
      ? "STRIPE_SECRET_KEY is missing or has an unexpected prefix"
      : null,
    !isLikelyStripePublishable(readEnv(env, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"))
      ? "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is missing or has an unexpected prefix"
      : null,
    !hasEnv(env, "STRIPE_WEBHOOK_SECRET")
      ? "STRIPE_WEBHOOK_SECRET is missing"
      : null,
  ].filter((issue): issue is string => Boolean(issue));

  return applyProgress(
    {
      id: "stripe",
      title: "Stripe",
      description: "Card payments, saved payment methods, refunds, and webhooks.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? "Stripe environment variables are present."
          : "Stripe environment variables need attention.",
      details: issues.length === 0 ? ["Secrets are set; values are not displayed."] : issues,
      href: "/admin/payments",
      action: {
        type: "provider-test",
        provider: "stripe",
        label: "Test Stripe",
      },
    },
    progress,
  );
}

function buildEmailCheck(env: Env, progress: SetupProgressState): SetupStepCheck {
  const issues = [
    !hasEnv(env, "SMTP_HOST") ? "SMTP_HOST is missing" : null,
    !hasEnv(env, "SMTP_PORT") ? "SMTP_PORT is missing" : null,
    !hasEnv(env, "AWS_SES_ACCESS_KEY_ID")
      ? "AWS_SES_ACCESS_KEY_ID is missing"
      : null,
    !hasEnv(env, "AWS_SES_SECRET_ACCESS_KEY")
      ? "AWS_SES_SECRET_ACCESS_KEY is missing"
      : null,
    !hasEnv(env, "EMAIL_FROM") ? "EMAIL_FROM is missing" : null,
    !hasEnv(env, "SES_SNS_TOPIC_ARN")
      ? "SES_SNS_TOPIC_ARN is missing for deployed SES feedback"
      : null,
  ].filter((issue): issue is string => Boolean(issue));

  return applyProgress(
    {
      id: "email-ses",
      title: "Email And SES",
      description: "SMTP sending plus SES SNS bounce and complaint feedback.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? "Email and SES environment variables are present."
          : "Email and SES variables need attention.",
      details: issues.length === 0 ? ["Secrets are set; values are not displayed."] : issues,
      href: "/admin/health",
      action: {
        type: "provider-test",
        provider: "smtp",
        label: "Test Email",
      },
    },
    progress,
  );
}

function buildSentryCheck(env: Env, progress: SetupProgressState): SetupStepCheck {
  const missing = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_ORG", "SENTRY_PROJECT"]
    .filter((name) => !hasEnv(env, name));

  return applyProgress(
    {
      id: "sentry",
      title: "Sentry",
      description: "Server, edge, browser error reporting, and source-map configuration.",
      status: missing.length === 0 ? "complete" : "warning",
      required: false,
      message:
        missing.length === 0
          ? "Sentry variables are present."
          : "Sentry can stay disabled, but production diagnostics will be limited.",
      details:
        missing.length === 0
          ? ["Sentry DSN/project variables are set; values are not displayed."]
          : missing.map((name) => `${name} is missing`),
      href: "/admin/health",
      action: {
        type: "provider-test",
        provider: "sentry",
        label: "Test Sentry",
      },
    },
    progress,
  );
}

function buildOperationalXeroCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(env, db, "xeroIntegration");
  const enabled = moduleState.effectiveEnabled;
  const issues = [
    !hasEnv(env, "XERO_CLIENT_ID") ? "XERO_CLIENT_ID is missing" : null,
    !hasEnv(env, "XERO_CLIENT_SECRET") ? "XERO_CLIENT_SECRET is missing" : null,
    !isHttpUrl(readEnv(env, "XERO_REDIRECT_URI"))
      ? "XERO_REDIRECT_URI must be a valid http(s) URL"
      : null,
    !isHexEncryptionKey(readEnv(env, "XERO_ENCRYPTION_KEY"))
      ? "XERO_ENCRYPTION_KEY must be a 64-character hex string"
      : null,
    !hasEnv(env, "XERO_WEBHOOK_KEY") ? "XERO_WEBHOOK_KEY is missing" : null,
  ].filter((issue): issue is string => Boolean(issue));
  const connected = Boolean(db?.operationalXeroConnected);

  return applyProgress(
    {
      id: "xero-operational",
      title: "Operational Xero",
      description: "Member/contact sync, invoices, payments, credit notes, and Xero webhooks.",
      status: !enabled
        ? "warning"
        : issues.length > 0
          ? "blocked"
          : !db
            ? "warning"
            : connected
            ? "complete"
            : "not_started",
      required: enabled,
      message: !enabled
          ? "Operational Xero is inactive by env capability or Admin Modules activation."
        : !db
          ? "Operational Xero env is ready; connection state was not checked."
        : connected
          ? "Operational Xero is connected."
          : issues.length > 0
            ? "Operational Xero env needs attention."
            : "Operational Xero env is ready; connect the tenant from admin.",
      details: [
        `Env capability (${moduleState.envVar}): ${
          moduleState.envEnabled ? "enabled" : "disabled"
        }`,
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        ...issues,
        !db
          ? "Database connection state not checked."
          : connected
          ? `Token expires: ${db?.operationalXeroTokenExpiresAt ?? "unknown"}`
          : "No active operational Xero token found.",
      ],
      href: "/admin/xero",
      action: {
        type: "provider-test",
        provider: "xero",
        label: "Check Xero",
      },
    },
    progress,
  );
}

function buildFinanceXeroCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(env, db, "financeDashboard");
  const enabled = moduleState.effectiveEnabled;
  const issues = [
    !hasEnv(env, "FINANCE_XERO_CLIENT_ID")
      ? "FINANCE_XERO_CLIENT_ID is missing"
      : null,
    !hasEnv(env, "FINANCE_XERO_CLIENT_SECRET")
      ? "FINANCE_XERO_CLIENT_SECRET is missing"
      : null,
    !isHttpUrl(readEnv(env, "FINANCE_XERO_REDIRECT_URI"))
      ? "FINANCE_XERO_REDIRECT_URI must be a valid http(s) URL"
      : null,
    !isHexEncryptionKey(readEnv(env, "FINANCE_XERO_ENCRYPTION_KEY"))
      ? "FINANCE_XERO_ENCRYPTION_KEY must be a 64-character hex string"
      : null,
  ].filter((issue): issue is string => Boolean(issue));
  const connected = Boolean(db?.financeXeroConnected);

  return applyProgress(
    {
      id: "xero-finance",
      title: "Finance Xero",
      description: "Separate finance-reporting Xero OAuth boundary and token storage.",
      status: !enabled
        ? "warning"
        : issues.length > 0
          ? "blocked"
          : !db
            ? "warning"
            : connected
            ? "complete"
            : "not_started",
      required: enabled,
      message: !enabled
          ? "Finance dashboard is inactive by env capability or Admin Modules activation."
        : !db
          ? "Finance Xero env is ready; connection state was not checked."
        : connected
          ? "Finance Xero is connected."
          : issues.length > 0
            ? "Finance Xero env needs attention."
            : "Finance Xero env is ready; connect from the finance dashboard.",
      details: [
        `Env capability (${moduleState.envVar}): ${
          moduleState.envEnabled ? "enabled" : "disabled"
        }`,
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        ...issues,
        !db
          ? "Database connection state not checked."
          : connected
          ? `Token expires: ${db?.financeXeroTokenExpiresAt ?? "unknown"}`
          : "No active finance Xero token found.",
      ],
      href: "/finance",
      action: {
        type: "provider-test",
        provider: "finance-xero",
        label: "Check Finance Xero",
      },
    },
    progress,
  );
}

function buildXeroMappingCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  if (!db) {
    return applyProgress(
      {
        id: "xero-mappings",
        title: "Xero Mappings",
        description: "Chart of accounts, hut fee item codes, and entrance-fee categories.",
        status: "warning",
        required: false,
        message: "Xero mapping database state was not checked.",
        details: ["Review mappings from /admin/xero after connecting Xero."],
        href: "/admin/xero#xero-section-mappings",
      },
      progress,
    );
  }

  const accountMappings = db?.xeroAccountMappingCount ?? 0;
  const hutFeeMappings = db?.xeroHutFeeItemMappingCount ?? 0;
  const entranceFeeMappings = db?.xeroEntranceFeeMappingCount ?? 0;
  const complete = accountMappings > 0 && hutFeeMappings > 0 && entranceFeeMappings > 0;

  return applyProgress(
    {
      id: "xero-mappings",
      title: "Xero Mappings",
      description: "Chart of accounts, hut fee item codes, and entrance-fee categories.",
      status: complete ? "complete" : "warning",
      required: false,
      message: complete
        ? "Xero account and item mappings are configured."
        : "Map Xero accounts and item codes before using live Xero sync.",
      details: [
        `Account mappings: ${accountMappings}`,
        `Hut fee item mappings: ${hutFeeMappings}`,
        `Entrance fee mappings: ${entranceFeeMappings}`,
      ],
      href: "/admin/xero#xero-section-mappings",
    },
    progress,
  );
}

export function buildSetupReadiness(input: {
  env?: Env;
  configDir?: string;
  database?: SetupDatabaseSnapshot;
  progress?: Partial<SetupProgressState> | null;
  now?: Date;
} = {}): SetupReadiness {
  const env = input.env ?? process.env;
  const configDir = input.configDir ?? path.join(process.cwd(), "config");
  const progress = normalizeSetupProgress(input.progress);
  const club = readClubConfig(configDir);

  const checksByCategory: Record<SetupCategoryId, SetupStepCheck[]> = {
    foundation: [
      buildClubConfigCheck(club, progress),
      buildRuntimeEnvCheck(env, progress),
      buildSeedAdminCheck(input.database, progress),
      buildFeatureFlagCheck(env, input.database, progress),
    ],
    booking: [
      buildBookingPolicyCheck(input.database, progress),
      buildMembershipCancellationCheck(input.database, progress),
      buildAgeTierCheck(club, input.database, progress),
      buildSeasonRateCheck(input.database, progress),
    ],
    integrations: [
      buildStripeCheck(env, progress),
      buildEmailCheck(env, progress),
      buildSentryCheck(env, progress),
      buildOperationalXeroCheck(env, input.database, progress),
    ],
    finance: [
      buildFinanceXeroCheck(env, input.database, progress),
      buildXeroMappingCheck(input.database, progress),
    ],
  };

  const categories = CATEGORY_ORDER.map((id) => {
    const checks = checksByCategory[id];
    return {
      id,
      ...CATEGORY_META[id],
      status: worstStatus(checks.map((check) => check.status)),
      checks,
    };
  });
  const allChecks = categories.flatMap((category) => category.checks);
  const skipped = allChecks.filter((check) => check.progress === "skipped").length;
  const complete = allChecks.filter((check) => check.status === "complete").length;
  const warning = allChecks.filter((check) => check.status === "warning").length;
  const blocked = allChecks.filter((check) => check.status === "blocked").length;
  const activeStatuses = allChecks
    .filter((check) => check.progress !== "skipped")
    .map((check) => check.status);

  return {
    status: worstStatus(activeStatuses),
    summary: {
      total: allChecks.length,
      complete,
      warning,
      blocked,
      skipped,
    },
    categories,
    generatedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function renderSetupCheckReport(readiness: SetupReadiness): string {
  const lines = [
    `Setup readiness: ${readiness.status}`,
    `Complete ${readiness.summary.complete}/${readiness.summary.total}, warnings ${readiness.summary.warning}, blocked ${readiness.summary.blocked}, skipped ${readiness.summary.skipped}`,
    "",
  ];

  for (const category of readiness.categories) {
    lines.push(`${category.title} (${category.status})`);
    for (const check of category.checks) {
      const progressLabel =
        check.progress === "open" ? "" : `, ${check.progress}`;
      lines.push(`- ${check.title}: ${check.status}${progressLabel} - ${check.message}`);
      for (const detail of check.details) {
        lines.push(`  ${detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function getSetupRequiredEnvNames(): string[] {
  return [
    ...REQUIRED_RUNTIME_ENV,
    "AUTH_SECRET or NEXTAUTH_SECRET",
    ...FEATURE_FLAGS,
    "STRIPE_SECRET_KEY",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "AWS_SES_ACCESS_KEY_ID",
    "AWS_SES_SECRET_ACCESS_KEY",
    "SES_SNS_TOPIC_ARN",
    "EMAIL_FROM",
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "XERO_CLIENT_ID",
    "XERO_CLIENT_SECRET",
    "XERO_REDIRECT_URI",
    "XERO_ENCRYPTION_KEY",
    "XERO_WEBHOOK_KEY",
    "FINANCE_XERO_CLIENT_ID",
    "FINANCE_XERO_CLIENT_SECRET",
    "FINANCE_XERO_REDIRECT_URI",
    "FINANCE_XERO_ENCRYPTION_KEY",
  ];
}
