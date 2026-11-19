import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27 (LTV-002, ADR-001): the display pairing/auth library. These tests
// pin the security-critical behaviour: tamper-proof pairing blobs, single-use
// admin-bound codes, hash-at-rest tokens, and a guard that rejects revoked
// devices and inactive lodges.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    lodgeDisplayDevice: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
    $executeRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

beforeAll(() => {
  process.env.AUTH_SECRET = "test-display-secret";
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.findFirst.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.update.mockResolvedValue({});
});

describe("pairing codes and blobs (ADR-001 §2)", () => {
  it("generates codes of the documented length and alphabet", async () => {
    const {
      generatePairingCode,
      isPairingCodeFormat,
      PAIRING_CODE_ALPHABET,
      PAIRING_CODE_LENGTH,
    } = await import("@/lib/lodge-display-auth");

    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(isPairingCodeFormat(code)).toBe(true);
      for (const ch of code) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
    }
    // Ambiguous characters never appear on the TV.
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it("round-trips a signed blob and rejects tampering", async () => {
    const { encodePairingBlob, decodePairingBlob } = await import(
      "@/lib/lodge-display-auth"
    );
    const exp = Math.floor(Date.now() / 1000) + 600;
    const blob = encodePairingBlob({ code: "ABCDEF", exp });

    expect(decodePairingBlob(blob)).toEqual({ code: "ABCDEF", exp });

    const [part, sig] = blob.split(".");
    const forgedPart = Buffer.from(
      JSON.stringify({ code: "ZZZZZZ", exp }),
      "utf8"
    ).toString("base64url");
    expect(decodePairingBlob(`${forgedPart}.${sig}`)).toBeNull();
    expect(decodePairingBlob(`${part}.AAAA${sig!.slice(4)}`)).toBeNull();
    expect(decodePairingBlob("garbage")).toBeNull();
    expect(decodePairingBlob("")).toBeNull();
  });

  it("rejects an expired blob even with a valid signature", async () => {
    const { encodePairingBlob, decodePairingBlob } = await import(
      "@/lib/lodge-display-auth"
    );
    const blob = encodePairingBlob({
      code: "ABCDEF",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(decodePairingBlob(blob)).toBeNull();
  });
});

describe("preview grants (LTV-036, ADR-003 §5)", () => {
  it("round-trips a signed grant (template + lodge + optional window start)", async () => {
    const { encodePreviewGrant, decodePreviewGrant } = await import(
      "@/lib/lodge-display-auth"
    );
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = encodePreviewGrant({
      templateId: "tpl-1",
      lodgeId: "lodge-b",
      windowStart: "2026-08-01",
      exp,
    });
    expect(decodePreviewGrant(token)).toEqual({
      templateId: "tpl-1",
      lodgeId: "lodge-b",
      windowStart: "2026-08-01",
      exp,
    });

    // A template-less grant (legacy board for a lodge) round-trips too.
    const bare = encodePreviewGrant({ templateId: null, lodgeId: "lodge-c", exp });
    expect(decodePreviewGrant(bare)).toEqual({
      templateId: null,
      lodgeId: "lodge-c",
      exp,
    });
  });

  it("rejects a tampered or forged grant", async () => {
    const { encodePreviewGrant, decodePreviewGrant } = await import(
      "@/lib/lodge-display-auth"
    );
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = encodePreviewGrant({
      templateId: "tpl-1",
      lodgeId: "lodge-b",
      exp,
    });
    const [part, sig] = token.split(".");

    // Swap the lodge in the payload but keep the original signature.
    const forgedPart = Buffer.from(
      JSON.stringify({ templateId: "tpl-1", lodgeId: "lodge-evil", exp }),
      "utf8"
    ).toString("base64url");
    expect(decodePreviewGrant(`${forgedPart}.${sig}`)).toBeNull();
    // Corrupt the signature.
    expect(decodePreviewGrant(`${part}.AAAA${sig!.slice(4)}`)).toBeNull();
    expect(decodePreviewGrant("garbage")).toBeNull();
    expect(decodePreviewGrant("")).toBeNull();
  });

  it("rejects a signed grant whose window start is not a real calendar day", async () => {
    const { encodePreviewGrant, decodePreviewGrant } = await import(
      "@/lib/lodge-display-auth"
    );
    const token = encodePreviewGrant({
      templateId: "tpl-1",
      lodgeId: "lodge-b",
      windowStart: "2026-02-30",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(decodePreviewGrant(token)).toBeNull();
  });

  it("rejects an expired grant even with a valid signature", async () => {
    const { encodePreviewGrant, decodePreviewGrant } = await import(
      "@/lib/lodge-display-auth"
    );
    const token = encodePreviewGrant({
      templateId: "tpl-1",
      lodgeId: "lodge-b",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(decodePreviewGrant(token)).toBeNull();
  });

  it("does not accept a pairing blob as a grant (distinct HMAC domain)", async () => {
    // The two blobs share the signing secret but use different domain-separation
    // prefixes, so a pairing blob can never be replayed as a preview grant.
    const { encodePairingBlob, decodePreviewGrant } = await import(
      "@/lib/lodge-display-auth"
    );
    const pairing = encodePairingBlob({
      code: "ABCDEF",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(decodePreviewGrant(pairing)).toBeNull();
  });
});

describe("confirmDevicePairing (admin bind)", () => {
  it("persists the normalised code and expiry on the device", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      revokedAt: null,
    });
    const { confirmDevicePairing } = await import("@/lib/lodge-display-auth");

    const result = await confirmDevicePairing("dev-1", " abcdef ");
    expect(result.ok).toBe(true);
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dev-1" },
        data: expect.objectContaining({
          pairingCode: "ABCDEF",
          pairingCodeExpiresAt: expect.any(Date),
        }),
      })
    );
  });

  it("rejects malformed codes without touching the database", async () => {
    const { confirmDevicePairing } = await import("@/lib/lodge-display-auth");
    const result = await confirmDevicePairing("dev-1", "bad code!");
    expect(result).toEqual({ ok: false, error: "invalid-code" });
    expect(mockPrisma.lodgeDisplayDevice.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("refuses to arm a revoked device", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      id: "dev-1",
      revokedAt: new Date(),
    });
    const { confirmDevicePairing } = await import("@/lib/lodge-display-auth");
    const result = await confirmDevicePairing("dev-1", "ABCDEF");
    expect(result).toEqual({ ok: false, error: "revoked" });
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });
});

describe("claimDisplayToken (device claim)", () => {
  it("issues a token, stores only its hash, and clears the code (single-use)", async () => {
    mockPrisma.lodgeDisplayDevice.findFirst.mockResolvedValue({
      id: "dev-1",
      lodgeId: "lodge-a",
      name: "Lobby TV",
    });
    const { claimDisplayToken } = await import("@/lib/lodge-display-auth");
    const { hashActionToken } = await import("@/lib/action-tokens");

    const claimed = await claimDisplayToken("ABCDEF");
    expect(claimed?.device.lodgeId).toBe("lodge-a");
    expect(claimed?.token).toMatch(/^[a-f0-9]{64}$/);

    const update = mockPrisma.lodgeDisplayDevice.update.mock.calls[0][0];
    expect(update.data.tokenHash).toBe(hashActionToken(claimed!.token));
    expect(update.data.tokenHash).not.toBe(claimed!.token);
    expect(update.data.pairingCode).toBeNull();
    expect(update.data.pairingCodeExpiresAt).toBeNull();
    // Query excluded expired codes and revoked devices at the WHERE level.
    const where = mockPrisma.lodgeDisplayDevice.findFirst.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.pairingCodeExpiresAt).toEqual({ gt: expect.any(Date) });
  });

  it("returns null when no admin has bound the code", async () => {
    const { claimDisplayToken } = await import("@/lib/lodge-display-auth");
    expect(await claimDisplayToken("ABCDEF")).toBeNull();
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("rejects malformed codes outright", async () => {
    const { claimDisplayToken } = await import("@/lib/lodge-display-auth");
    expect(await claimDisplayToken("nope")).toBeNull();
    expect(mockPrisma.lodgeDisplayDevice.findFirst).not.toHaveBeenCalled();
  });
});

describe("checkDisplayAuth (the display guard)", () => {
  async function requestWithToken(token?: string) {
    const { NextRequest } = await import("next/server");
    const { DISPLAY_TOKEN_COOKIE } = await import("@/lib/lodge-display-auth");
    return new NextRequest("http://localhost/api/display/heartbeat", {
      method: "POST",
      headers: token
        ? { cookie: `${DISPLAY_TOKEN_COOKIE}=${token}` }
        : undefined,
    });
  }

  const DEVICE = {
    id: "dev-1",
    lodgeId: "lodge-a",
    name: "Lobby TV",
    templateId: null,
    revokedAt: null,
    lodge: { active: true },
  };

  it("resolves a valid token to its device and lodge", async () => {
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(DEVICE);
    const { checkDisplayAuth } = await import("@/lib/lodge-display-auth");
    const { hashActionToken } = await import("@/lib/action-tokens");

    const result = await checkDisplayAuth(await requestWithToken("a".repeat(64)));
    expect(result?.device).toEqual({
      id: "dev-1",
      lodgeId: "lodge-a",
      name: "Lobby TV",
      templateId: null,
    });
    // Lookup is by HASH, never the raw token (hash-at-rest).
    expect(mockPrisma.lodgeDisplayDevice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashActionToken("a".repeat(64)) },
      })
    );
  });

  it("rejects a missing cookie, an unknown token, a revoked device, and an inactive lodge", async () => {
    const { checkDisplayAuth } = await import("@/lib/lodge-display-auth");

    expect(await checkDisplayAuth(await requestWithToken())).toBeNull();

    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
    expect(await checkDisplayAuth(await requestWithToken("b".repeat(64)))).toBeNull();

    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      ...DEVICE,
      revokedAt: new Date(),
    });
    expect(await checkDisplayAuth(await requestWithToken("c".repeat(64)))).toBeNull();

    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      ...DEVICE,
      lodge: { active: false },
    });
    expect(await checkDisplayAuth(await requestWithToken("d".repeat(64)))).toBeNull();
  });
});
