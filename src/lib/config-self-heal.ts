import { Prisma, type PrismaClient } from "@prisma/client";
import { clubConfigSource, type ClubConfigSource } from "@/config/club";
import {
  ageTierSelfHealStepDefinition,
  clubFacebookUrlSelfHealStepDefinition,
  clubIdentitySelfHealStepDefinition,
  clubTimeZoneSelfHealStepDefinition,
  lodgeCapacitySelfHealStepDefinition,
} from "@/lib/config-self-heal-steps";
import logger from "@/lib/logger";

/**
 * Boot-time config self-heal (epic #1943, child C2).
 *
 * The problem: a routine production deploy runs `prisma migrate deploy` ONLY.
 * `prisma/seed.ts` does NOT run, and a SQL migration CANNOT read
 * `config/club.json` (see the identity migration's own comment,
 * `prisma/migrations/20260717160000_add_club_identity_settings/migration.sql`).
 * So the obvious "backfill the DB in the same migration/seed that removes a
 * file/env fallback" is mechanically impossible on a live upgrade.
 *
 * This module is the load-bearing safety net every epic-#1943 collapse child
 * (C3/C4/C5) depends on. On every process boot it copies each registered
 * setting's CURRENT EFFECTIVE config value into its DB row **iff that row is
 * still absent**, so when a later child drops its file/env fallback the DB is
 * already populated with the club's real value.
 *
 * Guarantees:
 * - **Create-if-absent only.** Every write mirrors the create-only upsert
 *   pattern (`prisma/seed.ts` `clubIdentitySettings.upsert(update:{})` and
 *   `src/lib/config-transfer/categories/club-settings.ts`). An admin's
 *   configured value (or an intentional null on an existing row) is NEVER
 *   overwritten.
 * - **Idempotent.** A second boot is a no-op once the row is present.
 * - **Blue/green-safe.** Safe when the blue AND green slots boot at once: a
 *   concurrent writer's unique-constraint conflict (Prisma P2002) is treated as
 *   already-present, not an error.
 * - **Best-effort.** `runConfigSelfHeal` never throws — a per-step failure is
 *   logged and the remaining steps still run. The boot integration
 *   (`src/instrumentation.node.ts`) additionally wraps the call so self-heal can
 *   never block or fail startup.
 * - **Fallback-guarded.** Every step that copies a `config/club.json` value runs
 *   ONLY when the effective config came from a valid primary `config/club.json`
 *   (`clubConfigSource === "primary"`). If the config resolved to the
 *   `club.example.json` identity or the hard-coded `SAFE_DEFAULT_CONFIG` (a
 *   missing / unreadable / malformed primary — a real path: the Docker runner
 *   image does not copy gitignored `config/`, fork provisioning can fail on one
 *   boot), every such step is skipped. Otherwise ONE bad boot would freeze
 *   `"Example Mountain Club"` / safe-default capacity + rates into the
 *   create-if-absent DB rows, which are then DB-first authoritative and never
 *   overwritten — the exact outage class epic #1943 exists to prevent. Healing
 *   self-repairs automatically on the next boot once a valid primary config is
 *   present. Every registered step inherits this guard automatically unless it
 *   declares `requiresPrimaryClubConfig: false`, which is reserved for a step
 *   whose value does NOT come from `config/club.json` at all: gating such a step
 *   on that file's provenance would protect nothing and would strand the
 *   backfill, because since #1987 an ABSENT `config/club.json` is normal for a
 *   DB-first install, so those installs would never be backfilled at all.
 *   `clubTimeZoneSelfHealStep` (CT-1, #2989) is the one such step today: its
 *   source is the ENVIRONMENT.
 *
 * ## Registering a new step (C3/C4/C5)
 * The step DEFINITIONS live in `config-self-heal-steps.ts`; this module holds the
 * contract, the registry and the runner. Add another typed
 * `ConfigSelfHealStep` there, erase it with `defineSelfHealStep` below, and add
 * it to `SELF_HEAL_STEPS`. A step describes exactly three things:
 *   - `isPresent(db)`  — is the DB value already populated? (guard the write)
 *   - `currentValue()` — the current EFFECTIVE config value to persist
 *   - `write(db, v)`   — a write that MUST NOT overwrite an existing value
 * plus, optionally, `requiresPrimaryClubConfig: false` — see the fallback guard
 * above. Default true. Set it false ONLY when the value being copied comes from
 * somewhere other than `config/club.json`, and say where in the step's docblock.
 *
 * ### Presence/write grain shapes — choose the one that matches the migration
 * A step's `isPresent`/`write` pair MUST agree on GRAIN, or a partial write can
 * wedge the target. Three shapes exist today; pick by what the enabling
 * migration added:
 *   1. **New TABLE / fixed-id singleton row → ROW-LEVEL.** `isPresent` checks
 *      whether the ROW exists (`findUnique` on a known id); `write` is a single
 *      create-if-absent upsert (`update: {}`) that never touches an existing
 *      row. One row, one write; nothing can be left half-written. Worked
 *      example: `clubIdentitySelfHealStep`.
 *   2. **New nullable COLUMN on an EXISTING singleton row → COLUMN-LEVEL.** A
 *      row-level check would wrongly skip every install whose row predates the
 *      new column (it would never backfill), so `isPresent` checks the COLUMN
 *      (is it non-null?). `write` is a create-if-absent row upsert (covers a
 *      brand-new install) THEN an atomic `updateMany` scoped to the null column
 *      (`where: { id, col: null }`), so it fills ONLY a still-null column and
 *      can never overwrite an admin-set value or a concurrent booter's write.
 *      Worked example: `clubFacebookUrlSelfHealStep` — copy that pattern (and
 *      read its long-form comment for why a null on a later-added column cannot
 *      be admin intent). If the target table stops being a singleton (e.g.
 *      LodgeSettings going per-lodge), drop the `id` predicate so the
 *      null-scoped `updateMany` backfills every null row, not just the default.
 *   3. **Whole-table-empty presence + ATOMIC multi-row write.** Presence is
 *      "the table is empty" (`findFirst`) but the write inserts SEVERAL rows.
 *      Worked example: `ageTierSelfHealStep`. The hazard is a grain mismatch:
 *      per-row writes under a table-grain presence check can wedge a PARTIAL
 *      set — a mid-write failure leaves e.g. INFANT+CHILD only, the next boot's
 *      `findFirst` sees rows and skips forever, and classification silently
 *      breaks. So the multi-row write MUST be all-or-nothing: wrap every row in
 *      a single `$transaction` so an interrupted heal rolls back to an empty
 *      table and the presence check retries cleanly on the next boot. Any
 *      future multi-row step MUST use this atomic shape.
 * In every shape the write must be incapable of overwriting an existing value so
 * the never-overwrite guarantee holds.
 */

