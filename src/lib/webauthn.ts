/**
 * Passkey ceremonies (#4617, INV-AUTH-009).
 *
 * A challenge is stored in plaintext — the browser already has it — and is
 * deleted for this member and purpose before the signature is checked. One
 * delete of an unexpired row wins; a replay deletes nothing. The counter the
 * authenticator reports is accepted only when it does not go backwards, and
 * it is stored by a compare-and-set on the value verification saw.
 */

import type { Prisma } from "@prisma/client";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { getClubIdentitySync } from "@/lib/club-identity-settings";
import { prisma } from "@/lib/prisma";
import { assertEnrolmentNotSuperseded } from "@/lib/officer-factor-reset";
import {
  assertLastFactorRemovable,
  LastOfficerFactorError,
} from "@/lib/second-factor-requirement";
import { satisfiesOfficerSecondFactor } from "@/lib/second-factor-enrolment";
import { TWO_FACTOR_SESSION_CHALLENGE_TTL_MS } from "@/lib/two-factor";
import {
  recordTwoFactorMutation,
  TWO_FACTOR_AUDIT_ACTIONS,
  type TwoFactorPersonActor,
  type TwoFactorRequestContext,
} from "@/lib/two-factor-audit";
import { webAuthnRelyingParty } from "@/lib/webauthn-relying-party";

const PASSKEY_CAP = 10;
const PASSKEY_NAME_MAX = 64;
const DEFAULT_PASSKEY_NAME = "Passkey";

const COUNTER_REGRESSED =
  /Response counter value (\d+) was lower than expected (\d+)/;

export type PasskeyFailure = {
  ok: false;
  status: 400 | 409;
  error: string;
};

export function normalisePasskeyName(
  input: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (input === undefined || input === null) {
    return { ok: true, name: DEFAULT_PASSKEY_NAME };
  }
  if (typeof input !== "string") {
    return { ok: false, error: "Name the passkey in 64 characters or fewer." };
  }
  const trimmed = input.trim();
  if (trimmed.length > PASSKEY_NAME_MAX) {
    return { ok: false, error: "Name the passkey in 64 characters or fewer." };
  }
  return { ok: true, name: trimmed === "" ? DEFAULT_PASSKEY_NAME : trimmed };
}

export async function memberHasStoredPasskey(memberId: string): Promise<boolean> {
  const row = await prisma.webAuthnCredential.findFirst({
    where: { memberId },
    select: { id: true },
  });
  return row !== null;
}

function relyingPartyName(rpID: string): string {
  const name = getClubIdentitySync().name.trim();
  return name === "" ? rpID : name;
}

function readClientChallenge(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("response" in response)) {
    return null;
  }
  const inner = (response as { response?: { clientDataJSON?: unknown } }).response;
  const encoded = inner?.clientDataJSON;
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 4096) {
    return null;
  }
  try {
    const json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    if (typeof json.challenge !== "string" || json.challenge.length === 0) return null;
    if (json.challenge.length > 512) return null;
    return json.challenge;
  } catch {
    return null;
  }
}

/**
 * Delete one unexpired challenge. Of two concurrent presents of the same
 * value, one delete matches the row.
 */
export async function consumeWebAuthnChallenge(
  memberId: string,
  challenge: string,
  purpose: "registration" | "authentication",
): Promise<boolean> {
  const deleted = await prisma.webAuthnChallenge.deleteMany({
    where: {
      challenge,
      memberId,
      purpose,
      expiresAt: { gt: new Date() },
    },
  });
  return deleted.count === 1;
}

async function storeChallenge(
  memberId: string,
  challenge: string,
  purpose: "registration" | "authentication",
) {
  const expiresAt = new Date(Date.now() + TWO_FACTOR_SESSION_CHALLENGE_TTL_MS);
  await prisma.$transaction([
    prisma.webAuthnChallenge.deleteMany({
      where: { memberId, expiresAt: { lte: new Date() } },
    }),
    prisma.webAuthnChallenge.create({
      data: { memberId, challenge, purpose, expiresAt },
    }),
  ]);
}

/** Compare-and-set the counter verification already accepted. */
export async function claimWebAuthnCounter(input: {
  id: string;
  verifiedCounter: number;
  newCounter: number;
}): Promise<boolean> {
  const updated = await prisma.webAuthnCredential.updateMany({
    where: { id: input.id, counter: input.verifiedCounter },
    data: { counter: input.newCounter, lastUsedAt: new Date() },
  });
  return updated.count === 1;
}

