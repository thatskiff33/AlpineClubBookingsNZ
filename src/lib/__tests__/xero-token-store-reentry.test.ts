import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX-1 (#2079): a stored Xero token that no longer decrypts (env→DB upgrade or
// an auth-secret change) must become a TYPED reconnect signal, and the status
// surface must report "needs re-entry / not connected" rather than "connected"
// over dead tokens.

const h = vi.hoisted(() => ({
  prisma: {
    xeroToken: {
      findFirst: vi.fn(),
    },
    // #3454: no credential-store copy in these cases, so the readability probe
    // falls through to the XeroToken row exactly as before.
    integrationCredential: {
      findUnique: vi.fn(async () => null),
    },
  },
  getOperationalXeroEncryptionKey: vi.fn(),
  peekOperationalXeroEncryptionKey: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroEncryptionKey: h.getOperationalXeroEncryptionKey,
  peekOperationalXeroEncryptionKey: h.peekOperationalXeroEncryptionKey,
}));

import {
  XeroTokenDecryptError,
  decryptToken,
  encryptToken,
  getXeroConnectionStatus,
  getXeroTokenReadability,
} from "@/lib/xero-token-store";

const KEY_A = "a".repeat(64); // 32 bytes
const KEY_B = "b".repeat(64); // a different 32-byte key

const originalAuthSecret = process.env.AUTH_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
});

/** Encrypt a value under KEY_A using the real crypto, for use as a fixture. */
async function cipherUnderKeyA(plaintext: string): Promise<string> {
  h.getOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);
  return encryptToken(plaintext);
}

describe("decryptToken typed reconnect signal (FIX-1)", () => {
  it("round-trips under the same key", async () => {
    const token = await cipherUnderKeyA("access-token-value");
    h.getOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);
    expect(await decryptToken(token)).toBe("access-token-value");
  });

  it("throws XeroTokenDecryptError (not a generic Error) when the key no longer matches", async () => {
    const token = await cipherUnderKeyA("access-token-value");
    // Key rotated: decrypt now resolves a different key → GCM tag fails.
    h.getOperationalXeroEncryptionKey.mockResolvedValue(KEY_B);
    await expect(decryptToken(token)).rejects.toBeInstanceOf(
      XeroTokenDecryptError,
    );
  });

  it("throws XeroTokenDecryptError on a malformed stored row", async () => {
    h.getOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);
    await expect(decryptToken("not-a-valid-format")).rejects.toBeInstanceOf(
      XeroTokenDecryptError,
    );
  });
});

describe("getXeroTokenReadability (side-effect-free) (FIX-1)", () => {
  it("reports no_tokens when nothing is stored", async () => {
    h.prisma.xeroToken.findFirst.mockResolvedValue(null);
    expect(await getXeroTokenReadability()).toBe("no_tokens");
  });

  it("reports readable via the PEEK resolver (never the mutating generate path)", async () => {
    const accessToken = await cipherUnderKeyA("access");
    h.getOperationalXeroEncryptionKey.mockClear(); // ignore fixture-build calls
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);
    h.prisma.xeroToken.findFirst.mockResolvedValue({ id: "tok", accessToken });
    expect(await getXeroTokenReadability()).toBe("readable");
    // Side-effect-free: the generate-on-miss resolver is never touched.
    expect(h.getOperationalXeroEncryptionKey).not.toHaveBeenCalled();
    expect(h.peekOperationalXeroEncryptionKey).toHaveBeenCalled();
  });

  it("reports unreadable when the key is gone (auth secret changed)", async () => {
    const accessToken = await cipherUnderKeyA("access");
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(undefined);
    h.prisma.xeroToken.findFirst.mockResolvedValue({ id: "tok", accessToken });
    expect(await getXeroTokenReadability()).toBe("unreadable");
  });

  it("reports unreadable when the row fails GCM under the peeked key", async () => {
    const accessToken = await cipherUnderKeyA("access");
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(KEY_B);
    h.prisma.xeroToken.findFirst.mockResolvedValue({ id: "tok", accessToken });
    expect(await getXeroTokenReadability()).toBe("unreadable");
  });
});

describe("getXeroConnectionStatus truthfulness (FIX-1)", () => {
  it("is not connected and not needing re-entry when no tokens exist", async () => {
    h.prisma.xeroToken.findFirst.mockResolvedValue(null);
    expect(await getXeroConnectionStatus()).toEqual({
      connected: false,
      needsReentry: false,
      tenantId: null,
      tokenExpiresAt: null,
    });
  });

  it("reports connected when the stored token still decrypts", async () => {
    process.env.AUTH_SECRET = "s".repeat(48);
    const accessToken = await cipherUnderKeyA("access");
    const expiresAt = new Date("2026-08-01T00:00:00.000Z");
    h.prisma.xeroToken.findFirst.mockResolvedValue({
      accessToken,
      tenantId: "tenant-1",
      expiresAt,
    });
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);

    expect(await getXeroConnectionStatus()).toEqual({
      connected: true,
      needsReentry: false,
      tenantId: "tenant-1",
      tokenExpiresAt: expiresAt,
    });
  });

  it("reports NOT connected over readable tokens when no refresh could store its result (#3454 review)", async () => {
    // A grandfathered secret the capture gate now refuses: the tokens still
    // decrypt, but every refresh refuses, so "Connected" would be a lie.
    process.env.AUTH_SECRET = "too-short";
    const accessToken = await cipherUnderKeyA("access");
    const expiresAt = new Date("2026-08-01T00:00:00.000Z");
    h.prisma.xeroToken.findFirst.mockResolvedValue({
      accessToken,
      tenantId: "tenant-1",
      expiresAt,
    });
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(KEY_A);

    expect(await getXeroConnectionStatus()).toMatchObject({
      connected: false,
      needsReentry: true,
    });
  });

  it("reports needsReentry / NOT connected when the stored token no longer decrypts", async () => {
    const accessToken = await cipherUnderKeyA("access");
    const expiresAt = new Date("2026-08-01T00:00:00.000Z");
    h.prisma.xeroToken.findFirst.mockResolvedValue({
      accessToken,
      tenantId: "tenant-1",
      expiresAt,
    });
    // Key rotated: the row can no longer be read.
    h.peekOperationalXeroEncryptionKey.mockResolvedValue(KEY_B);

    expect(await getXeroConnectionStatus()).toEqual({
      connected: false,
      needsReentry: true,
      tenantId: "tenant-1",
      tokenExpiresAt: expiresAt,
    });
  });
});
