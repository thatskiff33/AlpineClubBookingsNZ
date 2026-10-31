import "server-only";

import {
  getIntegrationCredentialValue,
  invalidateProviderCredentialCache,
  setIntegrationCredentialInTransaction,
} from "@/lib/integration-credentials";
import logger from "@/lib/logger";
import { ServerNzVersionMismatchError, registerPushTarget } from "@/lib/servernz-api";
import { SERVERNZ_CREDENTIAL_KEYS, SERVERNZ_PROVIDER } from "@/lib/servernz-config";
import {
  ServerNzConnectionChangedError,
  serverNzAnswerWriter,
} from "@/lib/servernz-version-record";

/*
 * The shared-post push registration (epic #2992), apart from the mirror pass
 * that calls it first (`runMirrorSync`, `club-post-mirror.ts`) since #4470
 * fenced its secret on the connection it registered with.
 */

/**
 * Make sure the central server knows where to push for this install.
 *
 * Idempotent and cheap to call from the sync pass: it does nothing when a
 * secret is already stored. The callback URL is derived from NEXTAUTH_URL —
 * the address this install already knows itself by — so there is no second
 * base-URL setting to drift.
 *
 * A server address move removes the stored secret (#4470), so the next pass
 * registers with the new server. The secret is stored through the connection
 * fence for the identity the registration was sent on: one registered with a
 * connection replaced while the request was out is the old server's, and is
 * dropped rather than stored, so it cannot stop that re-registration.
 */
export async function ensurePushRegistration(): Promise<void> {
  const existing = await getIntegrationCredentialValue(
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.pushSecret,
  );
  if (existing) return;

  const base = process.env.NEXTAUTH_URL?.trim();
  // Push needs a URL the central server can reach over https; a localhost dev
  // install simply stays poll-only, which loses nothing but latency.
  if (!base || !base.startsWith("https://")) return;

  const callback = new URL("/api/webhooks/servernz-posts", base).toString();
  try {
    const result = await registerPushTarget(callback);
    try {
      await serverNzAnswerWriter(result.sentOn)((tx) =>
        setIntegrationCredentialInTransaction({
          tx,
          provider: SERVERNZ_PROVIDER,
          key: SERVERNZ_CREDENTIAL_KEYS.pushSecret,
          value: result.secret,
          actor: { kind: "system", actor: "servernz-push-registration" },
          // Declared last-writer-wins, and deliberately NOT create-only (#2723).
          // `registerPushTarget` is a PUT: the central server keeps the most
          // recent registration and issues it a new secret version. So if two
          // containers both register, the secret worth storing is the LAST one
          // issued — refusing to overwrite would leave this install holding a
          // superseded secret and rejecting every push the server signs.
          expect: { expect: "any" },
        }),
      );
    } finally {
      // The fenced transaction is not the store's own, so this process's
      // cached copy is dropped here, after it has ended either way.
      invalidateProviderCredentialCache(SERVERNZ_PROVIDER);
    }
    logger.info(
      { callback, secretVersion: result.secretVersion },
      "Registered this install for shared-post pushes",
    );
  } catch (error) {
    // A version pause is the pass's answer, not registration's: let the pass
    // report it (#49 review item 1).
    if (error instanceof ServerNzVersionMismatchError) throw error;
    if (error instanceof ServerNzConnectionChangedError) {
      // Nothing stored: the next pass registers on the connection now stored.
      logger.warn(
        "The Alpine Central Server connection changed while this install registered for pushes; the secret was not stored, and the next sync registers again",
      );
      return;
    }
    // Poll-only is a working state, so registration failing must not fail the
    // sync pass that attempted it.
    logger.warn({ err: error }, "Could not register the shared-post push target");
  }
}