/**
 * The subset of the Prisma client the self-heal steps touch. Aliased to the
 * full `PrismaClient` so real callers pass `prisma` directly; tests inject a
 * structural fake cast to this type.
 */
export type SelfHealDb = PrismaClient;

/** A typed self-heal step (see the module doc for the contract). */
export interface ConfigSelfHealStep<TValue> {
  /** Stable identifier used in logs and the run summary. */
  readonly name: string;
  /**
   * Whether this step's value comes from `config/club.json` and must therefore
   * be gated on a valid primary config (the fallback guard in the module doc).
   * Defaults to TRUE, so a step that says nothing is guarded — the safe answer,
   * and the reason all four epic-#1943 steps are byte-identical in behaviour to
   * before this option existed. Set it false ONLY for a step whose source is
   * something other than that file.
   */
  readonly requiresPrimaryClubConfig?: boolean;
  /** Resolves true when the DB row is already populated (skip the write). */
  isPresent(db: SelfHealDb): Promise<boolean>;
  /** The current EFFECTIVE config value to persist when the row is absent. */
  currentValue(): TValue;
  /** Create-if-absent write. MUST NOT overwrite an existing row. */
  write(db: SelfHealDb, value: TValue): Promise<void>;
}

/**
 * A type-erased step used by the registry and runner. `defineSelfHealStep`
 * binds `currentValue` + `write` into a single `heal` closure so the registry
 * can hold heterogeneously-typed steps in one array.
 */
export interface RegisteredSelfHealStep {
  readonly name: string;
  /**
   * See {@link ConfigSelfHealStep.requiresPrimaryClubConfig}. Optional here so a
   * hand-rolled step object (tests inject a couple) still satisfies the type;
   * ABSENT means guarded, exactly as `true` does — read it through
   * {@link stepRequiresPrimaryClubConfig}, never directly, so the two spellings
   * can never be treated differently.
   */
  readonly requiresPrimaryClubConfig?: boolean;
  isPresent(db: SelfHealDb): Promise<boolean>;
  heal(db: SelfHealDb): Promise<void>;
}

