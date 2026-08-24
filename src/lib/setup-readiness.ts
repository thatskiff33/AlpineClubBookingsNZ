import fs from "node:fs";
import path from "node:path";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  CLUB_TIME_ZONE_FALLBACK,
  CLUB_TIME_ZONE_MAX_LENGTH,
  normaliseClubTimeZone,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import {
  classifyEnvironmentClubTimeZoneSeed,
  type EnvironmentClubTimeZoneSeed,
} from "@/lib/club-time-zone-env";
/*
  TYPE-ONLY, and it has to stay that way. `environment-role.ts` imports
  `@/lib/prisma`, and this module is imported by the `tsx` entrypoints
  `npm run setup` / `npm run setup:check` as well as by the admin API. An
  `import type` is erased before anything runs, so the resolution arrives here as
  DATA on the injected snapshot (`SetupDatabaseSnapshot.environmentRole`,
  resolved in `setup-readiness-db.ts`) and `buildSetupReadiness` stays
  synchronous over injected data. Making it async to call the resolver from in
  here would ripple through every caller and every test that builds a readiness
  report.
*/
import type { EnvironmentRoleResolution } from "@/lib/environment-role";
import type { EnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
// Type-only for the same reason as the line above, so this module keeps no
// runtime edge to anything that reads a database.
import type { WithheldApplicationEmail } from "@/lib/environment-safety-withheld";
import { clubConfigSchema, type ClubConfig } from "../config/schema";
import {
  DEFAULT_ADMIN_MODULE_SETTINGS,
  normalizeAdminModuleSettings,
  type AdminModuleKey,
  type AdminModuleSettingsSnapshot,
} from "./admin-modules";
import { resolveEmailDeliveryConfigFromEnv } from "@/lib/email-delivery";
import {
  XERO_REQUIRED_REPORT_OAUTH_SCOPES,
  detectLegacyProviderEnv,
} from "@/lib/xero-config";
import { authSecretWeaknessReason } from "@/lib/integration-crypto";

export const SETUP_STEP_IDS = [
  "club-config",
  "club-time-zone",
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
  "seed-admin",
  "feature-flags",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "stripe",
  "email-ses",
  "sentry",
  "address-autocomplete",
  "xero-operational",
  "finance-dashboard",
  "xero-mappings",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
type SetupCategoryId =
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
  // A Xero token row exists but no longer decrypts (env→DB upgrade or an
  // auth-secret change, #2079): the connection needs re-entry/reconnect, not
  // "connected". Distinguishes "needs reconnect" from "never connected" so the
  // Operational Xero step shows the right guidance. Optional/undefined for older
  // callers or when no DB snapshot was taken.
  operationalXeroNeedsReentry?: boolean;
  operationalXeroTokenExpiresAt: string | null;
  // DB-only Stripe credentials (#2082): metadata-only set-state of the three
  // encrypted Stripe keys, plus whether any of them fails to decrypt (the auth
  // secret changed). Optional/undefined for older callers or when no DB snapshot
  // was taken — the Stripe check then reports "not checked".
  stripeSecretKeySet?: boolean;
  stripePublishableKeySet?: boolean;
  stripeWebhookSecretSet?: boolean;
  stripeNeedsReentry?: boolean;
  xeroAccountMappingCount: number;
  xeroHutFeeItemMappingCount: number;
  xeroEntranceFeeMappingCount: number;
  // Per-membership-type rate gaps (#1930, E4): "TypeName — SeasonName" entries
  // for every MEMBER_RATE type × active/future season whose rate coverage is
  // incomplete (see computeMembershipTypeRateGaps). Any entry means a booking
  // for that type on some (or all) of those dates hard-throws at pricing, so
  // the Seasons And Rates step drops to a warning.
  membershipTypeRateGaps?: string[];
  // Public {{hut-fees}} embed readiness (#2129). The embed renders one nightly
  // -rate column per publicly-listed active membership type that carries rates
  // for the season (identically-priced types share one collapsed column). This
  // lists "Lodge — Season" entries that would render FEWER THAN TWO columns, so
  // a published rate table cannot silently collapse to a single column (for
  // example when only one membership type is flagged publicly listed, or none
  // at all). Computed only while the hut-fees public-content toggle is ON AND
  // the token actually appears on a published page; empty or undefined (toggle
  // off, token never placed, older callers, no DB) raises no warning.
  publicHutFeeSingleColumnSeasons?: string[];
  // Misconfig soft-check (#2041): names of ACTIVE membership types set to
  // "subscription required based on age tier" while NO configured age tier
  // actually requires a subscription — such a type can never invoice or lock
  // anyone, so the Age And Membership Rules step drops to a warning. Empty (or
  // undefined for older callers / no DB) means no misconfig.
  basedOnAgeTierTypesWithoutSubscribingTier?: string[];
  // DB-first club-config gate (#1987, C8): the club's persisted identity name
  // (ClubIdentitySettings.name, else EmailMessageSetting.clubName), and the
  // admin-set default-lodge capacity (LodgeSettings.capacity). A truthy
  // clubIdentityName means the club is configured in the DB, so an absent
  // config/club.json is normal — the file is only an optional seed now.
  clubIdentityName?: string | null;
  configuredCapacity?: number | null;
  // The persisted club timezone (CT-1, #2989): `ClubTimeSettings.timeZone`, or
  // null when no row exists yet. Optional so an older caller — and a DB-less
  // `setup:check` run, which passes no snapshot at all — still compiles; on a
  // snapshot that WAS taken, undefined and null both mean "no row", which the
  // club-time-zone check reports as not-yet-configured. This is the CLUB's
  // timezone, never the server's or the container's `TZ`.
  clubTimeZone?: string | null;
  // True when the `ClubTimeSettings` read itself FAILED (CT-1, #2989) — an
  // un-migrated schema, or a database that answered every sibling query and not
  // this one. Distinct from `clubTimeZone: null` on purpose: "no row yet" is a
  // normal state with a known remedy ("the app records it on the next start"),
  // and telling an operator that when the table does not exist sends them to
  // wait for something that cannot happen. Undefined (older callers, a snapshot
  // taken before this field existed) means the read succeeded.
  clubTimeZoneUnreadable?: boolean;
  // Whether this installation is production, non-production or not yet declared
  // (ENV-SAFETY 1, #3034; epic #2986), already RESOLVED by
  // `resolveEnvironmentRole()` in `setup-readiness-db.ts`. It is carried as data
  // rather than resolved here because the resolver reads the database and this
  // file is deliberately synchronous over an injected snapshot. Optional so an
  // older caller — and a DB-less `setup:check` run, which passes no snapshot at
  // all — still compiles; undefined means the question was not asked, which the
  // check below reports as "not checked" rather than guessing at an answer.
  environmentRole?: EnvironmentRoleResolution;
  // How much application email this installation has held back for
  // environment-safety reasons (ENV-SAFETY 1, #3034), read in
  // `setup-readiness-db.ts`. Optional so an older caller and a DB-less
  // `setup:check` still compile; undefined is reported the same way
  // `{ available: false }` is, because neither one is a count.
  withheldEmail?: WithheldApplicationEmail;
  // Resolved booking capacity of the club's DEFAULT lodge
  // (getDefaultLodgeCapacity). Since #1982 the club-config check warns when this
  // is 0 — a default lodge with no active beds AND no capacity override accepts
  // no bookings, the never-overbook signal for a fork whose boot self-heal was
  // skipped. Undefined when the snapshot omits it (older callers / no DB) → no
  // capacity warning is raised.
  defaultLodgeCapacity?: number | null;
}

// One membership type × season pair for the rate-gap check (#1930, E4).
export interface MembershipTypeRateGapType {
  id: string;
  name: string;
  ageGroupsApply: boolean;
}

export interface MembershipTypeRateGapSeason {
  id: string;
  name: string;
}

export interface MembershipTypeRateGapRow {
  seasonId: string;
  membershipTypeId: string;
  ageTier: string | null;
}

/**
 * Tier-aware missing-rate readiness (#1930, E4). A (type, season) pair is
 * covered when a booking for ANY bookable age tier can price:
 *   - ageGroupsApply=true: every bookable tier has an exact row, OR a flat
 *     (NULL-ageTier) row exists (the engine falls back exact-tier -> flat);
 *   - ageGroupsApply=false: the single flat row exists (tier rows alone are a
 *     shape anomaly the write surfaces reject — flag them).
 * Anything less means some guest hard-throws at pricing. Callers pass ACTIVE
 * MEMBER_RATE types only — archived types price history and are skipped.
 */
export function computeMembershipTypeRateGaps(input: {
  types: MembershipTypeRateGapType[];
  seasons: MembershipTypeRateGapSeason[];
  rateRows: MembershipTypeRateGapRow[];
  bookableAgeTiers?: readonly string[];
}): string[] {
  const bookableTiers = input.bookableAgeTiers ?? bookableAgeTierEnum.options;
  const tiersByPair = new Map<string, Set<string | null>>();
  for (const row of input.rateRows) {
    const key = `${row.membershipTypeId}::${row.seasonId}`;
    const set = tiersByPair.get(key) ?? new Set<string | null>();
    set.add(row.ageTier);
    tiersByPair.set(key, set);
  }

  const gaps: string[] = [];
  for (const type of input.types) {
    for (const season of input.seasons) {
      const tiers = tiersByPair.get(`${type.id}::${season.id}`);
      const hasFlat = tiers?.has(null) ?? false;
      if (type.ageGroupsApply) {
        if (hasFlat) continue;
        const missingTiers = bookableTiers.filter((tier) => !tiers?.has(tier));
        if (missingTiers.length === 0) continue;
        gaps.push(
          `${type.name} — ${season.name} (missing ${missingTiers.join(", ")})`,
        );
      } else {
        if (hasFlat) continue;
        gaps.push(`${type.name} — ${season.name} (missing flat all-ages rate)`);
      }
    }
  }
  return gaps;
}

interface SetupStepCheck {
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
    provider: "stripe" | "smtp" | "sentry" | "xero";
    label: string;
  };
  progress: "open" | "completed" | "skipped";
}

