import "server-only";

import { readFile, stat } from "node:fs/promises";

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { clubConfigSource, type ClubConfigSource } from "@/config/club";
import { MAX_BUNDLE_BYTES, sha256Hex } from "./bundle";
import { buildImportPlan } from "./import";
import {
  applyConfigImport,
  type ApplyConfigImportResult,
} from "./apply";
import type { ImportMode, ReadDb } from "./import-types";
import { formatConfigImportTotals } from "./preview";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * C9 — Config bundle auto-import on boot (ADR-003, disaster-recovery / clone).
 *
 * When `CONFIG_BUNDLE_IMPORT_PATH` names a readable bundle file AND the database
 * is **empty of non-seed configuration**, this module applies that bundle
 * non-interactively at boot, through the EXACT same validated import pipeline
 * (`import.ts` plan → `apply.ts` apply) the interactive admin route uses. It is
 * the mechanism behind the ADR-003 provisioning flow:
 *
 *   deploy env + bundle file → migrations → base seed → **boot auto-import** →
 *   operational site
 *
 * ## Security posture — fail closed everywhere
 * The bundle file is operator-controlled DEPLOYMENT configuration (equivalent to
 * writing `config/club.json` or setting install-time env — a first-install
 * capability, not a privilege escalation; see ADR-003 "Trust model"), but its
 * BYTES are treated as fully untrusted input: the same `readBundle` structural
 * validation, resource caps, `FORBIDDEN_FIELD_PATTERNS` allowlist, and per-field
 * Prisma-DMMF type-checks that guard the interactive path guard this one. The
 * residual risk ADR-003 identifies is a bundle applied to a NON-empty database;
 * the empty-target guard below is what prevents it, so it is designed to fail
 * CLOSED — any doubt about emptiness, any probe query error, any validation
 * error, any plan step that would need a human answer, and any I/O or apply
 * failure all REFUSE the import and leave the database untouched. Boot always
 * continues (best-effort, like the C2 self-heal): the process must never crash
 * because of a bootstrap bundle.
 *
 * ## Order of operations — probe before file I/O
 * The emptiness probe (cheap DB counts) runs FIRST; the bundle file is only
 * statted/read after the probe decides "apply". A configured steady-state
 * target therefore performs ZERO file I/O on boot even while the env var stays
 * set. Before reading, the file is `stat`ed: a non-regular file (device/FIFO),
 * a stat failure, or a size above the pipeline's `MAX_BUNDLE_BYTES` cap refuses
 * without ever loading the bytes into memory.
 *
 * ## "Empty of non-seed configuration" — the precise definition (six signals)
 * The base seed (`prisma/seed.ts`) is create-if-missing and pre-populates the
 * config singletons and keyed rows this importer touches (club identity, theme,
 * lodge, age tiers, seasons/rates, pages, site content, committee roles,
 * induction template, Xero mappings, displays). So a faithful club bundle
 * applied to a freshly-seeded database necessarily produces UPDATEs against those
 * seed placeholders — "the plan has zero updates" is therefore NOT a usable
 * empty-target signal on this codebase (it would refuse every legitimate
 * bootstrap). Emptiness is instead defined as **no operator footprint**: the
 * absence of ALL SIX of these signals, probed positively over state the seed
 * never creates (see {@link assessBootstrapReadiness}; the seed writes no
 * `AuditLog` rows and no `SetupProgress` row):
 *
 *   1. No config bundle has ever been imported — no `configuration.imported`
 *      (interactive) or `configuration.bootstrap_imported` (this feature) audit
 *      row. This is also what makes a second boot idempotent.
 *   2. No bookings exist.
 *   3. No non-system members exist (any `Member` whose role is not one of the
 *      seeded system-account roles ADMIN / LODGE).
 *   4. The setup wizard was never marked finished (`SetupProgress.completedAt`
 *      is null).
 *   5. The setup wizard was never even DRIVEN — no `SetupProgress` row has any
 *      completed or skipped step ids. Step completes/skips leave `completedAt`
 *      null, so signal 4 alone would miss a club configured through
 *      `/admin/setup` without pressing "finish".
 *   6. No audit-log row has a MEMBER actor — no row whose `memberId` or
 *      `actorMemberId` is set to anything other than a `system:`-prefixed
 *      synthetic actor. Coverage rests on per-editor auditing: the admin
 *      configuration editors (the direct config editors — including the chores
 *      and display lodge-config editors — and the wizard steps) all audit with
 *      a member actor, so this catches a club configured through the admin UI
 *      without any of the other footprints. (Successful logins are NOT audited
 *      — only auth bounces are — so this signal does not rest on them.)
 *
 * ALL six must be absent to apply. Any one present refuses — strictly safer
 * than an update-count check, because it also refuses a manually-configured
 * club whose bundle keys happen to collide with seed keys (which an update
 * count could misread as "unchanged"). The refusal distinguishes the calm
 * steady state (a prior bootstrap already ran — INFO) from an unexpected
 * non-empty target (WARN). Any probe query error propagates and is treated as
 * "do not apply".
 *
 * ## Concurrency — the probe is re-run INSIDE the apply lock
 * The boot probe races other writers (concurrent replica boots in the
 * blue/green stack, or an admin importing interactively at the same instant).
 * To close that TOCTOU window the SAME probe is re-run inside the apply
 * transaction, immediately after the `pg_advisory_xact_lock` single-flight
 * lock is acquired and before anything is written. If the in-lock re-check
 * finds the target configured, the transaction rolls back and the refusal is
 * logged CALMLY at INFO — on a multi-replica boot this is the healthy expected
 * outcome for every replica that lost the race (the first replica won and
 * applied). Combined with the bootstrap marker being written INSIDE the same
 * transaction (see below), at most one bootstrap apply can ever commit.
 *
 * ## Non-interactive abort — CAN trip on a post-seed target
 * Any plan item with rename candidates (a key-weak entity that did not match
 * exactly but has existing rows it could be a rename of) aborts the bootstrap
 * rather than guessing. This is NOT unreachable on a legitimate bootstrap: the
 * base seed creates key-weak rows (the default induction template, the example
 * chore templates), so a bundle from a source club that RENAMED those defaults
 * produces candidates against a faithfully-seeded target and the whole import
 * refuses (nothing written). That fail-closed outcome is deliberate; the
 * documented fallback is the interactive import (Admin → Setup & Configuration
 * → Export & Import), where a human resolves the renames. The abort log
 * enumerates the affected entities so the operator knows what to resolve.
 *
 * ## Provenance guard — deliberately NOT applied
 * The C2 self-heal is gated on `clubConfigSource === "primary"` to avoid freezing
 * FALLBACK config values into create-if-absent rows. The bootstrap import is
 * intentionally NOT gated on config provenance: the BUNDLE is the config source
 * in the DR scenario, and `config/club.json` is often absent there (that is the
 * whole reason to restore from a bundle), so provenance is typically
 * `"safe-default"`. Gating on `"primary"` would disable the feature exactly when
 * it is needed. The self-heal's hazard does not transfer, because this importer
 * writes the BUNDLE's values, never the effective fallback config. On a
 * SAFE_DEFAULT boot the self-heal skips (writing nothing) and the bootstrap
 * import then populates the database from the bundle — no double-write, no
 * conflict. Provenance is recorded in logs for observability only.
 *
 * ## Interaction with the C2 self-heal (runs first, in the same boot)
 * The self-heal runs BEFORE this module. Whether it wrote rows or skipped, there
 * is no conflict: the emptiness probe deliberately looks at operational
 * footprint, NOT at config-singleton presence, so self-healed rows never make
 * the target look "non-empty". If the self-heal created identity/age-tier rows
 * (primary-config clone), this importer simply upserts over them with the
 * bundle's authoritative values; if it skipped (safe-default DR), this importer
 * creates them. On the NEXT boot the self-heal sees the rows present (skips) and
 * this importer sees the `configuration.bootstrap_imported` marker (refuses).
 *
 * ## "Exactly one write" — what is actually guaranteed
 * The `configuration.bootstrap_imported` marker is written INSIDE the apply
 * transaction (via {@link BootstrapBackupSkip.writeBootstrapMarker}), so the
 * config writes and the idempotence marker commit or roll back together —
 * there is no crash window in which the config committed but the marker did
 * not. Together with the in-lock re-check, this makes "at most one bootstrap
 * apply ever commits" transactional, not best-effort. (The PIPELINE's own
 * `configuration.imported` audit row is still written after the transaction
 * commits, exactly as on the interactive path; a crash in that narrow window
 * loses only that secondary row — the marker, which idempotence and the probe
 * key on, is already durable.)
 */

