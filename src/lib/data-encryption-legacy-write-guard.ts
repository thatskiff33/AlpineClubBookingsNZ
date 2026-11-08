/**
 * One rule for every writer of stored secret data (#4456 review): no write
 * falls back to `AUTH_SECRET` while stored data already names a ring key.
 *
 * With no `DATA_ENCRYPTION_KEYS` set, a write uses the legacy key, the auth
 * secret. That is right for a club that never set a ring. But if any stored
 * row already names a ring key, the ring was set and has since been unset or
 * lost (a bad `.env` edit, a colour started without it, a copy restored from a
 * backup). Writing now would quietly put new secrets back under the session
 * secret the ring exists to keep them away from, and the rows under the ring
 * stay unreadable either way. So every such writer asks here first, and is
 * refused until the ring is restored or a new key is set.
 *
 * The writers: credential capture and the Xero refresh pre-flight
 * (`integration-credentials.ts`, `xero-token-errors.ts`), and two-factor
 * enrolment and recovery-code replacement (`two-factor.ts`). The evidence is
 * the durable stores: credentials, authenticator secrets and recovery codes.
 * Email codes and session challenges live minutes, so they are neither evidence
 * of a ring that was once set nor refused: a legacy one leaves nothing behind.
 *
 * `ringKeyedDataExists` is the ONE definition of "stored data names a ring
 * key": the setup step's ring-unset verdict reads its answer too, through the
 * snapshot (`setup-readiness-db.ts`), so the step and the writers never
 * disagree about whether the ring is missing.
 */

import type { Prisma } from "@prisma/client";

import { DATA_ENCRYPTION_KEYS_ENV } from "@/lib/data-encryption-key-material";
import { DATA_KEY_SOURCE_PREFIX, WeakAuthSecretError } from "@/lib/integration-crypto";
import { exactContains, exactPrefix } from "@/lib/prisma-exact-prefix";
import { RETIRED_RECOVERY_CODE_KEY_ID, RING_ENCRYPTION_VERSION } from "@/lib/two-factor-key-format";

/**
 * A legacy write refused because stored data names a ring key and no ring is
 * set. A `WeakAuthSecretError` (the key a write would use is unusable), so the
 * credential routes already show its message; its own class lets the Xero
 * refresh name the cause rather than blame the auth secret.
 */
export class DataKeyRingMissingError extends WeakAuthSecretError {
  constructor() {
    super(
      `Stored data is encrypted under a data-encryption key, but ${DATA_ENCRYPTION_KEYS_ENV} is not set. Set it back as it was, or set a new key and re-enter the credentials and re-enrol the authenticators the old one held; until then no credential, authenticator or recovery code is saved under AUTH_SECRET alone.`,
    );
    this.name = "DataKeyRingMissingError";
  }
}

type RingEvidenceReader = Pick<
  Prisma.TransactionClient,
  "integrationCredential" | "member" | "twoFactorRecoveryCode"
>;

/**
 * Does any durable stored row name a ring key? Asked in order, stopping at the
 * first yes. A ring code hash is `<id>:<hex>` and a legacy one bare hex, so a
 * `:` is the ring's mark (`two-factor-key-format.ts`) — except on a legacy code
 * the re-encrypt RETIRED, which depends on no key at all and so is no evidence
 * that a ring was ever set. Every pattern is matched literally
 * (`INV-SSOT-006`): the `_` in `DATA_ENCRYPTION_KEY:` is otherwise a `LIKE`
 * wildcard.
 */
export async function ringKeyedDataExists(db: RingEvidenceReader): Promise<boolean> {
  if ((await db.integrationCredential.count({ where: { secretSource: exactPrefix(DATA_KEY_SOURCE_PREFIX) } })) > 0) {
    return true;
  }
  if ((await db.member.count({ where: { totpSecret: exactPrefix(`${RING_ENCRYPTION_VERSION}:`) } })) > 0) {
    return true;
  }
  return (
    (await db.twoFactorRecoveryCode.count({
      where: {
        AND: [
          { codeHash: exactContains(":") },
          { NOT: { codeHash: exactPrefix(`${RETIRED_RECOVERY_CODE_KEY_ID}:`) } },
        ],
      },
    })) > 0
  );
}

/**
 * Refuse a write under the legacy key while stored data names a ring key.
 * Call it only for a write that WOULD use the legacy key; a ring write never
 * needs it. Throws `DataKeyRingMissingError`; a database error propagates.
 */
export async function assertLegacyWriteAllowed(db: RingEvidenceReader): Promise<void> {
  if (await ringKeyedDataExists(db)) throw new DataKeyRingMissingError();
}
