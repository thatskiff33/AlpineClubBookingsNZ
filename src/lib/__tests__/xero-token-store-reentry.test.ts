import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX-1 (#2079), restated for #3806 R2: stored Xero tokens that can no longer be
// used (an auth-secret change, a malformed value, or a connection with no stored
// token set at all) must read as "needs re-entry / not connected", never as
// "connected" over dead tokens. Since R2 the only copy is the credential-store
// one, and the connection is the `XeroConnection` row.

const h = vi.hoisted(() => ({
  prisma: {
    xeroConnection: {
      findUnique: vi.fn(),
    },
    // The previous release's lease (#3806 R2); none held here.
    xeroToken: {
      findFirst: vi.fn(async () => null),
    },
    integrationCredential: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));

import { encryptCredential } from "@/lib/integration-crypto";
import {
  XERO_OAUTH_TOKEN_KEY,
  XERO_OAUTH_TOKEN_PROVIDER,
  XeroTokenDecryptError,
  getXeroConnectionStatus,
  getXeroTokenReadability,
  loadXeroTokens,
} from "@/lib/xero-token-store";

const STRONG_SECRET = "s".repeat(48);
const OTHER_SECRET = "t".repeat(48);
const originalAuthSecret = process.env.AUTH_SECRET;
const EXPIRES_AT = new Date("2026-08-01T00:00:00.000Z");

/** A credential-store row holding `plaintext`, encrypted under the CURRENT secret. */
function storeRow(plaintext: string) {
  const encrypted = encryptCredential({
    provider: XERO_OAUTH_TOKEN_PROVIDER,
    key: XERO_OAUTH_TOKEN_KEY,
    plaintext,
  });
  return {
    id: "ic-1",
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
  };
}

const TOKEN_SET = JSON.stringify({
  v: 1,
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: EXPIRES_AT.toISOString(),
  tenantId: "tenant-1",
  mirror: "0".repeat(64),
});

function connected() {
  h.prisma.xeroConnection.findUnique.mockResolvedValue({
    tenantId: "tenant-1",
    expiresAt: EXPIRES_AT,
    refreshInProgressUntil: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = STRONG_SECRET;
  h.prisma.xeroConnection.findUnique.mockResolvedValue(null);
  h.prisma.integrationCredential.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
});

describe("getXeroTokenReadability (side-effect-free) (FIX-1, #3806)", () => {
  it("reports no_tokens when there is no connection, whatever the store holds", async () => {
    h.prisma.integrationCredential.findUnique.mockResolvedValue(storeRow(TOKEN_SET));
    expect(await getXeroTokenReadability()).toBe("no_tokens");
  });

  it("reports readable when the store copy decrypts and parses", async () => {
    connected();
    h.prisma.integrationCredential.findUnique.mockResolvedValue(storeRow(TOKEN_SET));
    expect(await getXeroTokenReadability()).toBe("readable");
  });

  it("reports unreadable when the store copy was written under another auth secret", async () => {
    connected();
    process.env.AUTH_SECRET = OTHER_SECRET;
    const row = storeRow(TOKEN_SET);
    process.env.AUTH_SECRET = STRONG_SECRET;
    h.prisma.integrationCredential.findUnique.mockResolvedValue(row);
    expect(await getXeroTokenReadability()).toBe("unreadable");
  });

  it("reports unreadable when the store value is not a token set", async () => {
    connected();
    h.prisma.integrationCredential.findUnique.mockResolvedValue(storeRow("{}"));
    expect(await getXeroTokenReadability()).toBe("unreadable");
  });

  it("reports unreadable when a connection has no stored token set at all (#3806: no legacy fallback)", async () => {
    connected();
    expect(await getXeroTokenReadability()).toBe("unreadable");
  });
});

describe("loadXeroTokens raises the typed reconnect signal (FIX-1, #3806)", () => {
  it("is null when not connected", async () => {
    expect(await loadXeroTokens()).toBeNull();
  });

  it("throws XeroTokenDecryptError for a connection with no stored token set", async () => {
    connected();
    await expect(loadXeroTokens()).rejects.toBeInstanceOf(XeroTokenDecryptError);
  });

  it("throws XeroTokenDecryptError for a store copy that no longer decrypts", async () => {
    connected();
    process.env.AUTH_SECRET = OTHER_SECRET;
    const row = storeRow(TOKEN_SET);
    process.env.AUTH_SECRET = STRONG_SECRET;
    h.prisma.integrationCredential.findUnique.mockResolvedValue(row);
    await expect(loadXeroTokens()).rejects.toBeInstanceOf(XeroTokenDecryptError);
  });
});

describe("getXeroConnectionStatus truthfulness (FIX-1, #3806)", () => {
  it("is not connected and not needing re-entry when there is no connection", async () => {
    expect(await getXeroConnectionStatus()).toEqual({
      connected: false,
      needsReentry: false,
      tenantId: null,
      tokenExpiresAt: null,
    });
  });

  it("reports connected, with the connection's tenant and expiry, when the store copy is usable", async () => {
    connected();
    h.prisma.integrationCredential.findUnique.mockResolvedValue(storeRow(TOKEN_SET));
    expect(await getXeroConnectionStatus()).toEqual({
      connected: true,
      needsReentry: false,
      tenantId: "tenant-1",
      tokenExpiresAt: EXPIRES_AT,
    });
  });

  it("reports NOT connected over readable tokens when no refresh could store its result (#3454 review)", async () => {
    connected();
    h.prisma.integrationCredential.findUnique.mockResolvedValue(storeRow(TOKEN_SET));
    // A grandfathered secret the capture gate now refuses: the tokens still
    // decrypt, but every refresh refuses, so "Connected" would be a lie.
    process.env.AUTH_SECRET = "too-short";
    expect(await getXeroConnectionStatus()).toMatchObject({
      connected: false,
      needsReentry: true,
    });
  });

  it("reports needsReentry / NOT connected when a connection has no usable token set", async () => {
    connected();
    expect(await getXeroConnectionStatus()).toEqual({
      connected: false,
      needsReentry: true,
      tenantId: "tenant-1",
      tokenExpiresAt: EXPIRES_AT,
    });
  });
});
