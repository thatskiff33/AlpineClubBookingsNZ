/**
 * Encrypted integration credential store (guided provider setup — #2079).
 *
 * The database is the ONLY source of provider credentials. This module is the
 * shared surface every guided-setup lane (Xero here; Stripe/Google/Backup
 * later) reads and writes through: write-only setters, cache-aware async
 * getters, the canonical per-provider STATE MODEL, and the unified re-entry
 * aggregate.
 *
 * CROSS-PROCESS CACHE (binding contract — issue #2079):
 * production runs three containers (blue/green web slots + cron-leader,
 * docker-compose.yml). A wizard write lands in one web slot; the cron-leader
 * (Xero sync, payment sync, backups) must observe it without a restart. So:
 *   - entries carry a SHORT TTL (CACHE_TTL_MS, 30-60s) — a fresh write is
 *     visible to a cold reader in another process within the TTL;
 *   - the writing process invalidates its own cache immediately;
 *   - NEGATIVE results ("provider not configured") are cached, but only for the
 *     TTL — they expire, they are never remembered indefinitely;
 *   - a DB ERROR is never converted into a remembered negative: the error
 *     propagates and nothing is cached.
 * The derived key + decrypt are synchronous (integration-crypto.ts); only the
 * ciphertext fetch here is async.
 */

import type { IntegrationCredential } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  applyCredentialWrite,
  readRowForWrite,
  type CredentialRowWrite,
} from "@/lib/integration-credential-claim";
import {
  assertCredentialActor,
  assertCredentialDeleteExpectation,
  assertCredentialWriteExpectation,
  credentialActorMemberId,
  credentialVersionOf,
  describeCredentialExpectation,
  recordCredentialMutation,
  CREDENTIAL_AUDIT_ACTIONS,
  StaleCredentialWriteError,
  type CredentialActor,
  type CredentialDeleteExpectation,
  type CredentialRequestContext,
  type CredentialVersion,
  type CredentialWriteExpectation,
} from "@/lib/integration-credential-actor";
import {
  CredentialDecryptError,
  INTEGRATION_CREDENTIAL_LABEL,
  decryptCredential,
  encryptCredential,
  getAuthSecretWithSource,
  type AuthSecretSource,
} from "@/lib/integration-crypto";

/** Cross-process cache TTL. Kept inside the binding 30-60s window. */
export const CACHE_TTL_MS = 45_000;

interface CachedProvider {
  fetchedAt: number;
  rows: Map<string, IntegrationCredential>;
}

// Module-scoped, per-process cache. Cleared on write in the writing process;
// other processes re-read once their entry ages past the TTL.
const providerCache = new Map<string, CachedProvider>();

/** test seam — reset the in-process cache between tests. */
export function resetIntegrationCredentialCacheForTests(): void {
  providerCache.clear();
}

/** Drop a provider's cached rows immediately (called after any write). */
export function invalidateProviderCredentialCache(provider: string): void {
  providerCache.delete(provider);
}

/**
 * Load a provider's credential rows, cache-aware. A DB error propagates and is
 * NOT cached (never remembered as a negative). An empty result IS cached (a
 * bounded negative that expires at the TTL).
 */
async function loadProviderRows(
  provider: string,
  now: number = Date.now(),
): Promise<Map<string, IntegrationCredential>> {
  const cached = providerCache.get(provider);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rows;
  }
  // A throw here (DB unreachable) propagates without touching the cache.
  const rows = await prisma.integrationCredential.findMany({
    where: { provider },
  });
  const map = new Map(rows.map((row) => [row.key, row]));
  providerCache.set(provider, { fetchedAt: now, rows: map });
  return map;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type CredentialResolution =
  | {
      status: "configured";
      value: string;
      secretSource: AuthSecretSource;
      /** Value unchanged, but the secret env var it was written under flipped. */
      sourceFlipped: boolean;
      labelVersion: string;
      /**
       * Optimistic-concurrency token for the row this value came from (#2723).
       * Hand it back as `{ expect: "version", version }` to make a
       * read-modify-write lose deterministically if anybody else got in first.
       */
      version: CredentialVersion;
    }
  | { status: "not_configured" }
  | {
      status: "needs_reentry";
      reason: string;
      /** Same token, for the dead row — a replacement can still CAS on it. */
      version: CredentialVersion;
    };

/**
 * Resolve one credential. Distinguishes:
 *   - configured (decrypts; may flag a secret-source flip),
 *   - not_configured (no row),
 *   - needs_reentry (row present but GCM fails — the auth secret changed).
 * A DB error propagates to the caller (it is neither "not configured" nor a
 * decrypt failure).
 */
