import "server-only";

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import { acquireConfigImportLock } from "@/lib/config-transfer-lock";
import { acquireLodgeCapacityLock } from "@/lib/lodge-capacity-lock";
import { lockMinimumStayPolicySet } from "@/lib/minimum-stay-policy-set";
import { lockAdultMemberHostingPolicySet } from "@/lib/adult-member-hosting-policy-set";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { readBundle, sha256Hex } from "./bundle";
import { buildImportPlanFromParsed, CATEGORY_IMPORTERS } from "./import";
import { mediaApplies, recreateBundleMedia } from "./media";
import {
  resolutionMap,
  type ApplyNotes,
  type CategoryApplyResult,
  type ImportMode,
  type MatchResolution,
  type TxDb,
} from "./import-types";
import type { ConfigTransferCategory } from "./manifest";
import type { BootstrapEmptyTargetProof } from "./bootstrap-import";
import {
  folderLodgeSlug,
  lodgeFolderSegments,
} from "./categories/lodge-config";
import type { ClubFormat } from "@/lib/club-format";

// Apply orchestrator. Order (ADR-002): parse once → pre-apply database backup →
// ONE transaction { advisory lock → re-plan against in-lock state → refuse on
// validation errors or ANY fingerprint mismatch (DB drift, substituted bundle,
// switched mode/selection/resolutions) → apply every selected category } →
// audit. Categories are upsert-only except the explicitly destructive,
// previewed booking-policy replace-set; any failure rolls back the import.

export class ConfigImportDriftError extends Error {
  constructor() {
    super(
      "The database changed since the import was previewed; re-run the dry-run and try again.",
    );
    this.name = "ConfigImportDriftError";
  }
}

export class ConfigImportValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(
      `The bundle has ${errors.length} validation error(s); fix the bundle ` +
        `(and reseal) then re-run the dry-run. First error: ${errors[0]}`,
    );
    this.name = "ConfigImportValidationError";
  }
}

export class ConfigImportBackupError extends Error {
  constructor(cause: string) {
    super(`Refusing to import: the pre-apply database backup failed (${cause}).`);
    this.name = "ConfigImportBackupError";
  }
}

/**
 * A lodge-config bundle may activate or deactivate chore templates. Lock every
 * existing affected lodge before the in-lock re-plan so roster validation and
 * the eventual config write observe one serialized template state. New lodges
 * need no lock: no committed roster can refer to their not-yet-visible id.
 */
async function lockAffectedLodgeConfigLodges(
  tx: TxDb,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const slugs = [
    ...new Set(
      lodgeFolderSegments(files)
        .map((segment) => folderLodgeSlug(files, segment))
        .filter((slug): slug is string => slug !== null),
    ),
  ];
  if (slugs.length === 0) return;

  const lodges = await tx.lodge.findMany({
    where: { slug: { in: slugs } },
    select: { id: true },
  });
  for (const lodgeId of lodges.map(({ id }) => id).sort()) {
    await acquireLodgeCapacityLock(tx, lodgeId);
  }
}

/**
 * The backup-skip variant for the boot-time empty-target bootstrap (ADR-003,
 * `bootstrap-import.ts`) — the ONLY caller allowed to waive the ADR-002
 * pre-apply backup. A bare string is deliberately not accepted: the `proof`
 * field's type can only be minted by `assessBootstrapReadiness` returning an
 * "apply" decision (the class is unexported and nominal), so the waiver cannot
 * compile without a positive empty-target probe.
 */
