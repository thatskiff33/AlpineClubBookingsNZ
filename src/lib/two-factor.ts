import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from "crypto";
import * as OTPAuth from "otpauth";
import type { TwoFactorMethod } from "@prisma/client";
import { getClubIdentitySync } from "@/lib/club-identity-settings";
import { getAuthSecret } from "@/lib/runtime-config";
import { prisma } from "@/lib/prisma";
import {
  assertTwoFactorActorMayAct,
  recordTwoFactorMutation,
  TWO_FACTOR_AUDIT_ACTIONS,
  type TwoFactorActor,
  type TwoFactorRequestContext,
} from "@/lib/two-factor-audit";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTION_VERSION = "v1";

const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_SESSION_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const TWO_FACTOR_RECOVERY_CODE_COUNT = 10;
const TWO_FACTOR_TOTP_PERIOD_SECONDS = 30;
const TWO_FACTOR_TOTP_WINDOW = 1;
// test seam
export const TWO_FACTOR_MAX_FAILED_ATTEMPTS = 5;
const TWO_FACTOR_LOCKOUT_MS = 15 * 60 * 1000;

function getSecretMaterial() {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for two-factor authentication");
  }
  return secret;
}

function getEncryptionKey(): Buffer {
  return createHash("sha256")
    .update(getSecretMaterial())
    .update(":two-factor-secret:v1")
    .digest();
}

function getHashKey(): Buffer {
  return createHash("sha256")
    .update(getSecretMaterial())
    .update(":two-factor-code:v1")
    .digest();
}

// test seam
export function encryptTwoFactorSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted,
  ].join(":");
}

// test seam
export function decryptTwoFactorSecret(encrypted: string): string {
  const [version, ivHex, authTagHex, ciphertext] = encrypted.split(":");
  if (version !== ENCRYPTION_VERSION || !ivHex || !authTagHex || !ciphertext) {
    throw new Error("Invalid encrypted two-factor secret format");
  }
  const authTag = Buffer.from(authTagHex, "hex");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted two-factor secret authentication tag length");
  }
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    getEncryptionKey(),
    Buffer.from(ivHex, "hex"),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function normalizeOtpCode(code: string) {
  return code.replace(/\s+/g, "").trim();
}

function normalizeRecoveryCode(code: string) {
  return code.replace(/[\s-]+/g, "").trim().toUpperCase();
}

// test seam
export function hashTwoFactorCode(code: string) {
  return createHmac("sha256", getHashKey()).update(code).digest("hex");
}

// test seam
export function hashEmailOtpCode(code: string) {
  return hashTwoFactorCode(normalizeOtpCode(code));
}

// test seam
export function hashRecoveryCode(code: string) {
  return hashTwoFactorCode(normalizeRecoveryCode(code));
}

function generateEmailOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function generateRecoveryCode() {
  const raw = randomBytes(6).toString("hex").toUpperCase();
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

function generateRecoveryCodes(count = TWO_FACTOR_RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

function buildTotp(secretBase32: string, label: string) {
  return new OTPAuth.TOTP({
    // DB-first club name via the self-warming sync accessor (E3 #1929): the
    // TOTP issuer/label can lag a rename by up to the sync cache TTL, which only
    // affects NEW enrolments (existing authenticators keep their embedded issuer).
    issuer: getClubIdentitySync().name,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: TWO_FACTOR_TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function generateTotpEnrollment(label: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const secretBase32 = secret.base32;
  const totp = buildTotp(secretBase32, label);

  return {
    secret: secretBase32,
    otpauthUrl: totp.toString(),
    issuer: getClubIdentitySync().name,
    label,
  };
}

export function verifyTotpCode(secretBase32: string, code: string) {
  const token = normalizeOtpCode(code);
  if (!/^\d{6}$/.test(token)) {
    return false;
  }

  // The label is metadata only — validate() ignores it, computing from the
  // secret/algorithm/digits/period — so the sync accessor's short lag is
  // irrelevant to verification here.
  return buildTotp(secretBase32, getClubIdentitySync().bookingsName).validate({
    token,
    window: TWO_FACTOR_TOTP_WINDOW,
  }) !== null;
}

export async function createTwoFactorEmailCode(memberId: string) {
  const code = generateEmailOtpCode();
  const expiresAt = new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS);

  await prisma.$transaction([
    prisma.twoFactorEmailCode.deleteMany({
      where: { memberId, used: false },
    }),
    prisma.twoFactorEmailCode.create({
      data: {
        memberId,
        codeHash: hashEmailOtpCode(code),
        expiresAt,
      },
    }),
  ]);

  return { code, expiresAt };
}

export async function verifyTwoFactorEmailCode(memberId: string, code: string) {
  const record = await prisma.twoFactorEmailCode.findUnique({
    where: { codeHash: hashEmailOtpCode(code) },
  });

  if (
    !record ||
    record.memberId !== memberId ||
    record.used ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    return false;
  }

  const updated = await prisma.twoFactorEmailCode.updateMany({
    where: { id: record.id, used: false },
    data: { used: true },
  });
  return updated.count === 1;
}

// Mints a single-use, server-side proof that this member just passed a
// two-factor challenge. Only the HMAC hash is stored; the raw token travels
// through the Auth.js session update within the same request and is consumed
// by the jwt callback, so a client-forged POST to /api/auth/session can never
// flip twoFactorVerified.
export async function createTwoFactorSessionChallenge(memberId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TWO_FACTOR_SESSION_CHALLENGE_TTL_MS);

  await prisma.$transaction([
    // Housekeeping only: expired tokens are already unusable. Live tokens for
    // the member are left alone so concurrent challenges cannot race.
    prisma.twoFactorSessionChallenge.deleteMany({
      where: { memberId, expiresAt: { lte: new Date() } },
    }),
    prisma.twoFactorSessionChallenge.create({
      data: {
        memberId,
        tokenHash: hashTwoFactorCode(token),
        expiresAt,
      },
    }),
  ]);

  return token;
}

export async function consumeTwoFactorSessionChallenge(
  memberId: string,
  token: string,
) {
  // Delete-and-count keeps consumption atomic: of two concurrent updates
  // presenting the same token, exactly one can succeed.
  const deleted = await prisma.twoFactorSessionChallenge.deleteMany({
    where: {
      tokenHash: hashTwoFactorCode(token),
      memberId,
      expiresAt: { gt: new Date() },
    },
  });

  return deleted.count === 1;
}

export function getActiveTwoFactorLockout(member?: {
  twoFactorLockedUntil?: Date | null;
} | null) {
  if (
    member?.twoFactorLockedUntil instanceof Date &&
    member.twoFactorLockedUntil.getTime() > Date.now()
  ) {
    return member.twoFactorLockedUntil;
  }

  return null;
}

export async function recordTwoFactorFailure(memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { twoFactorFailedAttempts: true },
  });
  const nextAttempts = (member?.twoFactorFailedAttempts ?? 0) + 1;
  const lockedUntil =
    nextAttempts >= TWO_FACTOR_MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + TWO_FACTOR_LOCKOUT_MS)
      : null;

  await prisma.member.update({
    where: { id: memberId },
    data: {
      twoFactorFailedAttempts: lockedUntil ? 0 : nextAttempts,
      twoFactorLockedUntil: lockedUntil,
    },
  });

  return lockedUntil;
}