/**
 * Prefix for synthetic (non-member) audit actors. Rows whose actor id starts
 * with this prefix are written by system processes, never by a person; the
 * emptiness probe ignores them and the admin audit UI renders them as
 * "System" (see `src/lib/audit-query.ts`).
 */
export const SYSTEM_AUDIT_ACTOR_PREFIX = "system:";

/**
 * Synthetic actor id for the boot-time bootstrap import ("system/deploy"). Both
 * `AuditLog.memberId` and `MediaImage.uploadedByMemberId` are FK-free `String?`
 * columns, so this non-member id is safe to persist and never violates a
 * relation.
 */
export const CONFIG_BOOTSTRAP_ACTOR = `${SYSTEM_AUDIT_ACTOR_PREFIX}config-bootstrap`;

/** Audit action recorded for a successful boot-time bootstrap import. */
export const CONFIG_BOOTSTRAP_AUDIT_ACTION = "configuration.bootstrap_imported";

/**
 * Write mode for the bootstrap import. `"overwrite"` makes the bundle fully
 * authoritative so a fresh install faithfully reproduces the source club (blank
 * bundle fields clear the corresponding seed placeholder). Merge would instead
 * leave seed placeholders showing through wherever the source blanked a field,
 * producing a hybrid — wrong for a DR/clone whose goal is to reproduce the
 * source. Creates (the common case on an empty target) use the bundle values in
 * either mode.
 */
