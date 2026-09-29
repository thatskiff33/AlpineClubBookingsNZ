/**
 * AI Diagnostics operational configuration — DB-only resolution (AID-2, #2371,
 * epic #2369).
 *
 * This is a SEPARATE, admin-only paid product from the page-help AI assistant
 * (`ai-assistant-config.ts`). The two share NOTHING at the credential layer:
 *
 *  - Diagnostics uses a DEDICATED Anthropic credential in the encrypted
 *    IntegrationCredential store under provider "anthropic-diagnostics", key
 *    "api_key". It NEVER reads the page-help "anthropic"/"api_key" credential,
 *    and there is deliberately no fallback to it — so a deployment can point
 *    diagnostics at a separate Anthropic workspace/key (separate billing, spend
 *    limits, and zero-retention posture), and a page-help key can never silently
 *    authorise diagnostics spend.
 *
 * CREDENTIAL DECISION (dedicated vs reuse) — OWNER CONFIRMATION FLAGGED:
 *   The AID-1 threat-model/ADR (#2370) was not yet delivered when this landed, so
 *   this implements the SAFE DEFAULT the epic mandates ("no implicit credential
 *   sharing"): a dedicated, explicitly-configured credential. If the owner
 *   instead wants diagnostics to reuse the page-help key, that is a deliberate
 *   contract change to make on-repo in AID-1 — it is not the default here.
 *
 * Exposure contract (mirrors #2079): the API key is NEVER returned to a client,
 * logged, or put in an audit row. Setup surfaces read metadata-only state.
 *
 * Fail-closed readiness: diagnostics is usable only when the module is ON AND a
 * usable dedicated key is stored AND a positive monthly budget is set AND the
 * dedicated SELECT-only database role is provisioned and VERIFIED least-privilege.
 * Any of those missing — or any DB fault while resolving them — resolves to NOT
 * ready.
 *
 * The database gate arrived with AID-5 (#2374). It is a readiness gate and not
 * merely a warning because epic #2369 and ADR-007 both make the separate
 * non-superuser credential MANDATORY: the product's whole evidence path is
 * supposed to be structurally incapable of writing, and a deployment that has not
 * provisioned the role has not established that. The module ships default-off, so
 * no existing deployment changes behaviour — an operator turning Diagnostics on
 * runs `pnpm run diagnostics:provision-role` as part of setup, which is exactly the
 * documented step ADR-007 §3 calls for, and this endpoint is what tells them so.
 */

import {
  getIntegrationCredentialValue,
  providerNeedsReentry,
} from "@/lib/integration-credentials";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { DIAGNOSTICS_BLOCKER_CODES } from "@/lib/ai-diagnostics-blockers";
import { loadDiagnosticsBudgetCents } from "@/lib/ai-diagnostics-usage";
import {
  checkDiagnosticsDatabaseReadiness,
  type DiagnosticsDatabaseState,
} from "@/lib/diagnostics/tools/database";
import { loadEffectiveModuleFlagsStrict } from "@/lib/module-settings";

/**
 * DEDICATED provider namespace — deliberately NOT the page-help "anthropic"
 * provider, so the two keys are stored as distinct encrypted rows and can never
 * be confused for one another.
 */
export const DIAGNOSTICS_PROVIDER = "anthropic-diagnostics";

export const DIAGNOSTICS_CREDENTIAL_KEYS = {
  apiKey: "api_key",
} as const;

/** The one write-capturable Diagnostics credential key (wizard + API allowlist). */
export const DIAGNOSTICS_WRITABLE_CREDENTIAL_KEYS = [
  DIAGNOSTICS_CREDENTIAL_KEYS.apiKey,
] as const;

/**
 * The operational DEDICATED Anthropic API key for diagnostics, or `undefined`
 * when diagnostics is not usable. Returns `undefined` for BOTH not_configured
 * (no key stored) AND needs_reentry (a stored key that fails GCM after an
 * auth-secret rotation) — `getIntegrationCredentialValue` collapses those to
 * null, so a needs-reentry key can never be handed to the paid provider. There
 * is NO fallback to the page-help key.
 */
export async function getOperationalDiagnosticsApiKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      DIAGNOSTICS_PROVIDER,
      DIAGNOSTICS_CREDENTIAL_KEYS.apiKey,
    )) ?? undefined
  );
}

/** Canonical setup state for the dedicated diagnostics key (metadata only). */
export type DiagnosticsKeyState = "not_configured" | "saved" | "needs_reentry";

export interface DiagnosticsSetupState {
  state: DiagnosticsKeyState;
  /** ISO timestamp the key was last written, or null when unconfigured. */
  keySetAt: string | null;
}

/**
 * Metadata-only setup state for the dedicated diagnostics key. NEVER returns the
 * key value. `saved` means a key is stored AND decrypts; `needs_reentry` means a
 * stored key fails GCM (the auth secret changed). A DB error propagates to the
 * caller (which decides how to degrade — the readiness aggregate below treats it
 * as NOT ready).
 */
export async function getDiagnosticsSetupState(): Promise<DiagnosticsSetupState> {
  const [row, needsReentry] = await Promise.all([
    prisma.integrationCredential.findUnique({
      where: {
        provider_key: {
          provider: DIAGNOSTICS_PROVIDER,
          key: DIAGNOSTICS_CREDENTIAL_KEYS.apiKey,
        },
      },
      select: { updatedAt: true },
    }),
    providerNeedsReentry(DIAGNOSTICS_PROVIDER),
  ]);

  const state: DiagnosticsKeyState = !row
    ? "not_configured"
    : needsReentry
      ? "needs_reentry"
      : "saved";

  return { state, keySetAt: row?.updatedAt.toISOString() ?? null };
}

/**
 * One readiness blocker code. The closed, ordered catalogue — and the exact meaning
 * of each code as the model is given it — lives in `ai-diagnostics-blockers.ts`.
 */
export type DiagnosticsBlocker = (typeof DIAGNOSTICS_BLOCKER_CODES)[number];

/**
 * Whether the club's AI Diagnostics module flag is on, off, or UNKNOWN.
 *
 * `null` is the answer that did not exist before #2803, and it is the point of this
 * type: "we could not read the setting" is not "the setting is off". Anything that
 * renders this must treat `null` as *unknown* — never as `false`, and never as a
 * reason to tell an operator to switch a module on that may already be on.
 */
export type DiagnosticsModuleFlagState = boolean | null;

/**
 * READ THE CLUB'S MODULE FLAG FOR READINESS, tri-state (#2803).
 *
 * The STRICT loader, with the catch here rather than inside it. That is the whole
 * fix: `loadEffectiveModuleFlags` returns every flag `false` on any error, so a
 * single transient timeout on that one query — or a blue/green window where the
 * deployed client selects a `ClubModuleSettings` column the migration has not added
 * yet — used to reach readiness as a confident "the module is off", with every other
 * read succeeding and nothing on the row marking a fault.
 *
 * It still never throws, and that is deliberate and load-bearing: a readiness check
 * that cannot answer while the database is unreachable has failed at the one moment
 * it exists for. What changes is that the failure is now VISIBLE — `null` here
 * becomes `moduleEnabled: null` and a `module_flags_unreadable` blocker, distinct
 * from `module_off`.
 */
export async function readDiagnosticsModuleFlag(): Promise<DiagnosticsModuleFlagState> {
  try {
    const flags = await loadEffectiveModuleFlagsStrict();
    return flags.aiDiagnostics === true;
  } catch (err) {
    logger.error(
      { err },
      "Failed to read club module settings for AI Diagnostics readiness; reporting the module state as unknown",
    );
    return null;
  }
}

