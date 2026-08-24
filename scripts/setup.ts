#!/usr/bin/env tsx
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { clubConfigSchema, type ClubConfig } from "../src/config/schema";
// Single canonical boot-safe default (epic #1943, child C1). Imported from the
// side-effect-free module so the setup CLI does not trigger club.ts's eager
// `clubConfig` singleton load. This is the same constant the runtime loader uses
// as its last-resort default — no duplicate default can drift out of sync.
import { SAFE_DEFAULT_CONFIG } from "../src/config/safe-default-config";
import type { AgeTier } from "@prisma/client";
import { normaliseClubTimeZone } from "../src/lib/club-time-zone";
import { prisma } from "../src/lib/prisma";
import {
  buildSetupReadiness,
  getSetupRequiredEnvNames,
  renderSetupCheckReport,
  type SetupDatabaseSnapshot,
} from "../src/lib/setup-readiness";
import { getSetupDatabaseSnapshot } from "../src/lib/setup-readiness-db";
import {
  applyWizardConfigToDatabase,
  MAX_LODGE_CAPACITY,
  readWizardConfigState,
  type WizardConfigState,
  type WizardConfigValues,
} from "../src/lib/setup-wizard-db";

type AgeTierConfig = ClubConfig["ageTiers"][number];

const CONFIG_DIR = path.join(process.cwd(), "config");
const CLUB_CONFIG_PATH = path.join(CONFIG_DIR, "club.json");
const EXAMPLE_CONFIG_PATH = path.join(CONFIG_DIR, "club.example.json");

const DEFAULT_CONFIG: ClubConfig = SAFE_DEFAULT_CONFIG;