const BOOTSTRAP_IMPORT_MODE: ImportMode = "overwrite";

/** Roles the base seed assigns to its two system accounts (admin + lodge kiosk). */
const SEED_SYSTEM_ROLES = ["ADMIN", "LODGE"] as const;

/** Prisma surface the bootstrap probe + apply need (full client in production). */
type BootstrapDb = PrismaClient;

/**
 * Compile-time proof that {@link assessBootstrapReadiness} returned an "apply"
 * decision. The class is NOT exported (only its type is), and the `#`-private
 * field makes the type nominal, so no other module can construct or
 * structurally forge a value of this type — `applyConfigImport`'s
 * backup-skip variant demands one, which pins the skip to a positive
 * empty-target probe at the type level (a bare string no longer compiles).
 */
class BootstrapEmptyTargetProof {
  readonly #assessedAt: Date;

  constructor(assessedAt: Date) {
    this.#assessedAt = assessedAt;
  }

  /** When the emptiness probe ran (observability only). */
  get assessedAt(): Date {
    return this.#assessedAt;
  }
}
export type { BootstrapEmptyTargetProof };

/**
 * Thrown by the in-lock emptiness re-check when another writer (a concurrent
 * replica's bootstrap, or an interactive import) configured the target between
 * the boot probe and the apply lock. This is the HEALTHY multi-replica-boot
 * outcome for every replica that lost the race, so the caller maps it to a
 * calm INFO refusal, never an ERROR.
 */
class BootstrapConcurrentWriterError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BootstrapConcurrentWriterError";
  }
}

export type BootstrapReadiness =
  | { decision: "apply"; proof: BootstrapEmptyTargetProof }
  | {
      decision: "refuse";
      severity: "info" | "warn";
      reason: string;
    };

/**
 * Probe whether the database is empty of non-seed configuration — the six
 * "no operator footprint" signals in the module docblock, ALL of which must be
 * absent to apply. Read-only; never writes. Fails closed — any probe error
 * propagates to the caller, which treats it as "do not apply".
 *
 * Accepts a transaction client so the SAME probe runs at boot (outside the
 * lock) and again inside the apply transaction's advisory lock (the TOCTOU
 * re-check).
 */