interface SetupCategory {
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
  // Whether the PRIMARY config/club.json (not the example) exists on disk. The
  // DB-first gate treats only a valid primary as a real committed config; the
  // committed club.example.json placeholder never satisfies readiness (#1987).
  primaryExists: boolean;
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
    description:
      "Club identity, runtime env, administrator account, and feature switches.",
  },
  booking: {
    title: "Booking Rules",
    description:
      "Capacity, age tiers, rates, seasons, cancellation, and hold settings.",
  },
  integrations: {
    title: "Operational Integrations",
    description: "Stripe, email, Sentry, and operational Xero setup state.",
  },
  finance: {
    title: "Finance",
    description: "Finance dashboard module and Xero chart/item mappings.",
  },
};

const MODULE_CONTROLS = [
  { key: "kiosk", label: "Lodge kiosk" },
  { key: "chores", label: "Chores and roster" },
  { key: "financeDashboard", label: "Finance dashboard" },
  { key: "waitlist", label: "Waitlist" },
  { key: "xeroIntegration", label: "Operational Xero" },
  { key: "bedAllocation", label: "Bed allocation" },
  { key: "internetBankingPayments", label: "Internet Banking payments" },
  { key: "addressAutocomplete", label: "Address autocomplete" },
  { key: "analytics", label: "Google Analytics" },
] as const satisfies readonly {
  key: AdminModuleKey;
  label: string;
}[];

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
  return statuses.reduce<SetupStatus>(
    (worst, status) =>
      toStatusScore(status) > toStatusScore(worst) ? status : worst,
    "complete",
  );
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

/**
 * Setup-readiness view of the club config, kept in lockstep with the runtime
 * loader `loadClubConfig` (`src/config/club.ts`) under owner decision D3
 * (epic #1943, child C1):
 * - When `club.json` exists it is the source (even if malformed) — a malformed
 *   PRIMARY is reported *blocked* and NEVER falls through to `club.example.json`,
 *   so the app never boots on the example's identity while readiness is blocked.
 * - Only an ABSENT primary falls back to `club.example.json`.
 * The runtime loader mirrors this (malformed primary → SAFE_DEFAULT_CONFIG;
 * absent primary → valid example, else SAFE_DEFAULT_CONFIG) so the two agree.
 */