function readJson(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadDefaultConfig(): ClubConfig {
  const candidates = [
    readJson(CLUB_CONFIG_PATH),
    readJson(EXAMPLE_CONFIG_PATH),
    DEFAULT_CONFIG,
  ];
  for (const candidate of candidates) {
    const parsed = clubConfigSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_CONFIG;
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askInt(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: number,
  options: { max?: number } = {},
) {
  const raw = await ask(rl, label, String(defaultValue));
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${label} must be no greater than ${options.max}`);
  }
  return value;
}

/**
 * Ask for the club's civil timezone and refuse anything that is not a usable
 * named IANA zone (CT-1, #2989).
 *
 * The club timezone is NOT the server's or container's timezone: it is where the
 * club is, and it decides which calendar day a lodge night falls on, so it has
 * to be a place whose daylight-saving rules the platform can read. Rejecting
 * rather than silently correcting mirrors the capacity prompt above, and matches
 * the Full-Admin maintenance surface — an answer this CLI accepts must be one
 * that surface would accept too.
 */
async function askTimeZone(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
) {
  const raw = await ask(rl, label, defaultValue);
  const timeZone = normaliseClubTimeZone(raw);
  if (!timeZone) {
    throw new Error(
      `${label} must be a named IANA timezone such as Pacific/Auckland, ` +
        `Australia/Sydney or America/Denver. Abbreviations (NZT, NZST, EST) and ` +
        `fixed offsets (+12:00, UTC+12, Etc/GMT-12) are not accepted: they name ` +
        `no place, so they carry no daylight-saving rules for future bookings.`,
    );
  }
  return timeZone;
}

async function askBoolean(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: boolean,
) {
  const raw = (
    await ask(rl, `${label} (y/n)`, defaultValue ? "y" : "n")
  ).toLowerCase();
  if (["y", "yes", "true"].includes(raw)) return true;
  if (["n", "no", "false"].includes(raw)) return false;
  throw new Error(`${label} must be answered y or n`);
}

function sortAgeTiers(tiers: AgeTierConfig[]) {
  const order = new Map([
    ["INFANT", 0],
    ["CHILD", 1],
    ["YOUTH", 2],
    ["ADULT", 3],
  ]);
  return [...tiers].sort((left, right) => {
    return (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99);
  });
}

// On the overwrite path, prefer the CURRENT DB age-tier values over the
// config-file defaults so an operator who keeps the defaults preserves prior
// admin edits (label / age boundaries / subscription rule). Cold install (no DB
// rows) keeps the config/SAFE_DEFAULT tiers unchanged. Rates and other fields
// the wizard never collects ride along from the config defaults.
function mergeAgeTierDefaults(
  configDefaults: AgeTierConfig[],
  dbTiers: WizardConfigState["current"]["ageTiers"],
): AgeTierConfig[] {
  if (dbTiers.length === 0) return configDefaults;
  const byTier = new Map(dbTiers.map((tier) => [String(tier.tier), tier]));
  return configDefaults.map((tier) => {
    const dbTier = byTier.get(tier.id);
    if (!dbTier) return tier;
    return {
      ...tier,
      label: dbTier.label || tier.label,
      minAge: dbTier.minAge,
      maxAge: dbTier.maxAge,
      subscriptionRequiredForBooking: dbTier.subscriptionRequiredForBooking,
    };
  });
}

// The wizard collects the AgeTierSetting-editable fields only — label, minimum
// age, and whether the tier needs a paid subscription to book. The four slots
// are fixed (INFANT/CHILD/YOUTH/ADULT). Per-tier nightly RATES are NOT collected
// here: they live in the seasons/rates tables and are set at /admin/seasons.
// Default nightly rates ride along unchanged purely so the collected config
// still validates against clubConfigSchema before it is mapped to DB writes.
async function collectAgeTiers(
  rl: ReturnType<typeof createInterface>,
  defaults: AgeTierConfig[],
) {
  const keepDefaults = await askBoolean(
    rl,
    "Use the existing four age tiers (labels, ages, subscription rules)",
    true,
  );
  if (keepDefaults) return sortAgeTiers(defaults);

  const tiers = sortAgeTiers(defaults);
  const result: AgeTierConfig[] = [];
  for (const tier of tiers) {
    const label = await ask(rl, `${tier.id} label`, tier.label);
    const minAge = await askInt(rl, `${tier.id} minimum age`, tier.minAge);
    const subscriptionRequiredForBooking = await askBoolean(
      rl,
      `${tier.id} requires paid subscription to book as member`,
      tier.subscriptionRequiredForBooking,
    );
    result.push({
      ...tier,
      label,
      minAge,
      maxAge: tier.maxAge,
      subscriptionRequiredForBooking,
    });
  }

  return result.map((tier, index) => ({
    ...tier,
    maxAge: result[index + 1] ? result[index + 1].minAge - 1 : null,
  }));
}

async function runWizard() {
  const defaults = loadDefaultConfig();
  const rl = createInterface({ input, output });

  try {
    console.log("AlpineClubBookingsNZ setup wizard");
    console.log(
      "This writes the club's configuration to the DATABASE (identity, timezone,\n" +
        "capacity, and age tiers). It writes no files and stores no secrets — set\n" +
        "secrets in environment variables and manage rates/seasons at /admin/setup.\n",
    );

    // Probe the DB first. A thrown error means it is unreachable or not yet
    // migrated (pre-deploy) — never write; guide the operator to /admin/setup.
    // Probing before the prompts lets the overwrite path pre-fill prompt
    // defaults from the CURRENT DB values, so an operator who accepts the
    // defaults preserves prior admin edits (W2c). A cold install leaves these
    // null and the prompts fall back to config/SAFE_DEFAULT values.
    let state: WizardConfigState;
    try {
      state = await readWizardConfigState();
    } catch {
      console.log(
        "\nCould not reach the database, so nothing was written.\n" +
          "The setup wizard now writes configuration to the database, not to a file.\n" +
          "Complete the deploy first:\n" +
          "- Set env values manually; do not commit secrets.\n" +
          "- Run npm run db:migrate && npm run db:seed.\n" +
          "- Then sign in as the seeded admin and finish setup at /admin/setup\n" +
          "  (or re-run npm run setup:wizard once the database is reachable).",
      );
      process.exitCode = 1;
      return;
    }
    const current = state.current;

    const name = await ask(rl, "Club name", current.name ?? defaults.name);
    const shortName = await ask(
      rl,
      "Short name",
      current.shortName ?? defaults.shortName ?? "",
    );
    // The club's civil timezone (CT-1, #2989) — the sole authority for what day
    // and time it is for booking purposes. The default offered is the zone this
    // deployment is ALREADY effectively using (persisted row, else TZ /
    // NEXT_PUBLIC_TZ, else Pacific/Auckland), so an operator who just presses
    // Enter changes nothing.
    const timeZone = await askTimeZone(
      rl,
      "Club timezone, an IANA name such as Pacific/Auckland (not the server's timezone)",
      current.timeZone,
    );
    const supportEmail = await ask(
      rl,
      "Support email",
      current.supportEmail ?? defaults.supportEmail,
    );
    const contactEmail = await ask(
      rl,
      "Bookings/contact email",
      current.contactEmail ?? defaults.contactEmail ?? defaults.supportEmail,
    );
    const publicUrl = (
      await ask(
        rl,
        "Public URL without trailing slash",
        current.publicUrl ?? defaults.publicUrl,
      )
    ).replace(/\/+$/, "");
    const emailFromName = await ask(
      rl,
      "Email sender display name",
      current.emailFromName ??
        (defaults.emailFromName || `${name} - Online Booking System`),
    );
    const capacity = await askInt(
      rl,
      "Total bunk/bed capacity",
      current.capacity ??
        defaults.beds.reduce((total, bed) => total + bed.capacity, 0),
      { max: MAX_LODGE_CAPACITY },
    );
    const ageTiers = await collectAgeTiers(
      rl,
      mergeAgeTierDefaults(defaults.ageTiers, current.ageTiers),
    );

    const nextConfig: ClubConfig = {
      ...defaults,
      name,
      shortName: shortName || undefined,
      supportEmail,
      contactEmail,
      publicUrl,
      emailFromName,
      beds: [
        {
          id: "lodge",
          name: defaults.beds[0]?.name ?? "Main Lodge",
          capacity,
          type: defaults.beds[0]?.type ?? "dormitory",
        },
      ],
      ageTiers,
    };

    const parsed = clubConfigSchema.safeParse(nextConfig);
    if (!parsed.success) {
      console.error("Nothing was written because validation failed:");
      for (const issue of parsed.error.issues) {
        console.error(`- ${issue.path.join(".") || "root"}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }

    // Map the validated config to the DB write shape. Nightly rates carried in
    // parsed.data.ageTiers are intentionally dropped — they are configured at
    // /admin/seasons, not stored on AgeTierSetting.
    const values: WizardConfigValues = {
      name: parsed.data.name,
      shortName: parsed.data.shortName ?? null,
      supportEmail: parsed.data.supportEmail,
      contactEmail: parsed.data.contactEmail ?? parsed.data.supportEmail,
      publicUrl: parsed.data.publicUrl,
      emailFromName: parsed.data.emailFromName,
      capacity: parsed.data.beds.reduce((total, bed) => total + bed.capacity, 0),
      // Already normalised and validated by askTimeZone; it is not part of
      // clubConfigSchema (the club timezone lives in the database, never in
      // config/club.json), so it is carried straight through.
      timeZone,
      ageTiers: parsed.data.ageTiers.map((tier, sortOrder) => ({
        tier: tier.id as AgeTier,
        minAge: tier.minAge,
        maxAge: tier.maxAge,
        label: tier.label,
        subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed:
          tier.familyGroupRequestCreateMemberAllowed,
        sortOrder,
      })),
    };

    // Never-overwrite guard, adapted for an interactive operator tool: an
    // already-configured DB is overwritten only after explicit confirmation.
    const alreadyConfigured =
      state.hasClubIdentity ||
      state.hasEmailSettings ||
      state.hasLodgeCapacity ||
      state.ageTierCount > 0;
    if (alreadyConfigured) {
      console.log(
        `\nThe database already holds club configuration${
          state.existingClubName ? ` for "${state.existingClubName}"` : ""
        }.`,
      );
      const overwrite = await askBoolean(
        rl,
        "Overwrite the existing club identity, timezone, email/contact settings, capacity, and age tiers with the values above",
        false,
      );
      if (!overwrite) {
        console.log("Left the existing configuration unchanged. Nothing was written.");
        return;
      }
    }

    // The DB was reachable at the probe above, but it can die between the probe
    // and this write. Guard the write so that failure surfaces a clear message
    // and a non-zero exit instead of an unhandled rejection (G1). The writes are
    // idempotent upserts, so the wizard is safe to re-run.
    try {
      await applyWizardConfigToDatabase(values);
    } catch {
      console.error(
        "\nConfiguration write failed; nothing may have been fully applied.\n" +
          "The wizard is safe to re-run once the database is reachable.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("\nWrote club configuration to the database.");

    const missingEnv = getSetupRequiredEnvNames().filter((name) => {
      if (name === "AUTH_SECRET or NEXTAUTH_SECRET") {
        return !process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET;
      }
      return !process.env[name];
    });
    if (missingEnv.length > 0) {
      console.log("\nStill missing or unset:");
      for (const name of missingEnv) {
        console.log(`- ${name}`);
      }
    }

    console.log("\nNext steps:");
    console.log("- Set env values manually; do not commit secrets.");
    console.log(
      "- Sign in as the seeded admin and open /admin/setup to review readiness,",
    );
    console.log(
      "  and set seasons and nightly rates at /admin/seasons and modules at /admin/modules.",
    );
  } finally {
    rl.close();
  }
}

async function runCheck() {
  // DB-first readiness (#1987, C8): attempt a database snapshot so the club
  // config, admin, booking, and integration steps reflect real DB state. When
  // the DB is unreachable (pre-migrate) the snapshot is omitted and those steps
  // report as "not checked" rather than failing the command.
  let database: SetupDatabaseSnapshot | undefined;
  try {
    database = await getSetupDatabaseSnapshot();
  } catch {
    console.log(
      "Note: the database was not reachable; DB-backed steps are reported as not checked.\n",
    );
  }
  const readiness = buildSetupReadiness({
    configDir: CONFIG_DIR,
    database,
  });
  console.log(renderSetupCheckReport(readiness));
  if (readiness.status === "blocked") {
    process.exitCode = 1;
  }
}

async function main() {
  const command = process.argv[2] ?? "check";
  try {
    if (command === "check") {
      await runCheck();
      return;
    }
    if (command === "wizard") {
      await runWizard();
      return;
    }

    console.error(`Unknown setup command: ${command}`);
    console.error("Usage: tsx scripts/setup.ts check|wizard");
    process.exitCode = 1;
  } finally {
    // Both commands may open a database connection; release it so the CLI exits.
    await prisma.$disconnect().catch(() => {});
  }
}

void main();