export async function assessBootstrapReadiness(
  db: ReadDb,
): Promise<BootstrapReadiness> {
  // 1. Has any config bundle already been imported? Either the interactive
  //    action or this feature's marker means configuration has been imported —
  //    the bootstrap marker also makes a second boot the calm steady state.
  const [bootstrapImports, interactiveImports] = await Promise.all([
    db.auditLog.count({
      where: { action: CONFIG_BOOTSTRAP_AUDIT_ACTION, outcome: "success" },
    }),
    db.auditLog.count({ where: { action: "configuration.imported" } }),
  ]);
  if (bootstrapImports > 0) {
    return {
      decision: "refuse",
      severity: "info",
      reason:
        "a config bundle was already auto-imported on a prior boot; the " +
        "target is configured (steady state)",
    };
  }
  if (interactiveImports > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        "a config bundle has already been imported on this target (through " +
        "the admin UI, or by an earlier partially-recorded import); refusing " +
        "to overwrite a configured target",
    };
  }

  // 2–6. Operational, setup-wizard, and admin-actor footprint — none of which
  // the base seed creates (it writes no AuditLog rows and no SetupProgress
  // row; its only members are the ADMIN/LODGE system accounts).
  const [
    bookingCount,
    nonSystemMemberCount,
    finishedSetup,
    drivenSetup,
    memberActorAuditRows,
  ] = await Promise.all([
    db.booking.count(),
    db.member.count({
      where: { role: { notIn: [...SEED_SYSTEM_ROLES] } },
    }),
    db.setupProgress.count({ where: { completedAt: { not: null } } }),
    // 5. ANY wizard interaction: a step completed or skipped, even without the
    //    explicit "finish" action that sets completedAt.
    db.setupProgress.count({
      where: {
        OR: [
          { completedStepIds: { isEmpty: false } },
          { skippedStepIds: { isEmpty: false } },
        ],
      },
    }),
    // 6. ANY audit row written by a member actor (either actor column set to a
    //    non-`system:` id). Admin config edits (direct editors and wizard
    //    steps) all audit with a member actor; synthetic `system:`-prefixed
    //    actors (this feature) and actor-less system/cron rows are excluded.
    //    (Successful logins are not audited — only auth bounces — so this does
    //    not rely on login rows.)
    db.auditLog.count({
      where: {
        OR: [
          {
            AND: [
              { memberId: { not: null } },
              {
                NOT: {
                  memberId: { startsWith: SYSTEM_AUDIT_ACTOR_PREFIX },
                },
              },
            ],
          },
          {
            AND: [
              { actorMemberId: { not: null } },
              {
                NOT: {
                  actorMemberId: { startsWith: SYSTEM_AUDIT_ACTOR_PREFIX },
                },
              },
            ],
          },
        ],
      },
    }),
  ]);

  if (bookingCount > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason: `target already has ${bookingCount} booking(s); it is in use`,
    };
  }
  if (nonSystemMemberCount > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        `target already has ${nonSystemMemberCount} non-system member(s); ` +
        "it is configured/in use",
    };
  }
  if (finishedSetup > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason: "the setup wizard was already marked complete on this target",
    };
  }
  if (drivenSetup > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        "the setup wizard has been used on this target (steps completed or " +
        "skipped); it is being configured by an operator",
    };
  }
  if (memberActorAuditRows > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        `target has ${memberActorAuditRows} audit-log row(s) with a member ` +
        "actor; it has been administered/configured",
    };
  }

  return { decision: "apply", proof: new BootstrapEmptyTargetProof(new Date()) };
}

export type BootstrapImportOutcome =
  | "disabled" // env var not set
  | "unreadable" // path set but file missing/unreadable/not a regular file
  | "refused-configured" // target not empty (steady state / already configured)
  | "refused-invalid" // bundle failed validation / oversized / needs a human
  | "applied" // bundle applied successfully
  | "failed"; // unexpected error during probe or apply

export interface BootstrapImportResult {
  outcome: BootstrapImportOutcome;
  /** Human-readable detail for logs. */
  detail?: string;
  /** sha256 of the bundle bytes, when a file was read. */
  bundleSha256?: string;
  /** Totals from a successful apply. */
  totals?: ApplyConfigImportResult["totals"];
}

/** Minimal stat facts the pre-read guard needs. */
export interface BundleFileStat {
  size: number;
  isFile: boolean;
}

