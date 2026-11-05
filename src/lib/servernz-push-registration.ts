import "server-only";

import {
  getIntegrationCredentialValue,
  invalidateProviderCredentialCache,
  setIntegrationCredentialInTransaction,
} from "@/lib/integration-credentials";
import { getAppBaseUrl } from "@/lib/app-url";
import type { CredentialActor } from "@/lib/integration-credential-actor";
import logger from "@/lib/logger";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
  registerPushTarget,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import { SERVERNZ_CREDENTIAL_KEYS, SERVERNZ_PROVIDER } from "@/lib/servernz-config";
import {
  ServerNzConnectionChangedError,
  serverNzAnswerWriter,
} from "@/lib/servernz-version-record";

/*
 * The shared-post push registration (epic #2992), apart from the mirror pass
 * that calls it first (`runMirrorSync`, `club-post-mirror.ts`) since #4470
 * fenced its secret on the connection it registered with. The API key save
 * calls it too, once the key has committed (`registerAfterKeySave`,
 * triyder/AlpineClubBookingsNZ#97), so the setup page can say how it went.
 */

/**
 * One registration's outcome. `awaiting-approval` is the server's 403 for a
 * pending or suspended club. It, `no-address` and `failed` (a connection
 * replaced in flight included) are retried by the next mirror pass.
 */
export type PushRegistrationOutcome =
  | "registered"
  | "already-registered"
  | "not-https"
  | "no-address"
  | "awaiting-approval"
  | "failed";

/** Who stores the secret when the mirror pass registers. */
const MIRROR_PASS_ACTOR: CredentialActor = { kind: "system", actor: "servernz-push-registration" };

/**
 * Make sure the central server knows where to push for this install.
 *
 * Idempotent and cheap to call from the sync pass: it does nothing while the
 * stored secret was issued for this site's CURRENT callback address. The
 * callback URL is derived from this install's own address (`getAppBaseUrl`,
 * which reads NEXTAUTH_URL), so there is no second base-URL setting to drift.
 * When that address moves, the stored one no longer matches and the site
 * registers again; otherwise the server would keep pushing to, and asking free
 * beds of, a host that no longer answers. A secret stored before its address
 * was kept beside it registers once more. Registering again is safe: the
 * server keeps the same secret for a repeat of the same URL and rotates it
 * only when the URL changes, and either way the secret it returns is stored.
 * An address that is not https never replaces a working registration.
 *
 * A server address move removes the stored secret (#4470), so the next pass
 * registers with the new server. The secret is stored through the connection
 * fence for the identity the registration was sent on: one registered with a
 * connection replaced while the request was out is the old server's, and is
 * dropped rather than stored, so it cannot stop that re-registration.
 *
 * The secret is written as `actor`: the mirror pass's system actor, or the
 * administrator whose key save started the registration (#4720 review).
 */
export async function ensurePushRegistration(
  actor: CredentialActor = MIRROR_PASS_ACTOR,
): Promise<PushRegistrationOutcome> {
  const base = getAppBaseUrl();
  // Push needs a URL the central server can reach over https; a localhost dev
  // install simply stays poll-only, which loses nothing but latency.
  const callback = base.startsWith("https://")
    ? new URL("/api/webhooks/servernz-posts", base).toString()
    : null;

  const existing = await getIntegrationCredentialValue(
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.pushSecret,
  );
  if (existing) {
    if (callback === null) return "already-registered";
    const registeredUrl = await getIntegrationCredentialValue(
      SERVERNZ_PROVIDER,
      SERVERNZ_CREDENTIAL_KEYS.pushRegisteredUrl,
    );
    if (registeredUrl === callback) return "already-registered";
    logger.info(
      { callback, previous: registeredUrl ?? null },
      "This site's push address changed since it registered; registering again",
    );
  }
  if (callback === null) return "not-https";

  try {
    const result = await registerPushTarget(callback);
    try {
      // The secret and the address it was issued for, in ONE fenced write, so
      // a stored secret is never paired with another registration's address.
      await serverNzAnswerWriter(result.sentOn)(async (tx) => {
        for (const [key, value] of [
          [SERVERNZ_CREDENTIAL_KEYS.pushSecret, result.secret],
          [SERVERNZ_CREDENTIAL_KEYS.pushRegisteredUrl, callback],
        ] as const) {
          await setIntegrationCredentialInTransaction({
            tx,
            provider: SERVERNZ_PROVIDER,
            key,
            value,
            actor,
            // Declared last-writer-wins, and deliberately NOT create-only (#2723).
            // `registerPushTarget` is a PUT: the central server keeps the most
            // recent registration and issues it a new secret version. So if two
            // containers both register, the pair worth storing is the LAST one
            // issued — refusing to overwrite would leave this install holding a
            // superseded secret and rejecting every push the server signs.
            expect: { expect: "any" },
          });
        }
      });
    } finally {
      // The fenced transaction is not the store's own, so this process's
      // cached copy is dropped here, after it has ended either way.
      invalidateProviderCredentialCache(SERVERNZ_PROVIDER);
    }
    logger.info(
      { callback, secretVersion: result.secretVersion },
      "Registered this install for shared-post pushes",
    );
    return "registered";
  } catch (error) {
    // A version pause is the pass's answer, not registration's: let the pass
    // report it (#49 review item 1).
    if (error instanceof ServerNzVersionMismatchError) throw error;
    if (error instanceof ServerNzConnectionChangedError) {
      // Nothing stored: the next pass registers on the connection now stored.
      logger.warn(
        "The Alpine Central Server connection changed while this install registered for pushes; the secret was not stored, and the next sync registers again",
      );
      return "failed";
    }
    // Poll-only is a working state, so registration failing must not fail the
    // sync pass that attempted it.
    logger.warn({ err: error }, "Could not register the shared-post push target");
    if (error instanceof ServerNzNotConfiguredError) return "no-address";
    // A pending or suspended club's key is refused with 403.
    return error instanceof ServerNzApiError && error.status === 403
      ? "awaiting-approval"
      : "failed";
  }
}

/**
 * Register straight after an API key save, as an outcome for the setup page
 * (triyder/AlpineClubBookingsNZ#97). The key save's fenced transaction has
 * committed, and removed the replaced connection's secret
 * (`clearServerNzPushSecret`), before this runs, so the registration is made
 * with the key just stored. The secret is stored in the name of `memberId`,
 * the administrator who saved the key. Never throws: the key is stored
 * whatever this comes to, and the next mirror pass retries.
 */
export async function registerAfterKeySave(memberId: string): Promise<
  PushRegistrationOutcome | typeof SERVER_VERSION_MISMATCH_CODE
> {
  try {
    return await ensurePushRegistration({ kind: "admin", memberId });
  } catch (error) {
    if (error instanceof ServerNzVersionMismatchError) return SERVER_VERSION_MISMATCH_CODE;
    logger.warn({ err: error }, "Push registration after a key save failed");
    return "failed";
  }
}