export type BootstrapBackupSkip = {
  kind: "skip-empty-bootstrap";
  /** Branded proof from `assessBootstrapReadiness` ("apply" decision only). */
  proof: BootstrapEmptyTargetProof;
  /**
   * Re-runs the emptiness probe INSIDE the advisory lock, before anything is
   * written (TOCTOU / multi-replica-boot guard). Throws to refuse; the throw
   * rolls the transaction back and the bootstrap caller maps it to a calm
   * refusal.
   */
  recheckEmptyTarget: (tx: TxDb) => Promise<void>;
  /**
   * Writes the bootstrap's `configuration.bootstrap_imported` idempotence
   * marker on the TRANSACTION client, after all category applies, so the
   * marker and the config writes commit or roll back atomically.
   */
  writeBootstrapMarker: (
    tx: TxDb,
    info: {
      totals: CategoryApplyResult;
      doorCodesWritten: string[];
      selectedCategories: ConfigTransferCategory[];
    },
  ) => Promise<void>;
};

export type ApplyConfigImportParams = {
  /** The club's format (#3565), resolved once by the caller, before this transaction. */
  format: ClubFormat;
  prisma: PrismaClient;
  bundleBytes: Uint8Array;
  actorMemberId: string;
  /** Fingerprint from the dry-run; apply refuses on any mismatch. */
  expectedFingerprint: string;
  /** merge (default) keeps existing values for blank fields; overwrite clears. */
  mode: ImportMode;
  /** Admin-selected categories (defaults to everything the manifest includes). */
  selectedCategories?: ConfigTransferCategory[];
  /** Key-weak match resolutions chosen in the dry-run picker. */
  resolutions?: MatchResolution[];
  /**
   * Pre-apply backup policy (ADR-002 §backup). Default `"required"` runs the
   * pre-apply `pg_dump` and its durability gate — the mandatory path for every
   * interactive/admin import.
   *
   * A {@link BootstrapBackupSkip} object skips the pre-apply backup ENTIRELY.
   * It is available to ONE caller only: the boot-time, empty-target
   * config-bundle bootstrap (ADR-003, `bootstrap-import.ts`), which applies a
   * bundle on a database that is empty of non-seed configuration. An empty
   * database has no prior configuration to protect, so the ADR-002 pre-apply
   * backup is waived there and there alone — and the waiver is enforced at the
   * type level: the object's `proof` field can only be minted by a positive
   * `assessBootstrapReadiness` probe, so the interactive route cannot even
   * compile a skip. Every other ADR-002 safeguard (parse/validate, sanitise,
   * single-flight lock, in-lock re-plan + fingerprint drift refusal, atomic
   * transaction, audit) still applies unchanged, and the skip
   * variant ADDS two safeguards of its own: the in-lock emptiness re-check
   * and the in-transaction bootstrap marker (see {@link BootstrapBackupSkip}).
   */
  preApplyBackup?: "required" | BootstrapBackupSkip;
};

export type ApplyConfigImportResult = {
  perCategory: Array<{ category: string } & CategoryApplyResult>;
  totals: CategoryApplyResult;
  backup: { attempted: boolean; skipped: boolean };
  doorCodesWritten: string[];
  /**
   * Distinct entity names this import actually changed (created or updated; an
   * unchanged item is excluded). Lets a caller fire an entity-specific side
   * effect only when that entity moved — e.g. the apply route drops the in-process
   * age-tier cache only when the `age-tier` entity changed (#2200).
   */
  appliedEntities: string[];
};