/** Injectable seams so tests exercise the orchestrator without real fs/apply. */
export interface RunConfigBootstrapImportOptions {
  db: BootstrapDb;
  /** Defaults to `process.env.CONFIG_BUNDLE_IMPORT_PATH`. */
  path?: string | undefined;
  /** Defaults to the app logger; tests silence it. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /** Effective config provenance, recorded for observability only. */
  provenance?: ClubConfigSource;
  /** Stats the bundle file BEFORE reading (injectable). Defaults to `fs.stat`. */
  statBundleFile?: (path: string) => Promise<BundleFileStat>;
  /** Reads the bundle file (injectable). Defaults to `fs.readFile`. */
  readBundleFile?: (path: string) => Promise<Uint8Array>;
  /** The plan builder (injectable). Defaults to `buildImportPlan`. */
  planImpl?: typeof buildImportPlan;
  /** The apply implementation (injectable). Defaults to `applyConfigImport`. */
  applyImpl?: typeof applyConfigImport;
}

/**
 * Boot-time entrypoint. NEVER throws — every failure path returns a
 * {@link BootstrapImportResult} and logs; the caller in
 * `instrumentation.node.ts` additionally wraps the dynamic import. Probes
 * readiness FIRST (no file I/O on a configured target), then stats + reads the
 * env-named bundle, then applies it through the shared pipeline with the
 * in-lock re-check and transactional marker; otherwise refuses and leaves the
 * database untouched.
 */