async function auditPasskey(input: {
  action:
    | typeof TWO_FACTOR_AUDIT_ACTIONS.passkeyRegistered
    | typeof TWO_FACTOR_AUDIT_ACTIONS.passkeyRemoved
    | typeof TWO_FACTOR_AUDIT_ACTIONS.passkeyCounterRegressed;
  memberId: string;
  actor: TwoFactorPersonActor;
  request?: TwoFactorRequestContext;
  passkeyName?: string;
  credentialId?: string;
  storedCounter?: number;
  reportedCounter?: number;
  db?: Prisma.TransactionClient;
}) {
  await recordTwoFactorMutation(input.db ?? prisma, {
    action: input.action,
    actor: input.actor,
    subjectMemberId: input.memberId,
    method: null,
    authenticatorApp: false,
    passkeyName: input.passkeyName,
    credentialId: input.credentialId,
    storedCounter: input.storedCounter,
    reportedCounter: input.reportedCounter,
    request: input.request,
  });
}

export async function createPasskeyRegistrationOptions(input: {
  memberId: string;
  email: string;
  displayName: string;
}) {
  const saved = await prisma.webAuthnCredential.count({
    where: { memberId: input.memberId },
  });
  if (saved >= PASSKEY_CAP) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "You can save up to 10 passkeys.",
    };
  }
  const { rpID } = webAuthnRelyingParty();
  const existing = await prisma.webAuthnCredential.findMany({
    where: { memberId: input.memberId },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: relyingPartyName(rpID),
    rpID,
    userName: input.email,
    userDisplayName: input.displayName,
    userID: new TextEncoder().encode(input.memberId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    timeout: TWO_FACTOR_SESSION_CHALLENGE_TTL_MS,
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: row.transports,
    })),
  });
  await storeChallenge(input.memberId, options.challenge, "registration");
  return { ok: true as const, options };
}

export async function verifyPasskeyRegistration(input: {
  memberId: string;
  response: unknown;
  name: unknown;
  actor: TwoFactorPersonActor;
  request?: TwoFactorRequestContext;
  /** Issue time of the session registering. A reset newer than it refuses. */
  sessionIssuedAt?: Date | null;
}): Promise<{ ok: true } | PasskeyFailure> {
  const named = normalisePasskeyName(input.name);
  if (!named.ok) return { ok: false, status: 400, error: named.error };

  const challenge = readClientChallenge(input.response);
  if (!challenge) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  // Claim before the signature check, so a replay cannot be verified twice.
  const claimed = await consumeWebAuthnChallenge(
    input.memberId,
    challenge,
    "registration",
  );
  if (!claimed) {
    return { ok: false, status: 400, error: "That passkey challenge expired. Try again." };
  }

  const { rpID, origin } = webAuthnRelyingParty();
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  if (!verified.verified) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }

  const credential = verified.registrationInfo.credential;
  const transports = transportList(input.response, credential.transports);
  try {
    await prisma.$transaction(async (tx) => {
      await assertEnrolmentNotSuperseded(
        tx,
        input.memberId,
        input.sessionIssuedAt ?? null,
      );
      const saved = await tx.webAuthnCredential.count({
        where: { memberId: input.memberId },
      });
      if (saved >= PASSKEY_CAP) {
        throw new PasskeyCapError();
      }
      await tx.webAuthnCredential.create({
        data: {
          memberId: input.memberId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports,
          name: named.name,
        },
      });
      await auditPasskey({
        action: TWO_FACTOR_AUDIT_ACTIONS.passkeyRegistered,
        memberId: input.memberId,
        actor: input.actor,
        request: input.request,
        passkeyName: named.name,
        credentialId: credential.id,
        db: tx,
      });
    });
  } catch (error) {
    if (error instanceof PasskeyCapError) {
      return { ok: false, status: 409, error: "You can save up to 10 passkeys." };
    }
    if (isUniqueConflict(error)) {
      return { ok: false, status: 409, error: "That passkey is already saved." };
    }
    throw error;
  }
  return { ok: true };
}

export async function createPasskeyAuthenticationOptions(memberId: string) {
  const existing = await prisma.webAuthnCredential.findMany({
    where: { memberId },
    select: { credentialId: true, transports: true },
  });
  if (existing.length === 0) return null;
  const { rpID } = webAuthnRelyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    timeout: TWO_FACTOR_SESSION_CHALLENGE_TTL_MS,
    allowCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: row.transports,
    })),
  });
  await storeChallenge(memberId, options.challenge, "authentication");
  return options;
}

/**
 * Check one authentication assertion. Does not mark the sign-in verified and
 * does not count a lockout failure: the caller decides what a refusal means.
 */
