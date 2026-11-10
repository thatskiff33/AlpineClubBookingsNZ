import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssert = vi.hoisted(() => vi.fn());
const createAuditLog = vi.hoisted(() => vi.fn());

const mockPrisma = vi.hoisted(() => {
  const db = {
    webAuthnCredential: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    webAuthnChallenge: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    member: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: typeof db) => Promise<unknown>)(db);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  return db;
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog }));
vi.mock("@/lib/second-factor-requirement", () => ({
  assertLastFactorRemovable: mockAssert,
}));
vi.mock("@simplewebauthn/server", async () => {
  const actual = (await vi.importActual(
    "@simplewebauthn/server",
  )) as typeof import("@simplewebauthn/server");
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
  };
});

import * as webauthnServer from "@simplewebauthn/server";

import { webAuthnRelyingParty } from "@/lib/webauthn-relying-party";
import {
  claimWebAuthnCounter,
  consumeWebAuthnChallenge,
  createPasskeyAuthenticationOptions,
  createPasskeyRegistrationOptions,
  deletePasskey,
  normalisePasskeyName,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from "@/lib/webauthn";
import { TWO_FACTOR_AUDIT_ACTIONS } from "@/lib/two-factor-audit";

const MEMBER = "member-1";
const ACTOR = { kind: "member" as const, memberId: MEMBER };

function clientData(challenge: string, origin: string, type = "webauthn.get") {
  return Buffer.from(JSON.stringify({ type, challenge, origin })).toString("base64url");
}

function assertion(challenge: string, origin = "http://localhost:3000") {
  return {
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: {
      clientDataJSON: clientData(challenge, origin),
      authenticatorData: "AA",
      signature: "AA",
    },
  };
}

function authenticatorData(rpID: string, counter: number) {
  const hash = createHash("sha256").update(rpID).digest();
  const flags = Buffer.from([0x05]);
  const sign = Buffer.alloc(4);
  sign.writeUInt32BE(counter);
  return Buffer.concat([hash, flags, sign]).toString("base64url");
}

describe("passkey ceremonies (#4617)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    mockAssert.mockResolvedValue(undefined);
    mockPrisma.webAuthnCredential.count.mockResolvedValue(0);
    mockPrisma.webAuthnCredential.findMany.mockResolvedValue([]);
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue(null);
    mockPrisma.webAuthnCredential.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.webAuthnCredential.create.mockResolvedValue({ id: "row-1" });
    mockPrisma.webAuthnCredential.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.webAuthnChallenge.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.webAuthnChallenge.create.mockResolvedValue({ id: "challenge-1" });
    mockPrisma.member.findUnique.mockResolvedValue({
      twoFactorEnabled: false,
      twoFactorMethod: null,
    });
    const actual = (await vi.importActual(
      "@simplewebauthn/server",
    )) as typeof import("@simplewebauthn/server");
    vi.mocked(webauthnServer.verifyAuthenticationResponse).mockImplementation(
      actual.verifyAuthenticationResponse,
    );
  });

  it("takes the relying party from NEXTAUTH_URL and refuses a missing URL", () => {
    expect(webAuthnRelyingParty("https://bookings.example.org")).toEqual({
      rpID: "bookings.example.org",
      origin: "https://bookings.example.org",
    });
    expect(() => webAuthnRelyingParty("")).toThrow(/NEXTAUTH_URL/);
    expect(() => webAuthnRelyingParty("not a url")).toThrow(/NEXTAUTH_URL/);
  });

  it("stores a blank name as Passkey and refuses one over 64 characters", () => {
    expect(normalisePasskeyName(undefined)).toEqual({ ok: true, name: "Passkey" });
    expect(normalisePasskeyName("  ")).toEqual({ ok: true, name: "Passkey" });
    expect(normalisePasskeyName("  Shed key  ")).toEqual({ ok: true, name: "Shed key" });
    expect(normalisePasskeyName("x".repeat(65)).ok).toBe(false);
  });

  it("offers registration with the required ceremony and refuses an eleventh passkey", async () => {
    const created = await createPasskeyRegistrationOptions({
      memberId: MEMBER,
      email: "member@example.com",
      displayName: "Member One",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.options.attestation).toBe("none");
    expect(created.options.authenticatorSelection).toMatchObject({
      residentKey: "preferred",
      userVerification: "required",
    });
    expect(created.options.rp.id).toBe("localhost");
    expect(created.options.timeout).toBe(120_000);
    expect(mockPrisma.webAuthnChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: MEMBER, purpose: "registration" }),
      }),
    );

    mockPrisma.webAuthnCredential.count.mockResolvedValue(10);
    const capped = await createPasskeyRegistrationOptions({
      memberId: MEMBER,
      email: "member@example.com",
      displayName: "Member One",
    });
    expect(capped).toEqual({
      ok: false,
      status: 409,
      error: "You can save up to 10 passkeys.",
    });
  });

  it("offers authentication only for this member's saved passkeys", async () => {
    expect(await createPasskeyAuthenticationOptions(MEMBER)).toBeNull();
    expect(mockPrisma.webAuthnChallenge.create).not.toHaveBeenCalled();

    mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
      { credentialId: "cred-1", transports: ["internal"] },
    ]);
    const options = await createPasskeyAuthenticationOptions(MEMBER);
    expect(options?.userVerification).toBe("required");
    expect(options?.allowCredentials).toEqual([
      { id: "cred-1", transports: ["internal"], type: "public-key" },
    ]);
  });

  it("claims the registration challenge before checking the signature", async () => {
    const response = {
      id: "cred-1",
      rawId: "cred-1",
      type: "public-key",
      response: {
        clientDataJSON: clientData("challenge-1", "http://localhost:3000", "webauthn.create"),
        attestationObject: "AA",
      },
    };
    const result = await verifyPasskeyRegistration({
      memberId: MEMBER,
      response,
      name: "",
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(mockPrisma.webAuthnChallenge.deleteMany).toHaveBeenCalledWith({
      where: {
        challenge: "challenge-1",
        memberId: MEMBER,
        purpose: "registration",
        expiresAt: { gt: expect.any(Date) },
      },
    });
    expect(mockPrisma.webAuthnCredential.create).not.toHaveBeenCalled();
  });

  it("refuses an expired challenge and a replay", async () => {
    mockPrisma.webAuthnChallenge.deleteMany.mockResolvedValueOnce({ count: 0 });
    const expired = await verifyPasskeyAssertion(MEMBER, assertion("challenge-1"), ACTOR);
    expect(expired).toMatchObject({
      ok: false,
      error: "That passkey challenge expired. Try again.",
    });

    mockPrisma.webAuthnChallenge.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      publicKey: Buffer.from([1]),
      counter: 0,
      transports: [],
    });
    const first = await verifyPasskeyAssertion(MEMBER, assertion("challenge-2"), ACTOR);
    const replay = await verifyPasskeyAssertion(MEMBER, assertion("challenge-2"), ACTOR);
    expect(first.ok).toBe(false);
    expect(replay).toMatchObject({
      ok: false,
      error: "That passkey challenge expired. Try again.",
    });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a response from the wrong origin", async () => {
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      publicKey: Buffer.from([1]),
      counter: 0,
      transports: [],
    });
    const result = await verifyPasskeyAssertion(
      MEMBER,
      assertion("challenge-1", "https://evil.example"),
      ACTOR,
    );
    expect(result.ok).toBe(false);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(mockPrisma.webAuthnCredential.updateMany).not.toHaveBeenCalled();
  });

  it("accepts counter 0 then 0, and audits a backwards counter without moving it", async () => {
    const actual = (await vi.importActual(
      "@simplewebauthn/server",
    )) as typeof import("@simplewebauthn/server");
    const authData = authenticatorData("localhost", 0);
    const client = clientData("challenge-0", "http://localhost:3000");
    let zeroCounter: unknown;
    try {
      zeroCounter = await actual.verifyAuthenticationResponse({
        response: {
          id: "cred-1",
          rawId: "cred-1",
          type: "public-key",
          response: { clientDataJSON: client, authenticatorData: authData, signature: "AA" },
        },
        expectedChallenge: "challenge-0",
        expectedOrigin: "http://localhost:3000",
        expectedRPID: "localhost",
        requireUserVerification: true,
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
      });
    } catch (error) {
      zeroCounter = error;
    }
    expect(String(zeroCounter)).not.toMatch(/counter value/);

    const backwards = authenticatorData("localhost", 1);
    await expect(
      actual.verifyAuthenticationResponse({
        response: {
          id: "cred-1",
          rawId: "cred-1",
          type: "public-key",
          response: {
            clientDataJSON: clientData("challenge-back", "http://localhost:3000"),
            authenticatorData: backwards,
            signature: "AA",
          },
        },
        expectedChallenge: "challenge-back",
        expectedOrigin: "http://localhost:3000",
        expectedRPID: "localhost",
        requireUserVerification: true,
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1]),
          counter: 4,
        },
      }),
    ).rejects.toThrow("Response counter value 1 was lower than expected 4");

    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      publicKey: Buffer.from([1]),
      counter: 0,
      transports: [],
    });
    vi.mocked(webauthnServer.verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    } as Awaited<ReturnType<typeof actual.verifyAuthenticationResponse>>);
    const accepted = await verifyPasskeyAssertion(MEMBER, assertion("challenge-ok"), ACTOR);
    expect(accepted).toEqual({ ok: true });
    expect(mockPrisma.webAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", counter: 0 },
      data: { counter: 0, lastUsedAt: expect.any(Date) },
    });

    mockPrisma.webAuthnCredential.updateMany.mockClear();
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      publicKey: Buffer.from([1]),
      counter: 4,
      transports: [],
    });
    vi.mocked(webauthnServer.verifyAuthenticationResponse).mockRejectedValueOnce(
      new Error("Response counter value 1 was lower than expected 4"),
    );
    const refused = await verifyPasskeyAssertion(MEMBER, assertion("challenge-back"), ACTOR);
    expect(refused.ok).toBe(false);
    expect(mockPrisma.webAuthnCredential.updateMany).not.toHaveBeenCalled();
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: TWO_FACTOR_AUDIT_ACTIONS.passkeyCounterRegressed,
        metadata: expect.objectContaining({
          credentialId: "cred-1",
          storedCounter: 4,
          reportedCounter: 1,
        }),
      }),
      expect.anything(),
    );
    const metadata = createAuditLog.mock.calls.at(-1)?.[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("publicKey");
  });

  it("refuses a lost counter compare-and-set and leaves the removal when the last factor is refused", async () => {
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      credentialId: "cred-1",
      publicKey: Buffer.from([1]),
      counter: 1,
      transports: [],
    });
    vi.mocked(webauthnServer.verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 2 },
    } as never);
    mockPrisma.webAuthnCredential.updateMany.mockResolvedValueOnce({ count: 0 });
    const lost = await verifyPasskeyAssertion(MEMBER, assertion("challenge-cas"), ACTOR);
    expect(lost.ok).toBe(false);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: TWO_FACTOR_AUDIT_ACTIONS.passkeyCounterRegressed,
        metadata: expect.objectContaining({ storedCounter: 1, reportedCounter: 2 }),
      }),
      expect.anything(),
    );

    mockAssert.mockRejectedValueOnce(new Error("keep the last factor"));
    mockPrisma.webAuthnCredential.findFirst.mockResolvedValue({
      id: "row-1",
      name: "Passkey",
      credentialId: "cred-1",
    });
    mockPrisma.webAuthnCredential.count.mockResolvedValue(0);
    await expect(
      deletePasskey({ memberId: MEMBER, id: "row-1", actor: ACTOR }),
    ).rejects.toThrow("keep the last factor");
    expect(mockPrisma.webAuthnCredential.deleteMany).not.toHaveBeenCalled();
  });

  it("consumes a challenge only when one unexpired row is deleted", async () => {
    mockPrisma.webAuthnChallenge.deleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(consumeWebAuthnChallenge(MEMBER, "c", "authentication")).resolves.toBe(true);
    mockPrisma.webAuthnChallenge.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumeWebAuthnChallenge(MEMBER, "c", "authentication")).resolves.toBe(false);
    await expect(
      claimWebAuthnCounter({ id: "row-1", verifiedCounter: 0, newCounter: 0 }),
    ).resolves.toBe(true);
  });
});