export async function resolveIntegrationCredential(
  provider: string,
  key: string,
): Promise<CredentialResolution> {
  const rows = await loadProviderRows(provider);
  const row = rows.get(key);
  if (!row) return { status: "not_configured" };

  try {
    const value = decryptCredential({
      provider: row.provider,
      key: row.key,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      labelVersion: row.labelVersion,
    });
    const currentSource = getAuthSecretWithSource()?.source;
    return {
      status: "configured",
      value,
      secretSource: row.secretSource as AuthSecretSource,
      sourceFlipped:
        currentSource !== undefined && currentSource !== row.secretSource,
      labelVersion: row.labelVersion,
      version: credentialVersionOf(row),
    };
  } catch (error) {
    if (error instanceof CredentialDecryptError) {
      return {
        status: "needs_reentry",
        reason: error.message,
        version: credentialVersionOf(row),
      };
    }
    throw error;
  }
}

/**
 * Convenience: the decrypted value, or null when the credential is missing OR
 * unreadable (needs re-entry). Resolvers that only need the value use this; a
 * DB error still propagates.
 */
export async function getIntegrationCredentialValue(
  provider: string,
  key: string,
): Promise<string | null> {
  const resolution = await resolveIntegrationCredential(provider, key);
  return resolution.status === "configured" ? resolution.value : null;
}

// ---------------------------------------------------------------------------
// Write (Full-Admin only — enforced at the API boundary)
// ---------------------------------------------------------------------------

/**
 * THE WRITE CONTRACT (#2723). Four rules, and each is structural rather than
 * remembered:
 *
 *  1. EVERY mutator takes a REQUIRED `actor`, so a write with no attribution
 *     does not compile. `integration-credential-actor.ts` owns the vocabulary
 *     and says why "no actor" and "a background writer" must not look alike.
 *  2. EVERY mutator takes a REQUIRED `expect`, so what a writer believed was
 *     stored is declared at the call site. A stale write LOSES — it throws
 *     `StaleCredentialWriteError`, changes nothing and audits nothing — rather
 *     than silently overwriting whoever got there first.
 *  3. THE SECRET CHANGE AND ITS AUDIT ROW ARE ONE LOCAL TRANSACTION. Before
 *     this, the credential landed in one statement and its audit row in another
 *     (in a different module, after two more awaits), so a crash between them
 *     left a rewritten secret with no evidence. `createAuditLog` takes the
 *     transaction client, so the pair commits or neither does.
 *  4. NO PLAINTEXT LEAVES THIS MODULE. The audit payload is built by
 *     `buildCredentialAuditEvidence` from a type with no field able to hold a
 *     value, the errors thrown here carry none, and nothing here logs. That is
 *     a property of the shapes, not of the care taken — which matters, because
 *     a redaction rule living in the logger is blind to every door that never
 *     calls the logger.
 *
 * AND A READ MUST NOT AUDIT. Every audit row below is written only where a row
 * actually changed: a no-op `ensureGeneratedCredential` on a healthy key (which
 * runs on the Xero token READ path) and a delete that matched nothing write
 * nothing at all.
 */

export interface SetCredentialResult {
  provider: string;
  key: string;
  secretSource: AuthSecretSource;
  labelVersion: string;
  updatedAt: Date;
  /** The token of the row as it now stands, for a follow-on compare-and-set. */
  version: CredentialVersion;
}

/**
 * Encrypt and persist a credential. Invalidates the writing process's cache
 * immediately once the transaction commits.
 *
 * The capture-time strong-secret gate runs inside `encryptCredential` BEFORE the
 * transaction opens — a weak/placeholder secret throws `WeakAuthSecretError`,
 * nothing is written and nothing is audited.
 *
 * COMPARE-AND-SET, by the expectation the caller declared:
 *   absent  → `create`; a P2002 means somebody created it first and we lose.
 *   version → the row is re-read inside the transaction, its token compared,
 *             and the update CLAIMED on the exact `(ciphertext, iv, authTag)`
 *             tuple that was read. A concurrent writer changes that tuple (every
 *             encrypt draws a fresh random IV), so the loser's claim matches
 *             zero rows and it re-reads instead of clobbering — the discipline
 *             `replaceUnreadableCredential` below has used since #2079.
 *   any     → a declared unconditional overwrite, for the sole authority of a
 *             (provider, key) that has nothing to be stale against.
 *
 * Note the VERIFY-RESET rule (any credential write clears the provider's
 * verified/connected state) is applied by the caller that knows the provider's
 * verified-state store — e.g. the Xero write path drops stored OAuth tokens so
 * the operator re-connects. This module owns only the encrypted value.
 */