/** Erase a typed step's value into a `RegisteredSelfHealStep`. */
export function defineSelfHealStep<TValue>(
  step: ConfigSelfHealStep<TValue>,
): RegisteredSelfHealStep {
  return {
    name: step.name,
    // Default TRUE: a step that does not opt out is guarded by the primary-config
    // fallback guard, which is what keeps every pre-existing step unchanged.
    requiresPrimaryClubConfig: step.requiresPrimaryClubConfig ?? true,
    isPresent: (db) => step.isPresent(db),
    heal: (db) => step.write(db, step.currentValue()),
  };
}

/**
 * Whether the primary-`config/club.json` fallback guard applies to `step`. The
 * single reader of the flag, so an absent flag and an explicit `true` can never
 * diverge: ONLY an explicit `false` opts out.
 */
export function stepRequiresPrimaryClubConfig(
  step: RegisteredSelfHealStep,
): boolean {
  return step.requiresPrimaryClubConfig !== false;
}

/**
 * True for a Prisma unique-constraint conflict (P2002). Detected both by
 * instance (`PrismaClientKnownRequestError`) and structurally (`code === "P2002"`)
 * so a raced insert is tolerated regardless of how the driver surfaces it.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P2002";
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Registered steps
//
// The definitions themselves live in `config-self-heal-steps.ts` (the ratchet
// in scripts/lib/file-size-base.ts would not let this module grow further, and
// "what a step is" and "what each step copies" were the natural seam). They are
// erased into registry steps here, under the SAME export names they have always
// had, so every importer and every doc or schema comment pointing at
// `config-self-heal.ts` still resolves.
// ---------------------------------------------------------------------------

export const clubIdentitySelfHealStep = defineSelfHealStep(
  clubIdentitySelfHealStepDefinition,
);
export const lodgeCapacitySelfHealStep = defineSelfHealStep(
  lodgeCapacitySelfHealStepDefinition,
);
export const clubFacebookUrlSelfHealStep = defineSelfHealStep(
  clubFacebookUrlSelfHealStepDefinition,
);
export const ageTierSelfHealStep = defineSelfHealStep(
  ageTierSelfHealStepDefinition,
);
export const clubTimeZoneSelfHealStep = defineSelfHealStep(
  clubTimeZoneSelfHealStepDefinition,
);


/**
 * The ordered registry of self-heal steps. C3/C4/C5 append their capacity /
 * age-tier / identity steps here (see the module doc). Order is not significant —
 * steps are independent — but keep it stable for predictable logs.
 */
export const SELF_HEAL_STEPS: readonly RegisteredSelfHealStep[] = [
  clubIdentitySelfHealStep,
  clubFacebookUrlSelfHealStep,
  ageTierSelfHealStep,
  lodgeCapacitySelfHealStep,
  clubTimeZoneSelfHealStep,
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type SelfHealOutcome = "healed" | "already-present" | "failed";

export interface SelfHealStepResult {
  name: string;
  outcome: SelfHealOutcome;
  /** Present only when `outcome === "failed"`. */
  error?: string;
}

export interface SelfHealSummary {
  healed: number;
  alreadyPresent: number;
  failed: number;
  /**
   * True when the `config/club.json`-derived steps were skipped because the
   * effective config is a non-`"primary"` fallback (see the fallback guard in
   * the module doc). Those steps did no DB read and no DB write and contribute
   * no `results` entry.
   *
   * It does NOT mean the run did nothing: a step that declares
   * `requiresPrimaryClubConfig: false` — today `clubTimeZoneSelfHealStep`, whose
   * source is the environment rather than that file — still runs, still appears
   * in `results`, and is still counted. Read the flag as "the club-config half
   * was skipped", and read `results` for what actually happened.
   */
  skipped: boolean;
  /** The config provenance the run observed — drives the fallback guard. */
  provenance: ClubConfigSource;
  results: SelfHealStepResult[];
}

type SelfHealLogger = Pick<typeof logger, "info" | "warn">;

export interface RunConfigSelfHealOptions {
  /** The Prisma client (or a structural fake in tests). */
  db: SelfHealDb;
  /** Override the registry (tests inject a single step). Defaults to `SELF_HEAL_STEPS`. */
  steps?: readonly RegisteredSelfHealStep[];
  /** Override the logger (tests silence output). Defaults to the app logger. */
  log?: SelfHealLogger;
  /**
   * Effective config provenance. Every `config/club.json`-derived step runs ONLY
   * when this is `"primary"`; any fallback (`"example"` / `"safe-default"`) skips
   * those steps so a bad boot cannot freeze fallback values into the DB. A step
   * declaring `requiresPrimaryClubConfig: false` is unaffected and runs either
   * way. Defaults to the loader's `clubConfigSource` (the eager singleton's
   * provenance). Injected in tests.
   */
  provenance?: ClubConfigSource;
}

/**
 * Run each supplied step once, create-if-absent, accumulating one result per
 * step. Never throws: a per-step failure (DB error) is logged and recorded, and
 * the remaining steps still run. A raced concurrent writer (P2002) counts as
 * already-present.
 */
async function runSelfHealSteps(
  steps: readonly RegisteredSelfHealStep[],
  db: SelfHealDb,
  log: SelfHealLogger,
): Promise<SelfHealStepResult[]> {
  const results: SelfHealStepResult[] = [];
  for (const step of steps) {
    try {
      if (await step.isPresent(db)) {
        results.push({ name: step.name, outcome: "already-present" });
        continue;
      }
      try {
        await step.heal(db);
        results.push({ name: step.name, outcome: "healed" });
        log.info(
          { scope: "config-self-heal", step: step.name },
          `Config self-heal populated absent row: ${step.name}`,
        );
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          // A concurrent booter (blue/green double-boot) created it first.
          results.push({ name: step.name, outcome: "already-present" });
          continue;
        }
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: step.name, outcome: "failed", error: message });
      log.warn(
        { scope: "config-self-heal", step: step.name, err },
        `Config self-heal step failed (non-fatal): ${step.name}`,
      );
    }
  }
  return results;
}