function readClubConfig(configDir: string): ClubConfigReadResult {
  const primaryPath = path.join(configDir, "club.json");
  const examplePath = path.join(configDir, "club.example.json");
  const primaryExists = fs.existsSync(primaryPath);
  const sourcePath = primaryExists ? primaryPath : examplePath;

  if (!fs.existsSync(sourcePath)) {
    return {
      sourcePath,
      exists: false,
      primaryExists,
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
        primaryExists,
        config: null,
        issues: result.error.issues.map((issue) => {
          const fieldPath =
            issue.path.length > 0 ? issue.path.join(".") : "root";
          return `${fieldPath}: ${issue.message}`;
        }),
      };
    }

    return {
      sourcePath,
      exists: true,
      primaryExists,
      config: result.data,
      issues: [],
    };
  } catch (error) {
    return {
      sourcePath,
      exists: true,
      primaryExists,
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

function isResolvedByProgress(check: SetupStepCheck): boolean {
  return check.progress === "completed" || check.progress === "skipped";
}

function unresolvedStatuses(checks: SetupStepCheck[]): SetupStatus[] {
  return checks
    .filter((check) => !isResolvedByProgress(check))
    .map((check) => check.status);
}

/**
 * Club-config gate, DB-first (#1987, C8). Configuration lives in the database;
 * `config/club.json` is only an optional seed. Resolution order:
 *
 * 1. A MALFORMED primary `club.json` (present but invalid JSON/schema) is still
 *    reported *blocked* and loudly, regardless of DB state — the C1/D3 rule so a
 *    broken primary is never silently masked (mirrors the runtime loader).
 * 2. The club is "configured" when the DB holds a persisted identity name OR a
 *    valid PRIMARY `config/club.json` is committed (an adopter's real config,
 *    which the runtime resolves through). The committed `club.example.json`
 *    placeholder never counts — it is only a seed.
 * 3. When a database snapshot is available and the club is not configured, the
 *    step is *blocked* (not configured yet). With no snapshot (e.g. setup:check
 *    before the DB is reachable) and no primary config, it is a *warning*
 *    ("configure via /admin/setup") — an absent file is no longer a hard block.
 */
function buildClubConfigCheck(
  club: ClubConfigReadResult,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const base = {
    id: "club-config" as const,
    title: "Club Config",
    description:
      "Club identity, contact details, bed capacity, age tiers, and default rates.",
    required: true,
    href: "/admin/setup",
  };

  // 1. A malformed primary always blocks loudly (C1/D3), whatever the DB holds.
  if (club.primaryExists && !club.config) {
    return applyProgress(
      {
        ...base,
        status: "blocked",
        message:
          "config/club.json is present but invalid; fix or remove it (configuration otherwise lives in the database).",
        details: [`Source: ${club.sourcePath}`, ...club.issues],
      },
      progress,
    );
  }

  const dbClubName = db?.clubIdentityName?.trim() || null;
  const hasPrimaryConfig = club.primaryExists && Boolean(club.config);
  // #1982 never-overbook signal: the RESOLVED default-lodge capacity is 0, so
  // the club is configured but accepts no bookings until beds/capacity are set
  // (e.g. a fork whose boot self-heal was skipped). Undefined → not checked.
  const capacityUnconfigured =
    db?.defaultLodgeCapacity != null && db.defaultLodgeCapacity <= 0;
  const capacityWarningDetail =
    "Resolved default-lodge capacity is 0 — configure beds or a capacity override before taking bookings.";

  // 2. Configured via the DB identity.
  if (dbClubName) {
    const capacity = db?.configuredCapacity ?? null;
    return applyProgress(
      {
        ...base,
        status: capacityUnconfigured ? "warning" : "complete",
        message: capacityUnconfigured
          ? `${dbClubName} is configured, but its default lodge has no bookable capacity yet.`
          : capacity != null
            ? `${dbClubName} is configured with ${capacity} total beds.`
            : `${dbClubName} is configured. Set the default-lodge capacity in /admin/setup if it is not yet defined.`,
        details: [
          "Source: database (ClubIdentitySettings / EmailMessageSetting)",
          `Club: ${dbClubName}`,
          capacity != null
            ? `Configured capacity: ${capacity} beds`
            : "Configured capacity: not set (falls back to lodge beds)",
          ...(capacityUnconfigured ? [capacityWarningDetail] : []),
        ],
      },
      progress,
    );
  }

  // 2b. Configured via a committed PRIMARY club.json (adopter's real config).
  if (hasPrimaryConfig && club.config) {
    const capacity = club.config.beds.reduce(
      (total, bed) => total + bed.capacity,
      0,
    );
    return applyProgress(
      {
        ...base,
        status: capacityUnconfigured ? "warning" : "complete",
        message: capacityUnconfigured
          ? `${club.config.name} is configured, but its default lodge has no bookable capacity yet.`
          : `${club.config.name} is configured with ${capacity} total beds.`,
        details: [
          `Source: ${club.sourcePath}`,
          `Club: ${club.config.name}`,
          `Configured capacity: ${capacity} beds`,
          "Admin edits in /admin/setup override these seed values in the database.",
          ...(capacityUnconfigured ? [capacityWarningDetail] : []),
        ],
      },
      progress,
    );
  }

  // 3. Not configured. Blocked when the DB was checked; a warning otherwise.
  if (db) {
    return applyProgress(
      {
        ...base,
        status: "blocked",
        message:
          "Club identity is not configured yet. Run npm run setup:wizard or open /admin/setup to enter the club name, capacity, and age tiers.",
        details: [
          "Source: database (ClubIdentitySettings / EmailMessageSetting)",
          "No persisted club identity found, and no primary config/club.json is committed.",
        ],
      },
      progress,
    );
  }
  return applyProgress(
    {
      ...base,
      status: "warning",
      message:
        "Club identity is not configured on disk and the database was not checked. Configuration lives in the database — run npm run setup:wizard or verify /admin/setup after migrations.",
      details: [
        "Source: none (config/club.json is an optional seed; club.example.json does not count)",
        "Database state was not checked.",
      ],
    },
    progress,
  );
}

/**
 * The one sentence every detail list below repeats, because it is the single
 * thing an operator most often gets wrong: the club timezone and the machine's
 * timezone are different settings with different owners.
 */
const CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL =
  "This is the club's timezone, not the server's or container's timezone. They are separate settings: the club's timezone decides which day a lodge night belongs to and what time members see, and it is stored in the database, so changing TZ on the host does not change it.";

/**
 * Render a timezone value that did NOT come through the validated write path
 * safely enough to print — a stored value that failed validation, or the raw
 * `TZ` / `NEXT_PUBLIC_TZ` string.
 *
 * Neither is bounded: a stored bad value reaches this path only through database
 * surgery or an ICU that no longer knows the zone, and an environment variable is
 * whatever the operator's deployment tooling put there. The readiness report is
 * rendered into an operator's terminal by `setup:check`, so control characters
 * are replaced and the value is capped — naming what is actually there is what
 * makes the failure fixable.
 */
function printableTimeZoneValue(value: string): string {
  const printable = value.replace(/[^\x20-\x7E]/g, "?");
  return printable.length > CLUB_TIME_ZONE_MAX_LENGTH
    ? `${printable.slice(0, CLUB_TIME_ZONE_MAX_LENGTH)}…`
    : printable;
}

/**
 * Plain-English provenance of the zone the app will RECORD for a club that has
 * none stored yet — for the two states where there is one. See
 * `decideClubTimeZoneBackfill` in `config-self-heal-steps.ts` for the decision
 * itself; this only puts it into words, and `club-time-zone-backfill-agreement`
 * in the tests pins the two together so the words cannot describe a different
 * zone from the one the next boot writes.
 */
function describeClubTimeZoneToRecord(
  raw: string | null,
  toRecord: string,
): string {
  if (raw === null) {
    return "No TZ or NEXT_PUBLIC_TZ is set, so the built-in New Zealand default applies.";
  }
  if (raw === toRecord) {
    return "Taken from the TZ / NEXT_PUBLIC_TZ environment variable, which seeds this setting once and is then no longer consulted.";
  }
  return `Taken from the TZ / NEXT_PUBLIC_TZ environment variable, which says "${printableTimeZoneValue(raw)}" — the same place, named the way this runtime spells it. The variable seeds this setting once and is then no longer consulted.`;
}

/**
 * Where the zone the app is ANSWERING with came from, for a club whose stored
 * value cannot be used.
 *
 * This describes `resolveClubTimeZone`, the canonical reader's rule. A row
 * exists, so no backfill will ever touch it; the app is on its documented
 * fallback path until somebody stores a usable zone.
 *
 * IT IS JUDGED FROM THE CLASSIFIED SEED, not from the raw string (#2989 fix
 * round). The first version asked `normaliseClubTimeZone(raw) === fallback` —
 * the OPERATOR-INPUT validator — while the value it was describing came out of
 * `resolveClubTimeZone`, whose environment leg uses the PRESERVATION rule. On any
 * deployment whose `TZ` is one of the thirty-six legacy aliases the two disagree,
 * and the step printed two adjacent contradicting sentences: "falling back to
 * Europe/London", then "the TZ value ("GB") is not a named place either, so the
 * built-in New Zealand default applies". Taking `seed.kind` makes it impossible
 * to answer this question with a different rule from the one that produced the
 * answer.
 */
function describeReaderFallback(seed: EnvironmentClubTimeZoneSeed): string {
  if (seed.kind === "absent") {
    return "No TZ or NEXT_PUBLIC_TZ is set, so the built-in New Zealand default applies.";
  }
  if (seed.kind === "unusable") {
    return `The TZ / NEXT_PUBLIC_TZ value in the environment ("${printableTimeZoneValue(seed.raw)}") is not a named place either, so the built-in New Zealand default applies until the club's timezone is set again.`;
  }
  if (seed.raw === seed.timeZone) {
    return "That is the TZ / NEXT_PUBLIC_TZ value from the environment, which stands in only while nothing usable is stored.";
  }
  return `That is the TZ / NEXT_PUBLIC_TZ value from the environment, which says "${printableTimeZoneValue(seed.raw)}" — the same place, named the way this runtime spells it. It stands in only while nothing usable is stored.`;
}

/**
 * Club-timezone gate (CT-1, #2989; epic #2988). The club has exactly one
 * persisted IANA timezone and it is the sole civil-time authority
 * (INV-CONFIG-002), so setup is not finished until it is stored explicitly.
 *
 * Seven states:
 * 1. **No snapshot** — `setup:check` ran before the database was reachable. The
 *    same "not checked" warning the sibling DB-backed steps use; it cannot be
 *    answered from the environment, because the environment is precisely what
 *    this setting stops being authoritative.
 * 2. **The row could not be READ** — the table is missing, or that one query
 *    failed. Also "not checked", and deliberately not the same message as state
 *    5: the remedy for an absent row is "wait for the next start", which is not
 *    a remedy for a table that does not exist.
 * 3. **A stored zone that validates** → complete, and the message NAMES it, so a
 *    club that has been running on `Australia/Sydney` can see at a glance that
 *    the upgrade did not move it.
 * 4. **A stored zone that does not validate** → blocked. Only DB surgery or an
 *    ICU that dropped the zone can produce this; the app keeps answering from the
 *    environment fallback meanwhile, and the details say so rather than implying
 *    the stored value is in force. This is `persisted-unusable` in
 *    `ClubTimeZoneSource`, and the maintenance panel says the same thing about
 *    it — one state, one instruction, wherever the operator meets it.
 * 5. **No row, and the environment names a place** (or says nothing at all) →
 *    blocked, naming the zone the next start will record. A fresh install and a
 *    just-migrated existing install are both here, and it is deliberately a block
 *    rather than a warning: it is what stops setup finishing without an explicit
 *    timezone (issue AC). It is also not an emergency — the message names what
 *    will be recorded — so the block reads as "confirm this", not "the site is
 *    broken".
 * 6. **No row, and the environment names NO place** (`TZ=UTC`, `Etc/GMT-12`) →
 *    **warning**, naming the raw value and the `Pacific/Auckland` the next start
 *    will record in its place. Owner decision, 23 Aug 2026 (#2989): such a
 *    deployment is defaulted rather than blocked, because the zone it is
 *    effectively using is not a storable club timezone and refusing to record
 *    anything just leaves the setting empty. Not a block, because the owner said
 *    not to block setup; not silence, because the club may be up to thirteen
 *    hours from the zone it is about to be handed.
 * 7. **`Pacific/Auckland` is stored, and the environment STILL names no place**
 *    → **warning**, the post-boot form of state 6 and the state an operator
 *    actually meets. The boot backfill runs before anybody can open
 *    `/admin/setup`, so by the time this page renders the row exists and states 6
 *    and 3 would otherwise be indistinguishable — a club that has been on `UTC`
 *    for years would read a clean "complete" naming a zone nobody chose, which is
 *    exactly what the owner's decision says must not happen.
 *
 *    IT CANNOT KNOW whether that `Pacific/Auckland` was defaulted or chosen: the
 *    row records no provenance, and the setup CLI writes the same
 *    `updatedByMemberId: null` a boot does. So the wording does not claim to
 *    know — it says what is stored, says the environment could not confirm it,
 *    and asks. The operator clears it either way: Acknowledge on this step if the
 *    zone is right, or set the real one at `/admin/club-time` if it is not. That
 *    a club deliberately on `Pacific/Auckland` with a `UTC` container sees this
 *    once is the accepted cost of the club that was moved thirteen hours seeing
 *    it at all.
 *
 * Deliberately clock-free: nothing here formats a date, so the answer is the same
 * at every instant.
 */
function buildClubTimeZoneCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const base = {
    id: "club-time-zone" as const,
    title: "Club Timezone",
    description:
      "The one timezone the club runs on — which day a lodge night falls on, and what time members see.",
    required: true,
    href: "/admin/club-time",
  };

  // 1. The database was not checked at all.
  if (!db) {
    return applyProgress(
      {
        ...base,
        status: "warning",
        message: "Database state was not checked.",
        details: [
          "Run setup:check again inside an environment with database access, or review /admin/setup after login.",
          "The club's timezone is stored in the database, so it cannot be read without a database connection.",
          CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
        ],
      },
      progress,
    );
  }

  // 2. The row could not be read — see state 2 in the docblock.
  if (db.clubTimeZoneUnreadable) {
    return applyProgress(
      {
        ...base,
        status: "warning",
        message: "The club's timezone could not be read from the database.",
        details: [
          "Every other setting answered, so this is not simply a database outage: the ClubTimeSettings table is most likely missing because the migration has not been applied on this database yet.",
          "Run prisma migrate deploy (or npm run db:migrate in development), then check again. Nothing is stored automatically until this read succeeds.",
          CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
        ],
      },
      progress,
    );
  }

  const stored = db.clubTimeZone ?? null;

  // The environment, judged exactly as the boot backfill judges it
  // (`decideClubTimeZoneBackfill`): its value is being PRESERVED, not approved,
  // so `GB` is Europe/London and `NZ-CHAT` is Pacific/Chatham — while `UTC` and
  // `Etc/GMT-12` name no place at all and are defaulted instead.
  const seed = classifyEnvironmentClubTimeZoneSeed();

  // 5 / 6. No row yet — a fresh install, or an existing one between
  //         `prisma migrate deploy` and its first boot on the new release.
  if (stored === null) {
    // 6. The environment names no place, so the next start records the
    //    documented default and says so. See the docblock.
    if (seed.kind === "unusable") {
      const raw = printableTimeZoneValue(seed.raw);
      return applyProgress(
        {
          ...base,
          status: "warning",
          message: `The club's timezone has not been stored yet, and TZ / NEXT_PUBLIC_TZ is set to "${raw}", which is not a place — so the app will store ${CLUB_TIME_ZONE_FALLBACK}. Confirm that, or set the club's timezone at /admin/club-time.`,
          details: [
            "Source: none — nothing is stored in the database yet.",
            `The TZ / NEXT_PUBLIC_TZ value in the environment is "${raw}". UTC, GMT and fixed offsets such as Etc/GMT-12 name no place, so they carry no daylight-saving rules and no club's civil time can be read from one.`,
            `To be stored: ${CLUB_TIME_ZONE_FALLBACK}, the built-in New Zealand default — there was nothing in the environment to preserve, so this is a default and not the zone this deployment was using. If the club is somewhere else, set it at /admin/club-time (or run npm run setup) before or after the next start; a stored zone is never overwritten.`,
            CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
          ],
        },
        progress,
      );
    }

    // 5. The environment names a place (or says nothing, and the documented New
    //    Zealand default applies), so the next start records it.
    const toRecord =
      seed.kind === "preserved" ? seed.timeZone : CLUB_TIME_ZONE_FALLBACK;
    const raw = seed.kind === "preserved" ? seed.raw : null;
    return applyProgress(
      {
        ...base,
        status: "blocked",
        message: `The club's timezone has not been stored yet, so the app will store ${toRecord}. Confirm or change it, then it is fixed for good.`,
        details: [
          "Source: none — nothing is stored in the database yet.",
          `To be stored: ${toRecord}. ${describeClubTimeZoneToRecord(raw, toRecord)}`,
          "The app stores this zone automatically the next time it starts, keeping exactly the timezone this deployment already used. To store it now without a restart, run npm run config:self-heal.",
          CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
        ],
      },
      progress,
    );
  }

  const canonical = normaliseClubTimeZone(stored);

  // 4. Something is stored that this runtime cannot use (`persisted-unusable`).
  if (canonical === null) {
    // What the app answers meanwhile: the same precedence the canonical reader
    // uses, reached through the same resolver, so readiness cannot describe a
    // different zone from the one in force.
    const fallback = resolveClubTimeZone(
      null,
      seed.kind === "absent" ? null : seed.raw,
    );
    return applyProgress(
      {
        ...base,
        status: "blocked",
        message: `The stored club timezone is not a timezone this app can use, so it is falling back to ${fallback}. Set the club's timezone again.`,
        details: [
          "Source: database (ClubTimeSettings)",
          `Stored value: "${printableTimeZoneValue(stored)}" — not a named IANA timezone such as Pacific/Auckland. Abbreviations (NZT, EST) and fixed offsets (+12:00, Etc/GMT-12) are refused because they carry no daylight-saving rules.`,
          `Until it is fixed the app answers with ${fallback}. ${describeReaderFallback(seed)}`,
          CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
        ],
      },
      progress,
    );
  }

  // 7. The documented default is stored and the environment STILL names no
  //    place, so this may be the zone the boot backfill invented rather than one
  //    anybody chose. It cannot be told apart from a deliberate choice, so the
  //    wording asks instead of asserting. See the docblock.
  if (canonical === CLUB_TIME_ZONE_FALLBACK && seed.kind === "unusable") {
    const raw = printableTimeZoneValue(seed.raw);
    return applyProgress(
      {
        ...base,
        status: "warning",
        message: `The club's timezone is ${canonical}, but nothing has confirmed it: TZ / NEXT_PUBLIC_TZ is "${raw}", which is not a place, so ${canonical} is what the app records by default. Confirm it, or set the club's timezone at /admin/club-time.`,
        details: [
          "Source: database (ClubTimeSettings)",
          `Club timezone: ${canonical}`,
          `The TZ / NEXT_PUBLIC_TZ value in the environment is "${raw}". UTC, GMT and fixed offsets such as Etc/GMT-12 name no place, so nothing in this deployment's configuration says which timezone the club is actually in — ${canonical} is the built-in New Zealand default, recorded so setup could finish rather than because anything confirmed it.`,
          `If the club is in ${canonical}, press Acknowledge on this step. If it is not, set the club's timezone at /admin/club-time: it decides which day a lodge night falls on and what time members see, and once CT-2 lands it drives every time this site displays.`,
          CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
        ],
      },
      progress,
    );
  }

  // 3. Configured.
  return applyProgress(
    {
      ...base,
      status: "complete",
      message: `The club's timezone is ${canonical}.`,
      details: [
        "Source: database (ClubTimeSettings)",
        `Club timezone: ${canonical}`,
        ...(canonical === stored
          ? []
          : [
              `Stored as "${stored}", which this runtime knows as ${canonical} — the same place, the current spelling.`,
            ]),
        CLUB_VERSUS_SERVER_TIME_ZONE_DETAIL,
      ],
    },
    progress,
  );
}

/**
 * Plain-English state of the deployment declaration, for the readiness details.
 *
 * The raw value in the `invalid` case has ALREADY been stripped of control
 * characters and capped by `sanitizeEnvironmentRoleRawValue`, which is why it can
 * be quoted straight into a line that ends up in an operator's terminal.
 */
function describeEnvironmentRoleDeclaration(
  declaration: EnvironmentRoleDeclaration,
): string {
  switch (declaration.kind) {
    case "production":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE=production.";
    case "non-production":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE=non-production.";
    case "invalid":
      return `Deployment declaration: APP_ENVIRONMENT_ROLE is set to "${declaration.raw}", which is not one of the two accepted values (production, non-production), so it is refused rather than guessed at.`;
    case "absent":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE is not set.";
  }
}

/** Plain-English state of the database safer override. */
function describeEnvironmentRoleOverride(
  resolution: EnvironmentRoleResolution,
): string {
  switch (resolution.databaseOverride.kind) {
    case "force-non-production":
      return "Safer override: ON — an administrator has forced this installation to behave as non-production. It can be switched off at /admin/environment, which hands the decision back to the deployment declaration and never makes an installation production on its own.";
    case "none":
      return "Safer override: off — nothing in the database is forcing this installation to be treated as non-production.";
    case "unreadable":
      return "Safer override: could not be read. The EnvironmentSafetySettings table is most likely missing because the migration has not been applied on this database yet — run prisma migrate deploy (or npm run db:migrate in development), then check again.";
  }
}

/**
 * The withheld-email line, which is the ONLY signal that separates a live club
 * that is not sending from a copy nobody is using (ENV-SAFETY 1, #3034).
 *
 * Rendered for NON_PRODUCTION **and** UNKNOWN, because both hold delivery back —
 * UNKNOWN is the fail-closed state, and it is the one a live installation reaches
 * by upgrading without adding the declaration. Not rendered for PRODUCTION, where
 * nothing is held back for this reason and the line would be noise.
 *
 * The reasoning, and why a database-content heuristic cannot do this job, is in
 * `environment-safety-withheld.ts`. What matters here is that the three states
 * read differently, because two of them look identical on a checklist and mean
 * opposite things: "nothing has been held back" says nobody is using this
 * installation, while "the count could not be read" says nobody knows.
 *
 * NO SENTENCE HERE MAY NAME ONE STATE'S REASON, because this line renders under
 * two. Telling the operator of an UNDECLARED live site that mail is held back
 * "because it is treated as a copy" sends them hunting for the safer override
 * instead of the missing declaration (#3035). The step's own message already
 * says which state applies; this line says only how much, and how lately.
 */
function describeWithheldEmail(
  withheldEmail: WithheldApplicationEmail | undefined,
): string {
  if (!withheldEmail || !withheldEmail.available) {
    return "Held back email: the count could not be read on this installation. That is NOT the same as none — one says nothing has been held back, the other says nobody knows — so this line cannot tell you whether this installation is quietly holding back mail the club's members are waiting for. Apply any pending migrations, then check again.";
  }
  if (withheldEmail.count === 0) {
    return "Held back email: none. Nothing has been held back on this installation for environment-safety reasons, which is what an installation nobody is using looks like.";
  }
  const mostRecent = withheldEmail.mostRecentAt
    ? ` The most recent was ${withheldEmail.mostRecentAt}.`
    : "";
  return `Held back email: ${withheldEmail.count} message(s) have been held back on this installation for environment-safety reasons.${mostRecent} A steady and recent count is what a LIVE club looks like when it has been wrongly declared a copy, or left undeclared — if members are waiting for that mail, the answer above is wrong.`;
}

/**
 * The line that stops an operator repairing the WRONG variable.
 *
 * `APP_RUNTIME_ROLE` already exists in the same Compose environment block, and on
 * the staging stack it holds the literal word "staging". Two variables whose
 * names differ by one word, one of which looks like it answers this question and
 * does not, is a mistake worth naming rather than hoping about.
 */
const ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL =
  "This is APP_ENVIRONMENT_ROLE, not APP_RUNTIME_ROLE. APP_RUNTIME_ROLE names which container slot this is (web-blue, web-green, cron-leader, staging) and is never read to decide whether this installation is production — setting it to production changes nothing here.";

/**
 * Environment-role gate (ENV-SAFETY 1, #3034; epic #2986). INV-CONFIG-003.
 *
 * WHY THIS IS A BLOCK AND NOT A WARNING when nothing has declared the
 * installation. An UNKNOWN role is the state in which #3035 and #3036 refuse to
 * send email and refuse to write to Xero, because neither can tell whether the
 * recipients are the club's real members. So an operator meeting UNKNOWN is
 * looking at a site that is not doing its job, and a warning would be the wrong
 * volume for that. It is also entirely fixable in one line of deployment
 * configuration, which is what the details say.
 *
 * THE STATES:
 * 1. **No snapshot** — `setup:check` ran with no database access. "Not checked",
 *    the same as its DB-backed siblings. It deliberately does not answer from the
 *    environment alone: the safer override is half of the answer, and reporting
 *    "production" from a declaration whose override could not be read is exactly
 *    the confident-wrong answer the resolver itself refuses to give.
 * 2. **The snapshot predates this field** — an older caller. Also "not checked",
 *    for the same reason.
 * 3. **PRODUCTION** — complete, and the message SAYS production, because an
 *    operator who has just stood up a copy needs to see at a glance that they
 *    are looking at the live club and not at their copy.
 * 4. **NON_PRODUCTION** — complete, naming which source decided it. A declared
 *    non-production and an administrator-forced one are both fine and are
 *    different facts, so the message distinguishes them.
 * 5. **UNKNOWN** — blocked, naming both sources, the repair, and the
 *    APP_RUNTIME_ROLE trap. Two quite different situations land here — nothing
 *    declared, and a declaration this app refuses to interpret — so the
 *    declaration line says which.
 *
 * AN OPERATOR MAY ACKNOWLEDGE THIS STEP, exactly as they may acknowledge
 * `runtime-env`, and that changes the CHECKLIST and nothing else: `applyProgress`
 * moves `progress` to `completed` and never touches `status`. So a ticked box
 * cannot make an UNKNOWN installation start sending email — the resolver is the
 * only thing #3035 and #3036 read, and it has never heard of the checklist.
 *
 * Deliberately clock-free: nothing here formats a date, so the answer is the
 * same at every instant.
 */
function buildEnvironmentRoleCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const base = {
    id: "environment-role" as const,
    title: "Production Or Non-Production",
    description:
      "Whether this installation is the club's live site or a copy — which decides whether real members can be emailed.",
    required: true,
    href: "/admin/environment",
  };

  // 1 / 2. Nothing to report on.
  if (!db || !db.environmentRole) {
    return applyProgress(
      {
        ...base,
        status: "warning",
        message: "Database state was not checked.",
        details: [
          "Run setup:check again inside an environment with database access, or review /admin/setup after login.",
          "Half of this answer is a database setting (the safer override), so it cannot be reported from the deployment environment alone.",
          ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL,
        ],
      },
      progress,
    );
  }

  const resolution = db.environmentRole;
  const sources = [
    describeEnvironmentRoleDeclaration(resolution.declaration),
    describeEnvironmentRoleOverride(resolution),
  ];

  // 3. Confirmed production.
  if (resolution.role === "PRODUCTION") {
    /*
      THE ONE WAY A LIVE SITE HOLDS MAIL BACK, and it used to be invisible here
      (#3035 review). A live club that declares `USE_LOCAL_CAPTURE=true` is in a
      total mail outage: every message lands `FAILED` carrying
      `CAPTURE_TRANSPORT_IN_PRODUCTION`, and this step reported "complete —
      emails go to real members" with no withheld line at all, because the line
      was rendered only under NON_PRODUCTION and UNKNOWN.

      Keyed on the capture-in-production count specifically, not on the total:
      `SKIPPED_NON_PRODUCTION` rows are terminal, so an installation that spent an
      afternoon as a forced copy carries them for ever and a permanent banner on a
      healthy live site is a line operators learn to scroll past. This number can
      only be non-zero while the transport flags are wrong.
    */
    const captureInProduction =
      db.withheldEmail?.available === true
        ? db.withheldEmail.captureInProduction
        : 0;
    if (captureInProduction > 0) {
      return applyProgress(
        {
          ...base,
          status: "warning",
          message:
            "This installation is declared PRODUCTION — the club's live site — but it ALSO declares a local capture mailbox, so it is sending no member email at all.",
          details: [
            `Held back email: ${captureInProduction} message(s) were refused because this deployment says it is the club's live site AND that its mail goes to a capture mailbox that forwards nothing. Those cannot both be true, so nothing was sent rather than every message being silently swallowed.`,
            "Set USE_AWS_SES or USE_SMTP_RELAY and remove USE_LOCAL_CAPTURE (or set it to false). Messages whose contents are stored then go out by themselves; ones carrying a sign-in link, a door code or a payment link keep no stored copy and are listed for a manual re-send under Admin -> Email.",
            ...sources,
            ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL,
          ],
        },
        progress,
      );
    }
    return applyProgress(
      {
        ...base,
        status: "complete",
        message:
          "This installation is declared PRODUCTION — the club's live site. Emails go to real members and accounting goes to the club's real Xero organisation.",
        details: [...sources, ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL],
      },
      progress,
    );
  }

  // 4. Confirmed non-production.
  if (resolution.role === "NON_PRODUCTION") {
    return applyProgress(
      {
        ...base,
        status: "complete",
        message:
          resolution.decidedBy === "database-safer-override"
            ? "This installation is treated as NON-PRODUCTION because an administrator has switched the safer override on."
            : "This installation is declared NON-PRODUCTION — a copy, a staging site or a developer's checkout.",
        /*
          THE WITHHELD COUNT GOES FIRST. It answers the question an operator
          meeting an unexpected non-production installation actually has — "is
          this costing my members their mail?" — and it is the only signal that
          can answer it, because a copy restored from the live database is
          indistinguishable from the live site by its data (#3034).
        */
        details: [
          describeWithheldEmail(db.withheldEmail),
          ...sources,
          ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL,
        ],
      },
      progress,
    );
  }

  // 5. Nothing has said.
  return applyProgress(
    {
      ...base,
      status: "blocked",
      message:
        "Nothing says whether this installation is the club's live site or a copy, so it is treated as neither. Set APP_ENVIRONMENT_ROLE to production or non-production in this deployment's environment.",
      /*
        AND THE WITHHELD COUNT HERE TOO, which a third review lens was right to
        insist on. The first version rendered it only for NON_PRODUCTION,
        reasoning that "on a PRODUCTION or UNKNOWN installation nothing is being
        held back for this reason" — and this file's own next sentence contradicts
        that: UNKNOWN fails closed, so no email is sent to members and nothing is
        written to Xero. The boot advisory and the deploy script say the same.

        Which makes UNKNOWN the case the count matters MOST for: it is exactly the
        live installation that upgraded without adding the declaration, the
        scenario this whole issue exists to prevent. That operator needs to see
        "312 held back, most recently four minutes ago" rather than have it
        withheld from them on a premise the rest of the code denies.
      */
      details: [
        describeWithheldEmail(db.withheldEmail),
        ...sources,
        "Until it is declared, anything whose safety depends on knowing which installation this is does not run: no email is sent to members and nothing is written to the club's Xero organisation. That is deliberate — a copy of the live database holds real members' real email addresses, and guessing wrong emails them.",
        "It is NOT assumed to be production, and it is NOT assumed to be a copy either. Both would be a guess, and one of them is a guess that contacts the club's members from a test system.",
        "Set APP_ENVIRONMENT_ROLE=production in the .env of the club's live deployment, or APP_ENVIRONMENT_ROLE=non-production on a copy, then restart. A production deploy through scripts/run-production-blue-green-deploy.sh refuses to start without it (step 3 of 20), so a live site cannot reach this state through that path.",
        ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL,
      ],
    },
    progress,
  );
}

function buildRuntimeEnvCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const missing: string[] = REQUIRED_RUNTIME_ENV.filter(
    (name) => !hasEnv(env, name),
  );
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
      description:
        "Database, auth, app origin, cron, and seed-admin environment contract.",
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

/**
 * Passive amber warning (#2079) on a weak/placeholder auth secret. NEVER blocks
 * and NEVER runs at boot — it only surfaces in readiness so operators learn
 * before they are mid-wizard that the secret credential encryption (and sign-in
 * and 2FA) depends on is weak. The hard block lives at credential capture, not
 * here. When AUTH_SECRET/NEXTAUTH_SECRET is entirely absent the runtime-env
 * check already blocks, so this stays "complete" in that case to avoid a
 * duplicate finding.
 */
function buildAuthSecretStrengthCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const secret = readEnv(env, "AUTH_SECRET") ?? readEnv(env, "NEXTAUTH_SECRET");
  const weakness = secret ? authSecretWeaknessReason(secret) : null;

  return applyProgress(
    {
      id: "auth-secret-strength",
      title: "Auth Secret Strength",
      description:
        "Sign-in, 2FA and credential encryption all derive from this secret.",
      status: weakness ? "warning" : "complete",
      required: false,
      message: weakness
        ? "The app auth secret is weak or a placeholder — credential capture will be blocked until it is strengthened."
        : "The app auth secret meets the strength requirement.",
      details: weakness
        ? [
            weakness,
            "Generate a strong value, e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\", then restart.",
          ]
        : ["Secret is set and passes the length and placeholder checks."],
      href: "/admin/health",
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
        description:
          "Seeded administrator account used to access setup and admin tools.",
        status: "warning",
        required: true,
        message: "Database state was not checked.",
        details: [
          "Run setup:check again inside an environment with database access, or review /admin/setup after login.",
        ],
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
      description:
        "Seeded administrator account used to access setup and admin tools.",
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
  db: SetupDatabaseSnapshot | undefined,
  moduleKey: AdminModuleKey,
) {
  const adminActivation =
    db?.adminModuleSettings === undefined
      ? DEFAULT_ADMIN_MODULE_SETTINGS
      : normalizeAdminModuleSettings(db.adminModuleSettings);

  return {
    adminChecked: Boolean(db && db.adminModuleSettings),
    adminEnabled: adminActivation[moduleKey],
    effectiveEnabled: adminActivation[moduleKey],
  };
}

function formatModuleActivationDetail(
  db: SetupDatabaseSnapshot | undefined,
  enabled: boolean,
) {
  if (!db) return "Admin Modules activation: not checked";
  if (!db.adminModuleSettings) {
    return "Admin Modules activation: first-install defaults until settings are saved";
  }
  return `Admin Modules activation: ${enabled ? "enabled" : "disabled"}`;
}

function buildFeatureFlagCheck(
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const adminDetails = MODULE_CONTROLS.map((module) => {
    const layer = buildModuleLayerState(db, module.key);
    return `${module.label} ${formatModuleActivationDetail(db, layer.adminEnabled)}`;
  });
  const adminChecked = Boolean(db && db.adminModuleSettings);

  return applyProgress(
    {
      id: "feature-flags",
      title: "Module Controls",
      description:
        "Admin Modules club activation for optional modules.",
      status: adminChecked ? "complete" : "warning",
      required: false,
      message: adminChecked
        ? "Admin Modules activation was checked."
        : "Review optional module activation on the admin Modules page.",
      details: adminDetails,
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
        description:
          "Non-member hold, cancellation rules, minimum stays, and group discount.",
        status: "warning",
        required: true,
        message: "Database booking policies were not checked.",
        details: [
          "Review this in /admin/setup after migrations and seed data have run.",
        ],
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
      description:
        "Non-member hold, cancellation rules, minimum stays, and group discount.",
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
        description:
          "Warning text, rejoin process text, and Xero cancellation handling.",
        status: "warning",
        required: false,
        message: "Membership cancellation settings were not checked.",
        details: [
          "Review this in /admin/setup/cancellation after migrations have run.",
        ],
        href: "/admin/setup/cancellation",
      },
      progress,
    );
  }

  return applyProgress(
    {
      id: "membership-cancellation",
      title: "Membership Cancellation",
      description:
        "Warning text, rejoin process text, and Xero cancellation handling.",
      status: db.membershipCancellationSettingsConfigured
        ? "complete"
        : "warning",
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
      href: "/admin/setup/cancellation",
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
        description:
          "Age boundaries and whether each age tier needs a subscription (which gates both booking and annual-fee invoicing for membership types set to require a subscription based on age tier).",
        status: "warning",
        required: true,
        message: "Database age-tier settings were not checked.",
        details: [
          "The CLI validated config age tiers; seeded database settings are checked in /admin/setup.",
        ],
        href: "/admin/age-tier-settings",
      },
      progress,
    );
  }

  // The DB is the sole runtime source of age tiers (#1983), the readiness gate
  // is DB-first (#1987, C8), and the admin save route (#2009) guarantees any
  // persisted set is a complete, valid tiling of 0 → ∞ with ADULT as the
  // terminal tier — including a deliberate SUBSET (e.g. CHILD + ADULT). So
  // "configured" is simply "≥1 row exists": once the club has saved its tiers,
  // whatever count it chose is complete by construction, and we must NOT nag a
  // valid 2-tier club for having fewer rows than the 4-tier default. Pre-config
  // (no rows yet) the fixed slot count (INFANT/CHILD/YOUTH/ADULT —
  // NOT_APPLICABLE never gets a row) is the "expected" hint for the operator;
  // a primary config, when present, refines that hint for forks that seed a
  // non-default number of tiers.
  const actual = db?.ageTierSettingCount ?? 0;
  const configured = actual >= 1;
  const configExpected =
    club.config?.ageTiers.length ?? bookableAgeTierEnum.options.length;
  const expected = configured ? actual : configExpected;
  // #2041 misconfig: a membership type set to "required based on age tier"
  // while no configured tier requires a subscription can never invoice or lock
  // anyone. Soft warning (does not block setup) naming the offending types so an
  // operator can fix either a tier flag or the type behavior.
  const misconfiguredTypes = db?.basedOnAgeTierTypesWithoutSubscribingTier ?? [];
  const hasMisconfig = misconfiguredTypes.length > 0;
  const complete = configured && !hasMisconfig;
  return applyProgress(
    {
      id: "age-tiers",
      title: "Age And Membership Rules",
      description:
        "Age boundaries and whether each age tier needs a subscription (which gates both booking and annual-fee invoicing for membership types set to require a subscription based on age tier).",
      status: complete ? "complete" : "warning",
      required: true,
      message: !configured
        ? "Seed or review age-tier settings before member imports."
        : hasMisconfig
          ? `${misconfiguredTypes.join(", ")} require a subscription based on age tier, but no age tier requires one — no member of ${misconfiguredTypes.length === 1 ? "this type" : "these types"} would be invoiced or locked out.`
          : "Database age-tier settings are populated.",
      details: [
        `Expected age tiers: ${expected || "unknown"}`,
        `Database age-tier settings: ${actual}`,
        ...(hasMisconfig
          ? [
              `Age-tier subscription types with no subscribing tier: ${misconfiguredTypes.join(", ")}`,
            ]
          : []),
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
        description:
          "Season windows and member/non-member nightly rates in integer cents.",
        status: "warning",
        required: true,
        message: "Database seasons and rates were not checked.",
        details: [
          "Run seed data or configure seasons from /admin/seasons after login.",
        ],
        href: "/admin/seasons",
      },
      progress,
    );
  }

  const seasonCount = db?.seasonCount ?? 0;
  const rateGaps = db?.membershipTypeRateGaps ?? [];
  const hasGaps = rateGaps.length > 0;
  const singleColumnSeasons = db?.publicHutFeeSingleColumnSeasons ?? [];
  const hasSingleColumnSeasons = singleColumnSeasons.length > 0;
  const status: SetupStatus =
    seasonCount === 0
      ? "blocked"
      : hasGaps || hasSingleColumnSeasons
        ? "warning"
        : "complete";
  const MAX_LISTED_GAPS = 8;
  const gapDetails = hasGaps
    ? [
        `Membership types missing hut rates for an active or future season: ${rateGaps.length}`,
        ...rateGaps
          .slice(0, MAX_LISTED_GAPS)
          .map((gap) => `Missing rates: ${gap}`),
        ...(rateGaps.length > MAX_LISTED_GAPS
          ? [`…and ${rateGaps.length - MAX_LISTED_GAPS} more`]
          : []),
      ]
    : [];
  // #2129: the public {{hut-fees}} embed shows one column per publicly-listed
  // membership type that carries rates. Fewer than two columns means the
  // published table collapses to a single rate with nothing to compare against.
  const embedDetails = hasSingleColumnSeasons
    ? [
        `Public hut-fee seasons showing fewer than two rate columns: ${singleColumnSeasons.length}`,
        ...singleColumnSeasons
          .slice(0, MAX_LISTED_GAPS)
          .map((season) => `Single-column public rate table: ${season}`),
        ...(singleColumnSeasons.length > MAX_LISTED_GAPS
          ? [`…and ${singleColumnSeasons.length - MAX_LISTED_GAPS} more`]
          : []),
        "Flag more membership types as publicly listed under Admin > Membership Types, or add their season rates, so the published table compares at least two rates.",
      ]
    : [];
  return applyProgress(
    {
      id: "seasons-rates",
      title: "Seasons And Rates",
      description:
        "Season windows and per-membership-type nightly rates in integer cents.",
      status,
      required: true,
      message:
        seasonCount === 0
          ? "At least one active season with rates is needed before bookings can price correctly."
          : hasGaps
            ? "Some membership types have no hut rates for an active or future season; bookings for them will fail at pricing until rates are set."
            : hasSingleColumnSeasons
              // "Fewer than two", not "only one": the gate is `< 2`, and the
              // likelier misconfiguration is ZERO publicly-listed priced types
              // (the operator never ticked publiclyListed), which the old
              // wording told the operator was one.
              ? "The public hut-fees page block would show fewer than two nightly-rate columns for some seasons; publish at least two membership types' rates so visitors can compare them."
              : `${seasonCount} season${seasonCount === 1 ? "" : "s"} configured.`,
      details: [`Configured seasons: ${seasonCount}`, ...gapDetails, ...embedDetails],
      href: "/admin/seasons",
    },
    progress,
  );
}

