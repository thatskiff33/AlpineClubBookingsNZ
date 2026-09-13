/**
 * CLAIMING one credential row under a declared expectation (#2723).
 *
 * This module is the compare-and-set mechanism and nothing else: it knows about
 * rows, not about encryption, audit or who is writing. The store
 * (`integration-credentials.ts`) composes it with those; keeping the claim here
 * means the rule "a stale write loses" can be read, and tested, without reading
 * the store's transaction plumbing around it.
 *
 * WHY A TUPLE CLAIM AND NOT A `version Int` COLUMN: `integration-credential-actor.ts`
 * -> `CredentialVersion`. The short version is that every encrypt draws a fresh
 * random IV, so the stored `(ciphertext, iv, authTag)` tuple already changes on
 * every write — a stronger discriminator than a counter, needing no column and
 * no trigger — and this is the discipline `replaceUnreadableCredential` has used
 * since #2079.
 */

import type { IntegrationCredential, Prisma } from "@prisma/client";

import {
  credentialVersionOf,
  StaleCredentialWriteError,
  type CredentialWriteExpectation,
} from "@/lib/integration-credential-actor";
import type { AuthSecretSource } from "@/lib/integration-crypto";

/** The encrypted columns one write lands, plus its attribution. */
export interface CredentialRowWrite {
  ciphertext: string;
  iv: string;
  authTag: string;
  secretSource: AuthSecretSource;
  labelVersion: string;
  updatedByUserId: string | null;
}

/** The stored row, or `null`, read through the given client. */
export async function readRowForWrite(
  db: Prisma.TransactionClient,
  provider: string,
  key: string,
): Promise<IntegrationCredential | null> {
  return db.integrationCredential.findUnique({
    where: { provider_key: { provider, key } },
  });
}

/**
 * Apply the row change under the declared expectation, returning the row's new
 * `updatedAt`. Throws `StaleCredentialWriteError` — rolling the transaction
 * back, so the audit row above never lands for a write that did not happen — if
 * the expectation did not hold.
 */
export async function applyCredentialWrite(
  tx: Prisma.TransactionClient,
  params: {
    provider: string;
    key: string;
    expectation: CredentialWriteExpectation;
    written: CredentialRowWrite;
  },
): Promise<Date> {
  const { provider, key, expectation, written } = params;

  if (expectation.expect === "any") {
    const row = await tx.integrationCredential.upsert({
      where: { provider_key: { provider, key } },
      create: { provider, key, ...written },
      update: written,
    });
    return row.updatedAt;
  }

  if (expectation.expect === "absent") {
    // READ BEFORE THE CREATE, and not only as an optimisation. A failed
    // statement puts a PostgreSQL transaction into the aborted state, where
    // every later statement fails with 25P02 — so reading the winner AFTER
    // catching the unique violation, which is the obvious shape, would replace
    // this writer's clean "you lost" with a driver error about a transaction it
    // cannot use. The ordinary case (somebody got there first, and their row is
    // sitting there to be read) is answered here with the winner's real version.
    const existing = await readRowForWrite(tx, provider, key);
    if (existing !== null) {
      throw new StaleCredentialWriteError({
        provider,
        key,
        expectation,
        observedVersion: credentialVersionOf(existing),
      });
    }
    try {
      const row = await tx.integrationCredential.create({
        data: { provider, key, ...written },
      });
      return row.updatedAt;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // A true race: the row appeared between the read above and this insert.
      // The transaction is now aborted, so this writer cannot report the
      // winner's version — `null` says "unknown from here", and the caller's
      // cache is dropped so its re-read is fresh.
      throw new StaleCredentialWriteError({
        provider,
        key,
        expectation,
        observedVersion: null,
      });
    }
  }

  const current = await readRowForWrite(tx, provider, key);
  if (current === null || credentialVersionOf(current) !== expectation.version) {
    throw new StaleCredentialWriteError({
      provider,
      key,
      expectation,
      observedVersion: current === null ? null : credentialVersionOf(current),
    });
  }
  // The CLAIM. Keyed on the exact tuple just read, so a writer that committed
  // between the read above and this statement has already changed the tuple and
  // this matches zero rows. Postgres re-evaluates the predicate after taking the
  // row lock, so of two writers holding the same token exactly one wins.
  const claimed = await tx.integrationCredential.updateMany({
    where: {
      provider,
      key,
      ciphertext: current.ciphertext,
      iv: current.iv,
      authTag: current.authTag,
    },
    data: written,
  });
  if (claimed.count !== 1) {
    const winner = await readRowForWrite(tx, provider, key);
    throw new StaleCredentialWriteError({
      provider,
      key,
      expectation,
      observedVersion: winner === null ? null : credentialVersionOf(winner),
    });
  }
  const updated = await readRowForWrite(tx, provider, key);
  return updated?.updatedAt ?? new Date();
}

/**
 * True for a Prisma unique-constraint conflict (P2002). Detected structurally
 * (by `code`) so a raced insert is tolerated regardless of how the driver
 * surfaces it — same shape as `isUniqueConstraintError` in config-self-heal,
 * inlined here to keep this module free of that boot module's imports.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