/** Tally one run's per-step results into the summary shape. */
function summariseSelfHeal(
  results: SelfHealStepResult[],
  meta: { skipped: boolean; provenance: ClubConfigSource },
): SelfHealSummary {
  return {
    healed: results.filter((r) => r.outcome === "healed").length,
    alreadyPresent: results.filter((r) => r.outcome === "already-present").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped: meta.skipped,
    provenance: meta.provenance,
    results,
  };
}

/**
 * Run every registered self-heal step once, create-if-absent. NEVER throws: a
 * per-step failure (DB error) is logged and recorded, and the remaining steps
 * still run. A raced concurrent writer (P2002) counts as already-present.
 *
 * On a non-primary config provenance the `config/club.json`-derived steps are
 * skipped and any step that declares `requiresPrimaryClubConfig: false` still
 * runs — see the fallback guard in the module doc.
 */
export async function runConfigSelfHeal(
  options: RunConfigSelfHealOptions,
): Promise<SelfHealSummary> {
  const { db } = options;
  const steps = options.steps ?? SELF_HEAL_STEPS;
  const log = options.log ?? logger;
  const provenance = options.provenance ?? clubConfigSource;

  // Fallback guard: never persist a non-primary config into create-if-absent DB
  // rows. A fallback (example / safe-default) resolves when config/club.json is
  // absent/unreadable/malformed; freezing it would make the placeholder identity
  // (or safe-default capacity + rates) DB-first authoritative and unrecoverable
  // without admin edit / DB surgery. Skipped healing self-repairs on the next
  // boot once a valid primary config is present.
  //
  // The guard is per step, not per run: a step whose value does NOT come from
  // config/club.json has nothing to freeze, and gating it would strand it
  // permanently on a DB-first install where an absent club.json is normal
  // (#1987). So the club-config half is skipped and the rest still runs.
  if (provenance !== "primary") {
    const guardedSteps = steps.filter(stepRequiresPrimaryClubConfig);
    const environmentSteps = steps.filter(
      (step) => !stepRequiresPrimaryClubConfig(step),
    );
    const nameList = (list: readonly RegisteredSelfHealStep[]) =>
      list.length > 0 ? list.map((step) => step.name).join(", ") : "none";
    log.warn(
      {
        scope: "config-self-heal",
        provenance,
        skippedSteps: guardedSteps.map((step) => step.name),
        ranSteps: environmentSteps.map((step) => step.name),
      },
      `Config self-heal skipped the config/club.json-derived steps ` +
        `(${nameList(guardedSteps)}): effective config provenance is ` +
        `"${provenance}", not a valid primary config/club.json. Refusing to ` +
        `persist fallback values into create-if-absent DB rows (they would ` +
        `become DB-first authoritative and never be overwritten). Fix ` +
        `config/club.json; healing self-repairs automatically on the next boot ` +
        `once a valid primary config is present. Steps that do not read ` +
        `config/club.json still ran (${nameList(environmentSteps)}): their ` +
        `value comes from the environment, so this file's provenance says ` +
        `nothing about it.`,
    );
    return summariseSelfHeal(
      await runSelfHealSteps(environmentSteps, db, log),
      { skipped: true, provenance },
    );
  }

  return summariseSelfHeal(await runSelfHealSteps(steps, db, log), {
    skipped: false,
    provenance,
  });
}