export async function setIntegrationCredential(params: {
  provider: string;
  key: string;
  value: string;
  actor: CredentialActor;
  expect: CredentialWriteExpectation;
  label?: string;
  request?: CredentialRequestContext;
}): Promise<SetCredentialResult> {
  assertCredentialActor(CREDENTIAL_AUDIT_ACTIONS.set, params.actor);
  assertCredentialWriteExpectation(CREDENTIAL_AUDIT_ACTIONS.set, params.expect);

  const label = params.label ?? INTEGRATION_CREDENTIAL_LABEL;
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label,
  });
  const written: CredentialRowWrite = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    secretSource: encrypted.secretSource,
    labelVersion: encrypted.labelVersion,
    updatedByUserId: credentialActorMemberId(params.actor),
  };

  try {
    const result = await prisma.$transaction(
      async (tx): Promise<SetCredentialResult> => {
        const updatedAt = await applyCredentialWrite(tx, {
          provider: params.provider,
          key: params.key,
          expectation: params.expect,
          written,
        });

        await recordCredentialMutation(tx, {
          action: CREDENTIAL_AUDIT_ACTIONS.set,
          summary: `Set ${params.provider} credential "${params.key}"`,
          actor: params.actor,
          provider: params.provider,
          key: params.key,
          expectation: describeCredentialExpectation(params.expect),
          secretSource: encrypted.secretSource,
          labelVersion: encrypted.labelVersion,
          request: params.request,
        });

        return {
          provider: params.provider,
          key: params.key,
          secretSource: encrypted.secretSource,
          labelVersion: encrypted.labelVersion,
          updatedAt,
          version: credentialVersionOf(written),
        };
      },
    );
    invalidateProviderCredentialCache(params.provider);
    return result;
  } catch (error) {
    // A lost claim rolled the transaction back, so the cached rows are still
    // whatever the winner wrote. Drop them so the caller's re-read is fresh.
    if (error instanceof StaleCredentialWriteError) {
      invalidateProviderCredentialCache(params.provider);
    }
    throw error;
  }
}


/**
 * What a delete is claiming, as a VALUE rather than as a convention.
 *
 * A zero row count means two different things here, and the first draft told
 * them apart by asking whether a claim ciphertext had been assigned — a reader
 * had to know that `undefined` meant "unconditional" and could not see the rule
 * being relied on. Two named shapes make the discrimination the type's job, and
 * carry the claimed columns with the branch that has them.
 */
type CredentialDeleteClaim =
  | { readonly kind: "unconditional" }
  | {
      readonly kind: "version";
      readonly ciphertext: string;
      readonly iv: string;
      readonly authTag: string;
    };

/**
 * Delete a single credential row (used by disconnect and verify-reset flows).
 *
 * Deleting nothing is a no-op, NOT an error and NOT an audit row: verify-reset
 * fires on every credential write whether or not a marker was ever stamped, and
 * a row per no-op would bury the real deletions.
 */
