/**
 * The Xero VERIFY-RESET (#3454), lifted out of `xero-token-store.ts` so the token
 * store stays inside its size budget. It composes the store's own in-transaction
 * delete with the credential write that causes it; the rules for both live in
 * the token store and the credential store.
 */

import type { Prisma } from "@prisma/client";

import { withCredentialTransaction } from "@/lib/integration-credentials";
import { XERO_CREDENTIAL_KEYS, XERO_PROVIDER } from "@/lib/xero-config";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";
import {
  deleteXeroTokensInTransaction,
  XERO_OAUTH_TOKEN_PROVIDER,
  type XeroTokenWriteContext,
} from "@/lib/xero-token-store";

/**
 * Does writing this credential orphan the stored tokens? Changing the client id
 * or secret invalidates the OAuth app the tokens belong to, so they are
 * destroyed and the operator must reconnect. Changing only the webhook key does
 * NOT (that surfaces as a webhook amber badge).
 */
export function credentialWriteResetsXeroTokens(provider: string, key: string): boolean {
  return (
    provider === XERO_PROVIDER &&
    (key === XERO_CREDENTIAL_KEYS.clientId ||
      key === XERO_CREDENTIAL_KEYS.clientSecret)
  );
}

/**
 * The Xero VERIFY-RESET in ONE transaction with the write that causes it (#3454).
 *
 * Saving a Xero client id or secret invalidates the OAuth app the stored tokens
 * belong to, so the tokens are destroyed. Both are database writes and nothing
 * calls Xero, so they commit together: the credential and the destruction of
 * the grant it orphaned can never land one without the other, and the two audit
 * rows share the request and say which credential caused the reset.
 */
export async function withXeroVerifyReset<T>(
  params: XeroTokenWriteContext & {
    /** The `provider:key` whose write causes the reset. A name, never a value. */
    causedByCredential: string;
    /** Providers whose cached credential rows the write touches. */
    providers: readonly string[];
  },
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await withCredentialTransaction(
    [...params.providers, XERO_OAUTH_TOKEN_PROVIDER],
    async (tx) => {
      const written = await work(tx);
      await deleteXeroTokensInTransaction({
        tx,
        actor: params.actor,
        request: params.request,
        cause: { kind: "verify-reset", credential: params.causedByCredential },
      });
      return written;
    },
  );
  invalidateXeroOrganisationCaches();
  return result;
}