export async function verifyPasskeyAssertion(
  memberId: string,
  response: unknown,
  actor?: TwoFactorPersonActor,
): Promise<{ ok: true } | PasskeyFailure> {
  const challenge = readClientChallenge(response);
  if (!challenge) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  const claimed = await consumeWebAuthnChallenge(memberId, challenge, "authentication");
  if (!claimed) {
    return { ok: false, status: 400, error: "That passkey challenge expired. Try again." };
  }

  const credentialId = readCredentialId(response);
  if (!credentialId) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  const stored = await prisma.webAuthnCredential.findFirst({
    where: { memberId, credentialId },
  });
  if (!stored) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }

  const { rpID, origin } = webAuthnRelyingParty();
  const person = actor ?? { kind: "member" as const, memberId };
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
  } catch (error) {
    const regressed = counterRegression(error);
    if (regressed) {
      await auditPasskey({
        action: TWO_FACTOR_AUDIT_ACTIONS.passkeyCounterRegressed,
        memberId,
        actor: person,
        credentialId: stored.credentialId,
        storedCounter: regressed.stored,
        reportedCounter: regressed.reported,
      });
    }
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  if (!verified.verified) {
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }

  const advanced = await claimWebAuthnCounter({
    id: stored.id,
    verifiedCounter: stored.counter,
    newCounter: verified.authenticationInfo.newCounter,
  });
  if (!advanced) {
    await auditPasskey({
      action: TWO_FACTOR_AUDIT_ACTIONS.passkeyCounterRegressed,
      memberId,
      actor: person,
      credentialId: stored.credentialId,
      storedCounter: stored.counter,
      reportedCounter: verified.authenticationInfo.newCounter,
    });
    return { ok: false, status: 400, error: "That passkey didn't work. Try again." };
  }
  return { ok: true };
}

export async function deletePasskey(input: {
  memberId: string;
  id: string;
  actor: TwoFactorPersonActor;
  request?: TwoFactorRequestContext;
}): Promise<{ ok: true } | PasskeyFailure> {
  const credential = await prisma.webAuthnCredential.findFirst({
    where: { id: input.id, memberId: input.memberId },
    select: { id: true, name: true, credentialId: true },
  });
  if (!credential) {
    return { ok: false, status: 400, error: "That passkey is no longer saved." };
  }

  const [member, remaining] = await Promise.all([
    prisma.member.findUnique({
      where: { id: input.memberId },
      select: { twoFactorEnabled: true, twoFactorMethod: true },
    }),
    prisma.webAuthnCredential.count({
      where: { memberId: input.memberId, id: { not: credential.id } },
    }),
  ]);
  const stillOfficerFactor = satisfiesOfficerSecondFactor({
    twoFactorEnabled: member?.twoFactorEnabled,
    twoFactorMethod: member?.twoFactorMethod,
    hasPasskey: remaining > 0,
  });
  if (!stillOfficerFactor) {
    try {
      await assertLastFactorRemovable(input.memberId);
    } catch (error) {
      if (error instanceof LastOfficerFactorError) {
        return {
          ok: false,
          status: 400,
          error: "Keep an authenticator app or another passkey before removing this one.",
        };
      }
      throw error;
    }
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const result = await tx.webAuthnCredential.deleteMany({
      where: { id: credential.id, memberId: input.memberId },
    });
    if (result.count !== 1) return false;
    await auditPasskey({
      action: TWO_FACTOR_AUDIT_ACTIONS.passkeyRemoved,
      memberId: input.memberId,
      actor: input.actor,
      request: input.request,
      passkeyName: credential.name,
      credentialId: credential.credentialId,
      db: tx,
    });
    return true;
  });
  if (!deleted) {
    return { ok: false, status: 400, error: "That passkey is no longer saved." };
  }
  return { ok: true };
}

class PasskeyCapError extends Error {
  constructor() {
    super("passkey cap");
    this.name = "PasskeyCapError";
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function counterRegression(error: unknown): { reported: number; stored: number } | null {
  if (!(error instanceof Error)) return null;
  const match = COUNTER_REGRESSED.exec(error.message);
  if (!match) return null;
  return { reported: Number(match[1]), stored: Number(match[2]) };
}

function readCredentialId(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("id" in response)) return null;
  const id = (response as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0 || id.length > 1024) return null;
  return id;
}

function transportList(response: unknown, fallback: string[] | undefined): string[] {
  const fromResponse =
    typeof response === "object" &&
    response !== null &&
    "response" in response &&
    typeof (response as { response?: { transports?: unknown } }).response === "object"
      ? (response as { response?: { transports?: unknown } }).response?.transports
      : undefined;
  const source = Array.isArray(fromResponse) ? fromResponse : fallback;
  if (!source) return [];
  return source.filter((item): item is string => typeof item === "string" && item.length <= 32);
}