export async function deleteIntegrationCredential(params: {
  provider: string;
  key: string;
  actor: CredentialActor;
  expect: CredentialDeleteExpectation;
  request?: CredentialRequestContext;
}): Promise<void> {
  assertCredentialActor(CREDENTIAL_AUDIT_ACTIONS.deleted, params.actor);
  assertCredentialDeleteExpectation(
    CREDENTIAL_AUDIT_ACTIONS.deleted,
    params.expect,
  );
  const expectation = params.expect;

  try {
    await prisma.$transaction(async (tx) => {
      let claim: CredentialDeleteClaim = { kind: "unconditional" };
      if (expectation.expect === "version") {
        const current = await readRowForWrite(tx, params.provider, params.key);
        // Already gone. The caller wanted it absent and it is absent, so this
        // is the intended end state rather than a lost race.
        if (current === null) return;
        if (credentialVersionOf(current) !== expectation.version) {
          throw new StaleCredentialWriteError({
            provider: params.provider,
            key: params.key,
            expectation,
            observedVersion: credentialVersionOf(current),
          });
        }
        claim = {
          kind: "version",
          ciphertext: current.ciphertext,
          iv: current.iv,
          authTag: current.authTag,
        };
      }

      const removed = await tx.integrationCredential.deleteMany({
        where: {
          provider: params.provider,
          key: params.key,
          // THE CLAIM, when a version was declared, and it names ALL THREE
          // encrypted columns — the same tuple `applyCredentialWrite` claims.
          //
          // Claiming the ciphertext alone is nearly always enough and is exactly
          // wrong for one value: AES-GCM over an EMPTY plaintext produces an
          // empty ciphertext whatever the IV, so for a credential holding "" the
          // stored ciphertext is "" before and after any replacement and a
          // ciphertext-only claim matches the winner's row. The writer holding
          // the stale token would then delete the row that replaced it and
          // report success — a lost race reported as a win, which is the exact
          // failure this contract exists to remove. The iv and authTag are fresh
          // on every encrypt whatever the plaintext, so the three together are a
          // real fence for every value. When this was written no production
          // delete took this path — they all passed `any` — and the claim was
          // that #2940 would be the store's first club-editable consumer. It
          // is: `clearMirotalkSecret` passes the version the setup screen was
          // shown, because Clear is a genuine read-modify-write and deleting
          // whatever replaced the secret while reporting success is the failure
          // this whole contract exists to remove.
          ...(claim.kind === "unconditional"
            ? {}
            : {
                ciphertext: claim.ciphertext,
                iv: claim.iv,
                authTag: claim.authTag,
              }),
        },
      });
      if (removed.count === 0) {
        // Removing nothing means two different things, and they must not be
        // spelled the same way. Under `any` the caller asked for the row to be
        // gone and it is gone — verify-reset fires on every credential write
        // whether or not a marker was ever stamped, so a no-op is the common
        // case and neither an error nor an audit row. Under `version` the row
        // was there a statement ago and somebody replaced it since, which is a
        // LOST RACE, and losing silently is the behaviour this whole contract
        // exists to remove.
        if (claim.kind === "version") {
          const winner = await readRowForWrite(tx, params.provider, params.key);
          throw new StaleCredentialWriteError({
            provider: params.provider,
            key: params.key,
            expectation,
            observedVersion:
              winner === null ? null : credentialVersionOf(winner),
          });
        }
        return;
      }

      await recordCredentialMutation(tx, {
        action: CREDENTIAL_AUDIT_ACTIONS.deleted,
        summary: `Deleted ${params.provider} credential "${params.key}"`,
        actor: params.actor,
        provider: params.provider,
        key: params.key,
        expectation: describeCredentialExpectation(expectation),
        request: params.request,
      });
    });
  } finally {
    invalidateProviderCredentialCache(params.provider);
  }
}

// ---------------------------------------------------------------------------
// Canonical per-provider state model (shared — consumed by C2..C6)
// ---------------------------------------------------------------------------

/**
 * Canonical states a provider's setup can be in. Every guided-setup lane renders
 * from this one enum so the Integrations hub, readiness, and each wizard agree.
 *
 *   not_configured   → no credentials stored yet
 *   saved_unverified → credentials stored, not yet proven to work
 *   verified         → credentials stored AND verified/connected
 *   webhooks_amber   → connected, but the webhook subscription is unverified
 *   needs_reentry    → a stored credential fails GCM (the auth secret changed)
 *
 * VERIFY-RESET (epic decision 6): any credential write drops the provider out
 * of `verified`/`webhooks_amber` back to `saved_unverified` and re-arms
 * verification. The verified-state store lives with each provider; this enum is
 * the shared vocabulary.
 */
export type ProviderCredentialState =
  | "not_configured"
  | "saved_unverified"
  | "verified"
  | "webhooks_amber"
  | "needs_reentry";

/**
 * Does a provider have any stored credential that fails to decrypt? Drives the
 * unified "N integrations need credentials re-entered (encryption key changed)"
 * aggregate everywhere (readiness + Integrations hub) off ONE detection path.
 *
 * A DB error propagates (the caller decides how to surface an unknown state);
 * a `not_configured` provider is simply not "needing re-entry".
 */
export async function providerNeedsReentry(provider: string): Promise<boolean> {
  const rows = await loadProviderRows(provider);
  if (rows.size === 0) return false;
  const currentSecret = getAuthSecretWithSource();
  if (!currentSecret) return true; // rows exist but nothing can decrypt them
  for (const row of rows.values()) {
    try {
      decryptCredential({
        provider: row.provider,
        key: row.key,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        labelVersion: row.labelVersion,
      });
    } catch (error) {
      if (error instanceof CredentialDecryptError) return true;
      throw error;
    }
  }
  return false;
}

/**
 * The subset of the given providers whose stored credentials fail GCM. Powers
 * the shared re-entry aggregate. Providers with no stored credentials never
 * appear. Propagates a DB error.
 */
export async function getIntegrationsNeedingReentry(
  providers: readonly string[],
): Promise<string[]> {
  const needing: string[] = [];
  for (const provider of providers) {
    if (await providerNeedsReentry(provider)) needing.push(provider);
  }
  return needing;
}
