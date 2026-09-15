/**
 * The SELF-GENERATED credential (#2723 — lifted out of `integration-credentials.ts`).
 *
 * WHY IT IS ITS OWN MODULE. The store's other two mutators take an expectation
 * from their caller; this one does not, and cannot. A generated credential — the
 * wrapped Xero token key today — is create-only by construction, because two
 * containers generating at once must converge on ONE stored value rather than
 * overwrite each other. So the concurrency discipline is not a parameter here,
 * it IS the function, and it has three outcomes the store's `set` has no reason
 * to carry: adopt the winner of a lost create race, replace an already-dead row
 * under a claim on its exact stale tuple, and return an existing readable value
 * while auditing NOTHING, because this runs on every Xero token decrypt.
 *
 * IT IS A BOUNDARY MODULE, like `integration-credentials.ts` and
 * `integration-credential-claim.ts`: it reaches the Prisma delegate directly, so
 * `CREDENTIAL_BOUNDARY_MODULES` in the credential-actor census names it and the
 * census does not report its own statements as bypasses. Adding a module to that
 * list is a reviewed change — it is an exemption from the one check that can see
 * a writer which skips the store.
 */

import { prisma } from "@/lib/prisma";
import {
  assertCredentialActor,
  credentialActorMemberId,
  recordCredentialMutation,
  CREDENTIAL_AUDIT_ACTIONS,
  type CredentialActor,
} from "@/lib/integration-credential-actor";
import { readRowForWrite } from "@/lib/integration-credential-claim";
import {
  invalidateProviderCredentialCache,
  resolveIntegrationCredential,
} from "@/lib/integration-credentials";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import {
  encryptCredential,
  getAuthSecretWithSource,
  isAuthSecretStrongEnough,
} from "@/lib/integration-crypto";

/**
 * Ensure a self-generated credential (e.g. the wrapped Xero token key) exists,
 * returning its decrypted value — or `null` when the strength gate blocks
 * generation (NEVER throwing: this can fire from a mere module toggle).
 *
 *   - strong secret + no row      → CREATE-ONLY: `create` + catch P2002, so a
 *                                    concurrent creator's value wins (never an
 *                                    upsert / last-writer-wins across containers);
 *   - strong secret + readable row → return the existing value (never overwrite,
 *                                    and — the READ-PATH rule — audit nothing:
 *                                    this runs on every Xero token decrypt);
 *   - strong secret + unreadable row (auth secret changed) → the wrapped key is
 *     useless and would block reconnect, so replace the ALREADY-DEAD material
 *     with a fresh one — under a status-guarded `updateMany` claim so a loser
 *     re-reads the winner rather than clobbering it;
 *   - weak/placeholder secret     → no-op, return null.
 *
 * The generate path is genuinely create-only: there is no upsert here, so two
 * cron/web containers generating at once converge on ONE stored value instead of
 * silently overwriting each other (correctness F1 / ops F6 / security F3). Its
 * expectation is therefore not the caller's to choose, which is why this is the
 * one mutator with no `expect` parameter — the discipline IS the function.
 */
export async function ensureGeneratedCredential(params: {
  provider: string;
  key: string;
  label: string;
  generate: () => string;
  actor: CredentialActor;
}): Promise<string | null> {
  assertCredentialActor(CREDENTIAL_AUDIT_ACTIONS.generated, params.actor);

  if (!isAuthSecretStrongEnough(getAuthSecretWithSource()?.secret)) {
    return null; // blocked readiness check, not an exception
  }

  const existing = await resolveIntegrationCredential(params.provider, params.key);
  // A readable key is authoritative — never overwrite it, and never audit a read.
  if (existing.status === "configured") return existing.value;

  if (existing.status === "not_configured") {
    return createGeneratedCredential({
      provider: params.provider,
      key: params.key,
      label: params.label,
      value: params.generate(),
      actor: params.actor,
    });
  }

  // needs_reentry: replace the dead row via a claim keyed on the exact stale
  // tuple, so only one process rewrites a given version. READ THROUGH THE
  // DATABASE, not through the store's cache: a claim is only as good as the
  // tuple it names, and a cached row up to the TTL old would claim a version
  // that may already have been replaced. This path runs only when the auth
  // secret has changed, so the extra read costs nothing that matters.
  const staleRow = await readRowForWrite(prisma, params.provider, params.key);
  if (!staleRow) {
    // The row vanished between resolve and here — treat as create-only.
    return createGeneratedCredential({
      provider: params.provider,
      key: params.key,
      label: params.label,
      value: params.generate(),
      actor: params.actor,
    });
  }
  return replaceUnreadableCredential({
    provider: params.provider,
    key: params.key,
    label: params.label,
    value: params.generate(),
    stale: {
      ciphertext: staleRow.ciphertext,
      iv: staleRow.iv,
      authTag: staleRow.authTag,
    },
    actor: params.actor,
  });
}