export async function clearTwoFactorLockout(memberId: string) {
  await prisma.member.update({
    where: { id: memberId },
    data: {
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
    },
  });
}

export async function verifyStoredTotpCode(memberId: string, code: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { totpSecret: true },
  });

  if (!member?.totpSecret) {
    return false;
  }

  return verifyTotpCode(decryptTwoFactorSecret(member.totpSecret), code);
}

export async function consumeRecoveryCode(memberId: string, code: string) {
  const record = await prisma.twoFactorRecoveryCode.findUnique({
    where: { codeHash: hashRecoveryCode(code) },
  });

  if (!record || record.memberId !== memberId || record.usedAt) {
    return false;
  }

  const updated = await prisma.twoFactorRecoveryCode.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return updated.count === 1;
}

export async function replaceRecoveryCodes(params: {
  memberId: string;
  /** Who replaced them: the member themself on the regenerate route (#3454). */
  actor: TwoFactorActor;
  request?: TwoFactorRequestContext;
}) {
  const { memberId } = params;
  assertTwoFactorActorMayAct(
    TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced,
    params.actor,
    memberId,
  );
  const recoveryCodes = generateRecoveryCodes();

  // ONE interactive transaction, so the audit row commits with the new codes
  // or neither does (#3454): replacing them invalidates every unused code, the
  // same class of credential change as an enrolment.
  await prisma.$transaction(async (tx) => {
    await tx.twoFactorRecoveryCode.deleteMany({ where: { memberId } });
    await tx.twoFactorRecoveryCode.createMany({
      data: recoveryCodes.map((code) => ({
        memberId,
        codeHash: hashRecoveryCode(code),
      })),
    });
    await recordTwoFactorMutation(tx, {
      action: TWO_FACTOR_AUDIT_ACTIONS.recoveryCodesReplaced,
      actor: params.actor,
      subjectMemberId: memberId,
      method: null,
      authenticatorApp: false,
      recoveryCodesIssued: recoveryCodes.length,
      request: params.request,
    });
  });

  return recoveryCodes;
}

export async function enrollTwoFactor(params: {
  memberId: string;
  method: TwoFactorMethod;
  totpSecret?: string | null;
  /** Who enrolled — the member themself on the enrolment routes (#3454). */
  actor: TwoFactorActor;
  request?: TwoFactorRequestContext;
}) {
  // A member actor must be the member being enrolled (#3454 review).
  assertTwoFactorActorMayAct(TWO_FACTOR_AUDIT_ACTIONS.enrolled, params.actor, params.memberId);
  const recoveryCodes = generateRecoveryCodes();
  const storesTotpSecret = params.method === "TOTP" && Boolean(params.totpSecret);
  const encryptedTotpSecret =
    storesTotpSecret && params.totpSecret
      ? encryptTwoFactorSecret(params.totpSecret)
      : null;

  // ONE interactive transaction, so the audit row commits with the enrolment
  // or neither does (#3454). It was an array transaction, which cannot write a
  // row through `createAuditLog`.
  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: params.memberId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: params.method,
        totpSecret: encryptedTotpSecret,
        twoFactorEnrolledAt: new Date(),
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: null,
      },
    });
    await tx.twoFactorRecoveryCode.deleteMany({
      where: { memberId: params.memberId },
    });
    await tx.twoFactorRecoveryCode.createMany({
      data: recoveryCodes.map((code) => ({
        memberId: params.memberId,
        codeHash: hashRecoveryCode(code),
      })),
    });
    await tx.twoFactorEmailCode.deleteMany({
      where: { memberId: params.memberId },
    });
    await recordTwoFactorMutation(tx, {
      action: TWO_FACTOR_AUDIT_ACTIONS.enrolled,
      actor: params.actor,
      subjectMemberId: params.memberId,
      method: params.method,
      authenticatorApp: storesTotpSecret,
      request: params.request,
    });
  });

  return recoveryCodes;
}