/**
 * Stripe readiness, DB-only (#2082). Credentials are captured in-app (encrypted
 * store) — no STRIPE_* env vars are read for operation. Any legacy Stripe env
 * vars still present are detected and warned about. Precedence of the resulting
 * status: not-checked → legacy-env/needs-reentry warnings → missing secret or
 * publishable key blocks (payments can't run) → missing webhook secret warns
 * (payments run but won't auto-reconcile) → complete.
 */
function buildStripeCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const base = {
    id: "stripe" as const,
    title: "Stripe",
    description:
      "Card payments, saved payment methods, refunds, and webhooks.",
    required: true,
    // Land on the wizard where credentials are actually captured (#2082).
    href: "/admin/stripe/setup",
    action: {
      type: "provider-test" as const,
      provider: "stripe" as const,
      label: "Test Stripe",
    },
  };

  const legacyStripeVars =
    detectLegacyProviderEnv(env).find((f) => f.provider === "stripe")?.vars ??
    [];
  const legacyDetails =
    legacyStripeVars.length > 0
      ? [
          `Legacy env vars detected (no longer used): ${legacyStripeVars.join(", ")}. Re-enter these in-app, then remove them from the environment.`,
        ]
      : [];

  if (!db) {
    return applyProgress(
      {
        ...base,
        status: "warning",
        message:
          "Stripe credentials are captured in-app; the stored state was not checked.",
        details: [
          "Credentials are stored in-app (encrypted); no STRIPE_* env vars are used.",
          ...legacyDetails,
          "Database state was not checked.",
        ],
      },
      progress,
    );
  }

  const secretSet = Boolean(db.stripeSecretKeySet);
  const publishableSet = Boolean(db.stripePublishableKeySet);
  const webhookSet = Boolean(db.stripeWebhookSecretSet);
  const needsReentry = Boolean(db.stripeNeedsReentry);
  const keysConfigured = secretSet && publishableSet;

  const status: SetupStatus = needsReentry
    ? "warning"
    : !keysConfigured
      ? "blocked"
      : legacyStripeVars.length > 0 || !webhookSet
        ? "warning"
        : "complete";

  const message = needsReentry
    ? "Stored Stripe keys can no longer be read (the auth secret changed) — re-enter them in the in-app setup (Admin > Integrations > Stripe)."
    : !keysConfigured
      ? "Enter your Stripe secret and publishable keys in the in-app setup (Admin > Integrations > Stripe)."
      : legacyStripeVars.length > 0
        ? "Remove the legacy STRIPE_* env vars — Stripe is configured in-app now."
        : !webhookSet
          ? "Stripe keys are set; add the webhook signing secret so payments reconcile automatically."
          : "Stripe is configured in-app.";

  return applyProgress(
    {
      ...base,
      status,
      message,
      details: [
        "Credentials are stored in-app (encrypted); no STRIPE_* env vars are used.",
        `Secret key: ${secretSet ? "set" : "not set"}`,
        `Publishable key: ${publishableSet ? "set" : "not set"}`,
        `Webhook signing secret: ${webhookSet ? "set" : "not set"}`,
        ...(needsReentry
          ? ["A stored Stripe key no longer decrypts; re-enter to restore payments."]
          : []),
        ...legacyDetails,
      ],
    },
    progress,
  );
}

function buildEmailCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const emailDelivery = resolveEmailDeliveryConfigFromEnv(env);
  const issues = [...emailDelivery.issues];
  const details = [
    `Selected delivery mode: ${emailDelivery.modeLabel}`,
    ...emailDelivery.warnings.map((warning) => `Warning: ${warning}`),
  ];

  if (!hasEnv(env, "EMAIL_FROM")) {
    issues.push("EMAIL_FROM is missing");
  }

  if (emailDelivery.mode === "aws-ses" && !hasEnv(env, "SES_SNS_TOPIC_ARN")) {
    issues.push("SES_SNS_TOPIC_ARN is missing for deployed SES feedback");
  }

  if (issues.length === 0) {
    details.push("Secrets are set; values are not displayed.");
  }

  return applyProgress(
    {
      id: "email-ses",
      title: "Email Delivery",
      description:
        "Email sending via AWS SES or SMTP relay, plus optional SES SNS feedback.",
      status: issues.length === 0 ? "complete" : "blocked",
      required: true,
      message:
        issues.length === 0
          ? `Email delivery is configured (${emailDelivery.modeLabel}).`
          : `Email delivery setup needs attention (${emailDelivery.modeLabel}).`,
      details: issues.length === 0 ? details : [...details, ...issues],
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

function buildSentryCheck(
  env: Env,
  progress: SetupProgressState,
): SetupStepCheck {
  const missing = [
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ].filter((name) => !hasEnv(env, name));

  return applyProgress(
    {
      id: "sentry",
      title: "Sentry",
      description:
        "Server, edge, browser error reporting, and source-map configuration.",
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
  const moduleState = buildModuleLayerState(db, "xeroIntegration");
  const enabled = moduleState.effectiveEnabled;
  const connected = Boolean(db?.operationalXeroConnected);
  // Tokens exist but no longer decrypt (env→DB upgrade / auth-secret change,
  // #2079): reconnect-required, not "connected" and not "never connected".
  const needsReentry = Boolean(db?.operationalXeroNeedsReentry);
  // DB-only credentials (#2079): Xero client id/secret, webhook key and the
  // token key live in the encrypted store and are captured in-app — no XERO_*
  // env vars are read for operation. Any legacy vars still present are flagged.
  const legacyXeroVars =
    detectLegacyProviderEnv(env).find((f) => f.provider === "xero")?.vars ?? [];
  const legacyDetails =
    legacyXeroVars.length > 0
      ? [
          `Legacy env vars detected (no longer used): ${legacyXeroVars.join(", ")}. Re-enter these in-app, then remove them from the environment.`,
        ]
      : [];

  return applyProgress(
    {
      id: "xero-operational",
      title: "Operational Xero",
      description:
        "Member/contact sync, invoices, payments, credit notes, and Xero webhooks.",
      status: !enabled
        ? "warning"
        : !db
          ? "warning"
          : needsReentry
            ? "warning"
            : legacyXeroVars.length > 0
              ? "warning"
              : connected
                ? "complete"
                : "not_started",
      required: enabled,
      message: !enabled
        ? "Operational Xero is disabled in Admin Modules."
        : !db
          ? "Operational Xero credentials are captured in-app; connection state was not checked."
          : needsReentry
            ? "Xero tokens can no longer be read (the auth secret changed) — reconnect Xero from the in-app setup (Admin > Xero > Setup)."
            : legacyXeroVars.length > 0
              ? "Remove the legacy XERO_* env vars — Xero is configured in-app now."
              : connected
                ? "Operational Xero is connected."
                : "Connect Xero from the in-app setup (Admin > Xero > Setup).",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        "Credentials are stored in-app (encrypted); no XERO_* env vars are used.",
        ...legacyDetails,
        !db
          ? "Database connection state not checked."
          : needsReentry
            ? "Stored Xero tokens no longer decrypt; reconnect to re-authorise."
            : connected
              ? `Token expires: ${db?.operationalXeroTokenExpiresAt ?? "unknown"}`
              : "No active operational Xero token found.",
      ],
      // Land on the page where credentials can actually be entered (#2079); the
      // Integrations hub also links here.
      href: "/admin/xero/setup",
      action: {
        type: "provider-test",
        provider: "xero",
        label: "Check Xero",
      },
    },
    progress,
  );
}

function buildAddressAutocompleteCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(db, "addressAutocomplete");
  const enabled = moduleState.effectiveEnabled;
  const missing = [
    !hasEnv(env, "ADDY_API_KEY") ? "ADDY_API_KEY is missing" : null,
    !hasEnv(env, "ADDY_API_SECRET") ? "ADDY_API_SECRET is missing" : null,
  ].filter((issue): issue is string => Boolean(issue));

  return applyProgress(
    {
      id: "address-autocomplete",
      title: "Address Autocomplete",
      description:
        "Optional Addy suggestions for address fields; manual entry remains available.",
      status: !enabled
        ? "warning"
        : missing.length > 0
          ? "blocked"
          : "complete",
      required: enabled,
      message: !enabled
        ? "Address autocomplete is disabled in Admin Modules; manual address entry remains available."
        : missing.length > 0
          ? "Address autocomplete is enabled but Addy credentials are missing."
          : "Address autocomplete is enabled and Addy credentials are configured.",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        ...(enabled ? missing : []),
        !enabled
          ? "ADDY_API_KEY and ADDY_API_SECRET are not required while the module is disabled."
          : missing.length === 0
            ? "Addy credentials are set; values are not displayed."
            : "Address forms can still be completed manually.",
      ],
      href: "/admin/modules",
    },
    progress,
  );
}

function buildFinanceDashboardCheck(
  env: Env,
  db: SetupDatabaseSnapshot | undefined,
  progress: SetupProgressState,
): SetupStepCheck {
  const moduleState = buildModuleLayerState(db, "financeDashboard");
  const enabled = moduleState.effectiveEnabled;
  const operationalConnected = Boolean(db?.operationalXeroConnected);

  return applyProgress(
    {
      id: "finance-dashboard",
      title: "Finance dashboard",
      description:
        "Finance reporting dashboards backed by the shared operational Xero connection.",
      status: !enabled
        ? "warning"
        : !db
          ? "warning"
          : operationalConnected
            ? "complete"
            : "not_started",
      required: enabled,
      message: !enabled
        ? "Finance dashboard is disabled in Admin Modules."
        : !db
          ? "Finance dashboard is enabled; Xero connection state was not checked."
          : operationalConnected
            ? "Finance dashboard is ready and the shared Xero connection is active."
            : "Finance dashboard is enabled; connect Xero from the admin Xero page so finance sync can run.",
      details: [
        formatModuleActivationDetail(db, moduleState.adminEnabled),
        `Effective state: ${enabled ? "enabled" : "disabled"}`,
        `Finance reporting reads from the shared operational Xero connection (requires ${XERO_REQUIRED_REPORT_OAUTH_SCOPES.join(", ")}).`,
        !db
          ? "Database connection state not checked."
          : operationalConnected
            ? "Operational Xero is connected; run a finance sync to load reporting data."
            : "No active Xero token found. Connect Xero from the admin Xero page.",
      ],
      href: "/finance",
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
        description:
          "Chart of accounts, hut fee item codes, and joining-fee categories.",
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
  const complete =
    accountMappings > 0 && hutFeeMappings > 0 && entranceFeeMappings > 0;

  return applyProgress(
    {
      id: "xero-mappings",
      title: "Xero Mappings",
      description:
        "Chart of accounts, hut fee item codes, and joining-fee categories.",
      status: complete ? "complete" : "warning",
      required: false,
      message: complete
        ? "Xero account and item mappings are configured."
        : "Map Xero accounts and item codes before using live Xero sync.",
      details: [
        `Account mappings: ${accountMappings}`,
        `Hut fee item mappings: ${hutFeeMappings}`,
        `Joining fee mappings: ${entranceFeeMappings}`,
      ],
      href: "/admin/xero#xero-section-mappings",
    },
    progress,
  );
}

export function buildSetupReadiness(
  input: {
    env?: Env;
    configDir?: string;
    database?: SetupDatabaseSnapshot;
    progress?: Partial<SetupProgressState> | null;
    now?: Date;
  } = {},
): SetupReadiness {
  const env = input.env ?? process.env;
  const configDir = input.configDir ?? path.join(process.cwd(), "config");
  const progress = normalizeSetupProgress(input.progress);
  const club = readClubConfig(configDir);

  const checksByCategory: Record<SetupCategoryId, SetupStepCheck[]> = {
    foundation: [
      buildClubConfigCheck(club, input.database, progress),
      buildClubTimeZoneCheck(input.database, progress),
      buildEnvironmentRoleCheck(input.database, progress),
      buildRuntimeEnvCheck(env, progress),
      buildAuthSecretStrengthCheck(env, progress),
      buildSeedAdminCheck(input.database, progress),
      buildFeatureFlagCheck(input.database, progress),
    ],
    booking: [
      buildBookingPolicyCheck(input.database, progress),
      buildMembershipCancellationCheck(input.database, progress),
      buildAgeTierCheck(club, input.database, progress),
      buildSeasonRateCheck(input.database, progress),
    ],
    integrations: [
      buildStripeCheck(env, input.database, progress),
      buildEmailCheck(env, progress),
      buildSentryCheck(env, progress),
      buildAddressAutocompleteCheck(env, input.database, progress),
      buildOperationalXeroCheck(env, input.database, progress),
    ],
    finance: [
      buildFinanceDashboardCheck(env, input.database, progress),
      buildXeroMappingCheck(input.database, progress),
    ],
  };

  const categories = CATEGORY_ORDER.map((id) => {
    const checks = checksByCategory[id];
    return {
      id,
      ...CATEGORY_META[id],
      status: worstStatus(unresolvedStatuses(checks)),
      checks,
    };
  });
  const allChecks = categories.flatMap((category) => category.checks);
  const skipped = allChecks.filter(
    (check) => check.progress === "skipped",
  ).length;
  const complete = allChecks.filter(
    (check) => check.status === "complete" || check.progress === "completed",
  ).length;
  const unresolved = allChecks.filter((check) => !isResolvedByProgress(check));
  const warning = unresolved.filter(
    (check) => check.status === "warning",
  ).length;
  const blocked = unresolved.filter(
    (check) => check.status === "blocked",
  ).length;

  return {
    status: worstStatus(unresolved.map((check) => check.status)),
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
      lines.push(
        `- ${check.title}: ${check.status}${progressLabel} - ${check.message}`,
      );
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
    // Stripe credentials (secret/publishable keys, webhook signing secret) are
    // captured in-app now (#2082) — they are no longer required env.
    "USE_AWS_SES",
    "USE_SMTP_RELAY",
    "SMTP_HOST",
    "SMTP_PORT",
    "AWS_SES_ACCESS_KEY_ID",
    "AWS_SES_SECRET_ACCESS_KEY",
    "EMAIL_SERVER_HOST",
    "EMAIL_SERVER_PORT",
    "EMAIL_SERVER_USER",
    "EMAIL_SERVER_PASSWORD",
    "SES_SNS_TOPIC_ARN",
    "EMAIL_FROM",
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    // Xero credentials (client id/secret, redirect, encryption key, webhook
    // key) are captured in-app now (#2079) — they are no longer required env.
  ];
}
