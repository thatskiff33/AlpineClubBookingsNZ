/**
 * A connected Xero, as the token store reads it since #3806 R2: the one
 * `XeroConnection` row and the credential-store token set (`xero-oauth` /
 * `token-set`), encrypted with the real integration-credential crypto.
 *
 * Suites that drive `getAuthenticatedXeroClient` against a mocked Prisma used to
 * hand back a `XeroToken` row encrypted under a stubbed token key. That row is no
 * longer read; these two are. The store row is built once per call under the
 * current `AUTH_SECRET`, which `ensureStrongTestAuthSecret` sets when the suite
 * has none (the capture gate refuses to encrypt under a weak one).
 */
import {
  encryptCredential,
  isAuthSecretStrongEnough,
} from "@/lib/integration-crypto";
import { XERO_OAUTH_TOKEN_KEY, XERO_OAUTH_TOKEN_PROVIDER } from "@/lib/xero-token-store";
import { serializeStoredTokenSet } from "@/lib/xero-token-set";

const TEST_AUTH_SECRET = "xero-connected-mock-auth-secret-0123456789abcdef";

/** Set a strong `AUTH_SECRET` unless one is already set; returns a restore. */
export function ensureStrongTestAuthSecret(): () => void {
  const previous = process.env.AUTH_SECRET;
  if (!isAuthSecretStrongEnough(previous)) process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  return () => {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  };
}

export interface ConnectedXeroFixture {
  /** What `prisma.xeroConnection.findUnique` returns. */
  connection: {
    tenantId: string | null;
    expiresAt: Date;
    refreshInProgressUntil: Date | null;
  };
  /** What `prisma.integrationCredential.findUnique` returns for the token set. */
  credential: Record<string, unknown>;
}

export function connectedXeroFixture(params: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: Date;
  tenantId: string | null;
  /**
   * The tenant the STORE copy names, when it differs from the connection's: a
   * copy left behind by a release that wrote only `XeroToken` (#3806 review).
   * Defaults to `tenantId`.
   */
  storeTenantId?: string | null;
  refreshInProgressUntil?: Date | null;
}): ConnectedXeroFixture {
  // The token store's own serializer, so the fixture cannot drift from the format.
  const plaintext = serializeStoredTokenSet(
    {
      accessToken: params.accessToken ?? "access",
      refreshToken: params.refreshToken ?? "refresh",
      expiresAt: params.expiresAt,
    },
    params.storeTenantId === undefined ? params.tenantId : params.storeTenantId,
    "0".repeat(64),
  );
  const encrypted = encryptCredential({
    provider: XERO_OAUTH_TOKEN_PROVIDER,
    key: XERO_OAUTH_TOKEN_KEY,
    plaintext,
  });
  return {
    connection: {
      tenantId: params.tenantId,
      expiresAt: params.expiresAt,
      refreshInProgressUntil: params.refreshInProgressUntil ?? null,
    },
    credential: {
      id: "ic-xero-token-set",
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      secretSource: encrypted.secretSource,
      labelVersion: encrypted.labelVersion,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

type FindUniqueMock = {
  mockResolvedValue: (value: never) => unknown;
  mockImplementation: (impl: never) => unknown;
};

/**
 * Point a mocked Prisma's two delegates at `fixture`, or at "not connected" when
 * it is null. The credential delegate answers only for the token set; any other
 * provider/key reads as absent.
 */
export function mockXeroConnection(
  prisma: {
    xeroConnection: { findUnique: FindUniqueMock };
    integrationCredential: { findUnique: FindUniqueMock };
  },
  fixture: ConnectedXeroFixture | null,
): void {
  prisma.xeroConnection.findUnique.mockResolvedValue(
    (fixture?.connection ?? null) as never,
  );
  prisma.integrationCredential.findUnique.mockImplementation((async (args: {
    where?: { provider_key?: { provider?: string; key?: string } };
  }) => {
    const target = args?.where?.provider_key;
    return fixture &&
      target?.provider === XERO_OAUTH_TOKEN_PROVIDER &&
      target?.key === XERO_OAUTH_TOKEN_KEY
      ? fixture.credential
      : null;
  }) as never);
}