export async function applyConfigImport(
  params: ApplyConfigImportParams,
): Promise<ApplyConfigImportResult> {
  const { prisma, bundleBytes, actorMemberId, expectedFingerprint, mode, format } =
    params;
  const resolutions = params.resolutions ?? [];

  // Parse + structural validation ONCE; the same parsed bundle feeds the
  // in-transaction re-plan and the category applies.
  const parsed = readBundle(bundleBytes);
  const bundleSha256 = sha256Hex(bundleBytes);

  const preApplyBackup = params.preApplyBackup ?? "required";
  const bootstrapSkip = preApplyBackup === "required" ? null : preApplyBackup;

  // Pre-apply backup FIRST (ADR-002: backup, then verify, then execute). A
  // hard failure aborts; an operator-disabled backup (backups disabled in
  // Admin -> Backups) proceeds but is recorded. The empty-target bootstrap
  // (ADR-003) is the sole
  // exception: an empty database has no prior configuration to protect, so the
  // backup is waived and recorded as skipped-for-bootstrap rather than run.
  let backup: BackupResult;
  if (bootstrapSkip) {
    backup = {
      success: false,
      skipped: true,
      reason:
        "empty-bootstrap: pre-apply backup waived on an empty target (ADR-003)",
    };
  } else {
    backup = await runDatabaseBackup();
    if (backup.error) {
      throw new ConfigImportBackupError(backup.error);
    }
    // Durability gate (ADR-002): with backups ENABLED but no S3 destination the
    // backup lands only on this web slot's local disk — wiped by the next
    // deploy, so it is no restore path for the pre-import state. Both write
    // modes mutate config (merge creates rows and overwrites non-blank fields),
    // so refuse the import outright rather than clobber unrecoverable state.
    if (backup.success && !backup.uploadedToS3) {
      throw new ConfigImportBackupError(
        "the backup was written only to this server's local disk, which does " +
          "not survive a redeploy; configure an S3 destination in Admin -> " +
          "Backups so a durable pre-import backup exists, or disable backups " +
          "there to explicitly opt out of the safety backup",
      );
    }
  }

  const totals: CategoryApplyResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    skipped: 0,
  };
  const perCategory: Array<{ category: string } & CategoryApplyResult> = [];
  const notes: ApplyNotes = { doorCodesWritten: [] };
  let auditDiff: Array<{
    category: string;
    entity: string;
    key: string;
    action: string;
    changedFields?: string[];
  }> = [];
  let appliedEntities: string[] = [];
  let selectedCategories: ConfigTransferCategory[] = [];

  await prisma.$transaction(
    async (tx) => {
      // Serialise imports, THEN re-plan against the in-lock state: a second
      // import queued behind the lock re-plans against the winner's committed
      // writes, so a stale preview can never apply (ADR-002).
      await acquireConfigImportLock(tx);

      // The booking-policy importer is a replace-set. Its global set lock must
      // be held BEFORE the in-lock re-plan so no live CRUD can move the set
      // between the preview fingerprint and its mutations. The lock order is
      // permanently config-transfer singleton -> policy set.
      const bookingPoliciesSelected =
        parsed.manifest.includedCategories.includes("booking-policies") &&
        (!params.selectedCategories ||
          params.selectedCategories.includes("booking-policies"));
      if (bookingPoliciesSelected) {
        await lockMinimumStayPolicySet(tx);
        // #2364: the category's second replace-set. Permanent lock order is
        // config-transfer singleton -> minimum-stay set -> hosting set; live
        // CRUD takes only one of the last two, and no writer takes them in any
        // other order, so the three cannot form a cycle.
        await lockAdultMemberHostingPolicySet(tx);
      }

      const lodgeConfigSelected =
        parsed.manifest.includedCategories.includes("lodge-config") &&
        (!params.selectedCategories ||
          params.selectedCategories.includes("lodge-config"));
      if (lodgeConfigSelected) {
        // Permanent order: config-transfer singleton -> policy-set locks (when
        // selected) -> affected lodge ids in lexical order -> in-lock re-plan.
        await lockAffectedLodgeConfigLodges(tx, parsed.files);
      }

      // ADR-003 bootstrap only: re-run the emptiness probe INSIDE the lock,
      // before the re-plan and before anything is written. A concurrent
      // replica's bootstrap (or an interactive import) that committed while
      // this apply was being prepared throws here, rolling this transaction
      // back — a calm refusal upstream, never a spurious drift ERROR.
      if (bootstrapSkip) {
        await bootstrapSkip.recheckEmptyTarget(tx);
      }

      const replan = await buildImportPlanFromParsed(tx, parsed, bundleSha256, {
        mode,
        format,
        selectedCategories: params.selectedCategories,
        resolutions,
      });
      if (replan.errors.length > 0) {
        throw new ConfigImportValidationError(replan.errors);
      }
      if (replan.fingerprint !== expectedFingerprint) {
        throw new ConfigImportDriftError();
      }
      selectedCategories = replan.selectedCategories;

      // Bounded per-item diff for the audit record (what this import changes).
      auditDiff = replan.categories
        .flatMap((cat) =>
          cat.items
            .filter((i) => i.action !== "unchanged")
            .map((i) => ({
              category: cat.category,
              entity: i.entity,
              key: i.key,
              action: i.action,
              ...(i.changedFields?.length
                ? { changedFields: i.changedFields }
                : {}),
            })),
        )
        .slice(0, 200);

      // Distinct entities this import actually changes (uncapped, unlike the
      // 200-item auditDiff), so a caller can gate an entity-specific side effect.
      appliedEntities = [
        ...new Set(
          replan.categories.flatMap((cat) =>
            cat.items
              .filter((i) => i.action !== "unchanged")
              .map((i) => i.entity),
          ),
        ),
      ].sort();

      // Recreate bundled images once (only when an image-referencing category
      // is selected — disclosed by the plan's media items); all categories
      // share the remap.
      const imageRemap = mediaApplies(selectedCategories)
        ? await recreateBundleMedia(tx, parsed.files, actorMemberId)
        : new Map<string, string>();

      const applyCtx = {
        tx,
        files: parsed.files,
        manifest: parsed.manifest,
        mode,
        format,
        resolutions: resolutionMap(resolutions),
        actorMemberId,
        imageRemap,
        notes,
        selectedCategories,
      };
      for (const importer of CATEGORY_IMPORTERS) {
        if (!selectedCategories.includes(importer.category)) continue;
        const result = await importer.apply(applyCtx);
        perCategory.push({ category: importer.category, ...result });
        totals.created += result.created;
        totals.updated += result.updated;
        totals.deleted += result.deleted;
        totals.unchanged += result.unchanged;
        totals.skipped += result.skipped;
      }

      // ADR-003 bootstrap only: write the `configuration.bootstrap_imported`
      // idempotence marker on the SAME transaction, so the config writes and
      // the marker commit or roll back together — no crash window in which
      // the import committed unmarked.
      if (bootstrapSkip) {
        await bootstrapSkip.writeBootstrapMarker(tx, {
          totals,
          doorCodesWritten: notes.doorCodesWritten,
          selectedCategories,
        });
      }
    },
    { timeout: 60_000 },
  );

  await createAuditLog({
    action: "configuration.imported",
    memberId: actorMemberId,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: `Imported configuration bundle (${selectedCategories.join(", ")})`,
    metadata: {
      bundleSha256,
      selectedCategories,
      doorCodesIncluded: parsed.manifest.doorCodesIncluded,
      // The FACT of door-code writes (slugs only, never values) — the manifest
      // flag alone can misstate a hand-edited bundle.
      doorCodesWritten: notes.doorCodesWritten,
      mode,
      resolutions,
      sourceApp: parsed.manifest.app,
      totals,
      perCategory,
      diff: auditDiff,
      // Actual durability, so an incident responder is never misled into
      // believing a restorable pre-import backup exists when it does not.
      backup: {
        skipped: backup.skipped === true,
        uploadedToS3: backup.uploadedToS3 === true,
        ...(backup.s3Key ? { s3Key: backup.s3Key } : {}),
      },
    },
  });

  // Adult-hosting policy replacement queues every affected active incident in
  // the import transaction. Drain only after that transaction and its audit
  // have committed; provider delivery remains outside the authoritative write,
  // and the cron retains any work the bounded inline pass does not finish.
  if (appliedEntities.includes("adult-member-hosting-policy")) {
    await settleHostingCoverageAfterCommit({ limit: 5 }, prisma);
  }

  return {
    perCategory,
    totals,
    backup: {
      attempted: bootstrapSkip === null,
      skipped: backup.skipped === true,
    },
    doorCodesWritten: notes.doorCodesWritten,
    appliedEntities,
  };
}
