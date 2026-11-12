/**
 * The stored Xero token set's format (#3454), lifted out of
 * `xero-token-store.ts` by #3806 R2 so the token store stays inside its size
 * budget. The value is one encrypted credential-store row (`xero-oauth` /
 * `token-set`); this module only turns it into JSON and back. Never logged,
 * never audited, never echoed in an error.
 */

import type { CredentialResolution } from "@/lib/integration-credentials";

/** What the store row's encrypted value holds. */
interface StoredXeroTokenSet {
  v: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tenantId: string | null;
  /**
   * A fingerprint R2 stored beside the tokens. This release does not write it.
   * Optional so a row R2 wrote still loads; present and not a string is rejected.
   */
  mirror?: string;
}

export function serializeStoredTokenSet(
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  tenantId: string | null,
): string {
  const value: StoredXeroTokenSet = {
    v: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    tenantId,
  };
  return JSON.stringify(value);
}

/** Parse the store value, or `null` when it is not a token set. */
function parseStoredTokenSet(value: string): StoredXeroTokenSet | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredXeroTokenSet> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      Number.isNaN(Date.parse(parsed.expiresAt)) ||
      (parsed.tenantId !== null && typeof parsed.tenantId !== "string") ||
      (parsed.mirror !== undefined && typeof parsed.mirror !== "string")
    ) {
      return null;
    }
    return parsed as StoredXeroTokenSet;
  } catch {
    // Never echo the value: it holds the tokens.
    return null;
  }
}

/** The usable token set in a store resolution, or `null`. */
function usableTokenSet(stored: CredentialResolution): StoredXeroTokenSet | null {
  return stored.status === "configured" ? parseStoredTokenSet(stored.value) : null;
}

/** Why a connection has no token set this release may use. */
export type ConnectionTokenSetRefusal = "absent" | "unreadable" | "other-tenant";

/**
 * The store copy, when it belongs to the connection whose tenant is
 * `connectionTenantId` (#3806 review).
 *
 * Refused when it is missing, unreadable or malformed, AND when it names a
 * different organisation from the connection. That disagreement means the
 * connection row and the store copy were written from different grants (two
 * connects at once, or a release from before #3454 that reconnected while a
 * later release's copy remained). Its tokens would act on an organisation the
 * club has left, so only a reconnect settles it. A copy that names the SAME
 * organisation cannot be told apart from a current one; the upgrade notes
 * cover that case.
 */
export function tokenSetForConnection(
  stored: CredentialResolution,
  connectionTenantId: string | null,
):
  | { usable: true; value: StoredXeroTokenSet }
  | { usable: false; refusal: ConnectionTokenSetRefusal } {
  if (stored.status === "not_configured") return { usable: false, refusal: "absent" };
  const value = usableTokenSet(stored);
  if (value === null) return { usable: false, refusal: "unreadable" };
  if (
    value.tenantId !== null &&
    connectionTenantId !== null &&
    value.tenantId !== connectionTenantId
  ) {
    return { usable: false, refusal: "other-tenant" };
  }
  return { usable: true, value };
}