export async function runConfigBootstrapImport(
  options: RunConfigBootstrapImportOptions,
): Promise<BootstrapImportResult> {
  const db = options.db;
  const log = options.log ?? logger;
  const provenance = options.provenance ?? clubConfigSource;
  const path = options.path ?? process.env.CONFIG_BUNDLE_IMPORT_PATH?.trim();
  const statBundleFile = options.statBundleFile ?? defaultStatBundleFile;
  const readBundleFile = options.readBundleFile ?? defaultReadBundleFile;
  const planImpl = options.planImpl ?? buildImportPlan;
  const applyImpl = options.applyImpl ?? applyConfigImport;
  const scope = "config-bootstrap-import";

  if (!path) {
    // Not configured — the overwhelmingly common case. Silent no-op.
    return { outcome: "disabled" };
  }

  // Empty-target guard FIRST — fail closed, and touch the file only if the
  // target is genuinely empty. A configured steady-state boot therefore does
  // zero file I/O even while the env var stays set.
  let readiness: BootstrapReadiness;
  try {
    readiness = await assessBootstrapReadiness(db);
  } catch (err) {
    log.error(
      { scope, path, provenance, err },
      `Config bundle auto-import failed (non-fatal): the empty-target probe ` +
        `errored (${err instanceof Error ? err.message : String(err)}). ` +
        `Refusing to apply; nothing was written; boot continues.`,
    );
    return { outcome: "failed", detail: String(err) };
  }
  if (readiness.decision === "refuse") {
    const message =
      `Config bundle auto-import refused: ${readiness.reason}. ` +
      `Nothing was written (the bundle file was not read); boot continues.`;
    if (readiness.severity === "info") {
      log.info({ scope, path, provenance }, message);
    } else {
      log.warn({ scope, path, provenance }, message);
    }
    return { outcome: "refused-configured", detail: readiness.reason };
  }

  // Pre-read guard: stat before read so an oversized or non-regular file is
  // refused without loading it into memory. Missing/unreadable paths are an
  // operator misconfiguration, not a crash: log and continue boot.
  let fileStat: BundleFileStat;
  try {
    fileStat = await statBundleFile(path);
  } catch (err) {
    log.warn(
      { scope, err, path, provenance },
      `Config bundle auto-import skipped: cannot stat CONFIG_BUNDLE_IMPORT_PATH ` +
        `("${path}"). Fix the path or unset the variable; boot continues.`,
    );
    return { outcome: "unreadable", detail: String(path) };
  }
  if (!fileStat.isFile) {
    log.warn(
      { scope, path, provenance },
      `Config bundle auto-import skipped: CONFIG_BUNDLE_IMPORT_PATH ("${path}") ` +
        `is not a regular file. Fix the path or unset the variable; boot continues.`,
    );
    return { outcome: "unreadable", detail: String(path) };
  }
  if (fileStat.size > MAX_BUNDLE_BYTES) {
    log.error(
      { scope, path, provenance, sizeBytes: fileStat.size },
      `Config bundle auto-import refused: the file at CONFIG_BUNDLE_IMPORT_PATH ` +
        `is ${fileStat.size} bytes, over the ${MAX_BUNDLE_BYTES}-byte bundle ` +
        `cap. It was not read. Nothing was written; boot continues.`,
    );
    return {
      outcome: "refused-invalid",
      detail: `bundle file exceeds the ${MAX_BUNDLE_BYTES}-byte cap`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBundleFile(path);
  } catch (err) {
    log.warn(
      { scope, err, path, provenance },
      `Config bundle auto-import skipped: cannot read CONFIG_BUNDLE_IMPORT_PATH ` +
        `("${path}"). Fix the path or unset the variable; boot continues.`,
    );
    return { outcome: "unreadable", detail: String(path) };
  }

  const bundleSha256 = sha256Hex(bytes);

  try {
    // Plan first (untrusted-input validation + human-resolution check) BEFORE
    // applying. `buildImportPlan` runs `readBundle` (structural validation +
    // resource caps + safe-path checks) and every category planner
    // (allowlist + DMMF type-checks). A malformed/tampered/oversized bundle
    // surfaces here with no write attempted.
    // The club's format (#3565), resolved once per boot import, before the
    // plan and the apply transaction it feeds.
    const format = await clubFormatValues();
    const plan = await planImpl(db, bytes, {
      mode: BOOTSTRAP_IMPORT_MODE,
      format,
    });

    if (plan.errors.length > 0) {
      log.error(
        { scope, bundleSha256, provenance, errors: plan.errors.slice(0, 10) },
        `Config bundle auto-import refused: the bundle has ${plan.errors.length} ` +
          `validation error(s) — first: ${plan.errors[0]}. Nothing was written.`,
      );
      return {
        outcome: "refused-invalid",
        detail: plan.errors[0],
        bundleSha256,
      };
    }

    // ADR-003 non-interactive safety: any plan item that would need a human
    // answer (a key-weak match with candidates) aborts rather than guessing.
    // This CAN legitimately trip on a freshly-seeded target: the seed creates
    // key-weak rows (default induction template, example chore templates), so
    // a bundle whose source club renamed those defaults produces candidates.
    // Fail closed and point the operator at the interactive import, naming the
    // entities so they know what to resolve there.
    const ambiguous = plan.categories
      .flatMap((cat) => cat.items)
      .filter((item) => (item.candidates?.length ?? 0) > 0);
    if (ambiguous.length > 0) {
      const shown = ambiguous
        .slice(0, 10)
        .map((i) => `${i.entity} "${i.key}"`)
        .join(", ");
      const suffix = ambiguous.length > 10 ? ", …" : "";
      log.error(
        {
          scope,
          bundleSha256,
          provenance,
          entities: ambiguous.slice(0, 10).map((i) => `${i.entity}:${i.key}`),
        },
        `Config bundle auto-import refused: ${ambiguous.length} row(s) need an ` +
          `interactive rename decision, which cannot be made non-interactively: ` +
          `${shown}${suffix}. This can happen when the source club renamed ` +
          `seed-created defaults (e.g. the induction template or example chore ` +
          `templates). Import the bundle through Admin → Setup & Configuration → ` +
          `Export & Import instead, and resolve the renames there. ` +
          `Nothing was written.`,
      );
      return {
        outcome: "refused-invalid",
        detail: "plan requires interactive rename resolution",
        bundleSha256,
      };
    }

    // Apply through the shared pipeline. The pre-apply backup is waived ONLY
    // here (empty target has nothing to protect) and requires the branded
    // proof minted by the positive probe above; every other ADR-002 safeguard
    // holds. The emptiness probe is RE-RUN inside the advisory lock before
    // anything is written (TOCTOU/multi-replica guard), and the bootstrap
    // marker is written INSIDE the same transaction so the config writes and
    // the idempotence marker commit atomically. Any failure inside rolls the
    // single transaction back — no partial apply.
    const result = await applyImpl({
      prisma: db,
      bundleBytes: bytes,
      actorMemberId: CONFIG_BOOTSTRAP_ACTOR,
      expectedFingerprint: plan.fingerprint,
      mode: BOOTSTRAP_IMPORT_MODE,
      format,
      preApplyBackup: {
        kind: "skip-empty-bootstrap",
        proof: readiness.proof,
        recheckEmptyTarget: async (tx) => {
          const inLock = await assessBootstrapReadiness(tx);
          if (inLock.decision === "refuse") {
            throw new BootstrapConcurrentWriterError(inLock.reason);
          }
        },
        writeBootstrapMarker: async (tx, info) => {
          // The bootstrap's own audit marker (system/deploy actor, bundle
          // checksum, outcome) — distinct from the pipeline's
          // `configuration.imported` row so the emptiness probe can tell a
          // bootstrap apart from an interactive import, and idempotence keys
          // on it. Written on the TRANSACTION client: marker and config
          // writes commit or roll back together.
          await createAuditLog(
            {
              action: CONFIG_BOOTSTRAP_AUDIT_ACTION,
              memberId: CONFIG_BOOTSTRAP_ACTOR,
              category: "system",
              severity: "critical",
              outcome: "success",
              summary: `Auto-imported configuration bundle on boot (${formatConfigImportTotals(info.totals)})`,
              metadata: {
                bundleSha256,
                provenance,
                mode: BOOTSTRAP_IMPORT_MODE,
                selectedCategories: info.selectedCategories,
                totals: info.totals,
                doorCodesWritten: info.doorCodesWritten,
                backup: { attempted: false, skipped: true },
              },
            },
            tx,
          );
        },
      },
    });

    // #2511: the unattended DR path has no interactive preview, so surface the
    // plan's behaviour-change warnings — including the cleaned-literal re-plant
    // skips this guard exists for — in the boot log. Without this a stale bundle
    // whose guest-booking hero / RMCA footer / lodge address was skipped would
    // leave the operator no signal that re-planting was prevented, so they would
    // never re-export the archived bundle and the silent skip would recur on
    // every rebuild. `plan.categories[].warnings` is where each category planner
    // (including the site-content cleaned-literal warnings) records them.
    const planWarnings = plan.categories.flatMap((cat) => cat.warnings);
    if (planWarnings.length > 0) {
      log.warn(
        { scope, bundleSha256, provenance, warnings: planWarnings.slice(0, 20) },
        `Config bundle auto-import applied with ${planWarnings.length} ` +
          `warning(s); the first: ${planWarnings[0]}` +
          `${planWarnings.length > 1 ? ` (and ${planWarnings.length - 1} more — see the "warnings" field).` : ""} ` +
          `A cleaned-literal warning means a stale bundle value was skipped, not ` +
          `written — re-export the bundle after upgrading and replace the ` +
          `archived copy to clear it.`,
      );
    }

    log.info(
      {
        scope,
        bundleSha256,
        provenance,
        totals: result.totals,
        categories: plan.selectedCategories,
      },
      `Config bundle auto-imported on boot: ${formatConfigImportTotals(result.totals)}.`,
    );

    return {
      outcome: "applied",
      bundleSha256,
      totals: result.totals,
    };
  } catch (err) {
    if (err instanceof BootstrapConcurrentWriterError) {
      // The in-lock re-check found the target configured: another replica's
      // bootstrap (or a concurrent interactive import) won the race and
      // committed first. This is the EXPECTED healthy outcome for the losing
      // replicas of a multi-replica boot — calm INFO, never an error.
      log.info(
        { scope, bundleSha256, provenance },
        `Config bundle auto-import refused: another writer configured the ` +
          `target while this import was being prepared (${err.message}). ` +
          `On a multi-replica boot this is the expected outcome for every ` +
          `replica that did not win the race. Nothing was written by this ` +
          `replica; boot continues.`,
      );
      return {
        outcome: "refused-configured",
        detail: "another writer configured the target (in-lock re-check)",
        bundleSha256,
      };
    }
    // Untrusted-input parse errors, drift, apply failures — all land here.
    // The apply transaction is atomic, so a mid-apply throw wrote nothing.
    log.error(
      { scope, bundleSha256, provenance, err },
      `Config bundle auto-import failed (non-fatal): ${err instanceof Error ? err.message : String(err)}. ` +
        `Nothing was written; boot continues.`,
    );
    return { outcome: "failed", detail: String(err), bundleSha256 };
  }
}

async function defaultStatBundleFile(path: string): Promise<BundleFileStat> {
  const stats = await stat(path);
  return { size: stats.size, isFile: stats.isFile() };
}

async function defaultReadBundleFile(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