export interface DiagnosticsReadiness {
  /** True ONLY when every gate passes; fail-closed on any fault. */
  ready: boolean;
  /**
   * `true` on, `false` off, and `null` when the club's module settings could not be
   * read at all (#2803) — which is reported beside a `module_flags_unreadable`
   * blocker and always blocks. A consumer must render `null` as "unknown", never as
   * "off": the two send an operator to different places.
   */
  moduleEnabled: DiagnosticsModuleFlagState;
  keyState: DiagnosticsKeyState;
  monthlyBudgetCents: number;
  /**
   * VERIFIED state of the dedicated SELECT-only role (AID-5, #2374) — the server
   * is asked what privileges the role actually holds, not merely whether the
   * environment variable is set.
   */
  databaseState: DiagnosticsDatabaseState;
  /** Ordered, plain-English reasons the product is not ready (empty when ready). */
  blockers: DiagnosticsBlocker[];
}

/**
 * Whether the AI Diagnostics product is ready to make paid calls. FAIL-CLOSED:
 * the module must be enabled, the DEDICATED key must be saved-and-decryptable,
 * and the monthly budget must be positive. Any resolution fault (DB error while
 * reading the credential state or the budget) returns `ready: false` with a
 * `resolve_error` blocker rather than throwing — a diagnostics surface that
 * cannot prove it is configured must not spend.
 *
 * This deliberately does NOT itself reserve budget or check rate limits; those
 * are per-call gates. Readiness is the stable "is this product set up" signal
 * the admin surface and the eventual product route consult before offering the
 * ask box.
 *
 * `modules.aiDiagnostics` is TRI-STATE (#2803). Pass `null` when you could not read
 * the flag — `readDiagnosticsModuleFlag` above is the one caller-side reader that
 * produces it — and the verdict says so, with `moduleEnabled: null` and a
 * `module_flags_unreadable` blocker instead of the `module_off` that used to send an
 * operator to switch on a module that was already on. It still blocks, because a
 * module state nobody could establish is not a module state that authorises spend.
 */
export async function getDiagnosticsReadiness(modules: {
  aiDiagnostics: DiagnosticsModuleFlagState;
}): Promise<DiagnosticsReadiness> {
  // `null` — the caller could not read the flag — is preserved as `null` rather
  // than collapsed by a `=== true` test, which is exactly how the unknown case used
  // to become an assertion that the module was off (#2803).
  const moduleEnabled: DiagnosticsModuleFlagState =
    modules.aiDiagnostics === null ? null : modules.aiDiagnostics === true;
  try {
    const [setup, monthlyBudgetCents, database] = await Promise.all([
      getDiagnosticsSetupState(),
      loadDiagnosticsBudgetCents(),
      // Never throws; "we could not tell" resolves to `unverified`, which blocks.
      checkDiagnosticsDatabaseReadiness(),
    ]);

    const blockers: DiagnosticsBlocker[] = [];
    // Unknown and off are DIFFERENT findings and are never both raised: one says the
    // club turned diagnostics off, the other says we could not tell.
    if (moduleEnabled === null) {
      blockers.push("module_flags_unreadable");
    } else if (!moduleEnabled) {
      blockers.push("module_off");
    }
    if (setup.state === "not_configured") {
      blockers.push("credential_not_configured");
    } else if (setup.state === "needs_reentry") {
      blockers.push("credential_needs_reentry");
    }
    if (monthlyBudgetCents <= 0) blockers.push("budget_not_set");
    if (database.state === "not_configured") {
      blockers.push("database_not_configured");
    } else if (database.state === "under_provisioned") {
      blockers.push("database_grants_missing");
    } else if (database.state !== "verified") {
      blockers.push("database_role_unsafe");
    }

    return {
      ready: blockers.length === 0,
      moduleEnabled,
      keyState: setup.state,
      monthlyBudgetCents,
      databaseState: database.state,
      blockers,
    };
  } catch {
    // Fail closed: if we cannot resolve the credential state, the budget or the
    // database role we cannot prove the product is configured, so it is not ready.
    return {
      ready: false,
      moduleEnabled,
      keyState: "not_configured",
      monthlyBudgetCents: 0,
      databaseState: "unverified",
      blockers: ["resolve_error"],
    };
  }
}