/**
 * Encrypt `value` and persist it as a NEW row (create-only). Returns the winner's
 * decrypted value: on a P2002 unique race the concurrent creator won, so we
 * re-resolve and return whatever is now stored (both processes share the same
 * strong auth secret, so the winner's row is readable). Never overwrites.
 *
 * The create and its audit row are one transaction; a LOST race commits neither,
 * so a loser leaves no evidence of a write it did not make.
 */
async function createGeneratedCredential(params: {
  provider: string;
  key: string;
  label: string;
  value: string;
  actor: CredentialActor;
}): Promise<string> {
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label: params.label,
  });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.integrationCredential.create({
        data: {
          provider: params.provider,
          key: params.key,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          secretSource: encrypted.secretSource,
          labelVersion: encrypted.labelVersion,
          updatedByUserId: credentialActorMemberId(params.actor),
        },
      });
      await recordCredentialMutation(tx, {
        action: CREDENTIAL_AUDIT_ACTIONS.generated,
        summary: `Generated ${params.provider} credential "${params.key}"`,
        actor: params.actor,
        provider: params.provider,
        key: params.key,
        expectation: "absent",
        secretSource: encrypted.secretSource,
        labelVersion: encrypted.labelVersion,
      });
    });
    invalidateProviderCredentialCache(params.provider);
    return params.value;
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
    // Lost the create race — return the winner's value, not ours.
    invalidateProviderCredentialCache(params.provider);
    const winner = await resolveIntegrationCredential(params.provider, params.key);
    if (winner.status === "configured") return winner.value;
    // The winner exists but is unreadable (a different secret wrote it). The
    // material is unrecoverable; surface the original conflict rather than
    // silently returning a value nobody can use.
    throw error;
  }
}

/**
 * Replace an UNREADABLE (needs_reentry) row with a fresh value under a
 * create-or-lose discipline: a status-guarded `updateMany` claim keyed on the
 * exact stale `(ciphertext, iv, authTag)` tuple we read, so only ONE process
 * replaces a given dead row and every loser re-reads the winner's value instead
 * of clobbering it. The stale material is already unrecoverable, so we never
 * risk overwriting a live key here (that case returned above).
 *
 * ALL THREE COLUMNS, for the reason spelled out on the delete below: an empty
 * plaintext encrypts to an empty ciphertext under every IV, so a ciphertext-only
 * claim is vacuous for that one value and two processes would both believe they
 * had won. The iv and authTag are fresh on every encrypt whatever the plaintext.
 *
 * The claim and its audit row are one transaction, and the audit row is written
 * only inside the winning branch — a loser changed nothing and records nothing.
 */
async function replaceUnreadableCredential(params: {
  provider: string;
  key: string;
  label: string;
  value: string;
  stale: { ciphertext: string; iv: string; authTag: string };
  actor: CredentialActor;
}): Promise<string> {
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label: params.label,
  });
  const claimedCount = await prisma.$transaction(async (tx) => {
    const claimed = await tx.integrationCredential.updateMany({
      where: {
        provider: params.provider,
        key: params.key,
        // Claim only the exact dead row we observed. Once any process replaces
        // it the tuple changes — every encrypt draws a fresh IV, and the auth
        // tag follows it even when the ciphertext does not — so a racing
        // writer's claim matches zero rows.
        ciphertext: params.stale.ciphertext,
        iv: params.stale.iv,
        authTag: params.stale.authTag,
      },
      data: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        secretSource: encrypted.secretSource,
        labelVersion: encrypted.labelVersion,
        updatedByUserId: credentialActorMemberId(params.actor),
      },
    });
    if (claimed.count === 1) {
      await recordCredentialMutation(tx, {
        action: CREDENTIAL_AUDIT_ACTIONS.generated,
        summary: `Replaced unreadable ${params.provider} credential "${params.key}"`,
        actor: params.actor,
        provider: params.provider,
        key: params.key,
        // Not one of the caller-declared expectations: this path claims the
        // exact dead row it read, which is the same compare-and-set with a
        // discriminator the caller never holds.
        expectation: "stale-row-claim",
        secretSource: encrypted.secretSource,
        labelVersion: encrypted.labelVersion,
      });
    }
    return claimed.count;
  });
  invalidateProviderCredentialCache(params.provider);
  if (claimedCount === 1) return params.value;

  // Another process already replaced the dead row — adopt the winner's value.
  const winner = await resolveIntegrationCredential(params.provider, params.key);
  if (winner.status === "configured") return winner.value;
  // Still unreadable (the row was deleted, or replaced under a changed secret):
  // fall back to a create-only attempt so a missing row is (re)generated.
  return createGeneratedCredential(params);
}
