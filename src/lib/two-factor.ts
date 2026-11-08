import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from "crypto";
import * as OTPAuth from "otpauth";
import type { TwoFactorMethod } from "@prisma/client";
import { getClubIdentitySync } from "@/lib/club-identity-settings";
import {
  DataKeyRingError,
  LEGACY_AUTH_SECRET_KEY_ID,
  deriveDataSubkey,
  legacySecretOf,
  type DataKey,
} from "@/lib/data-encryption-key-material";
import {
  LEGACY_READS_RETIRED_MESSAGE,
  codeHashKeys,
  currentDataKey,
  dataKeyById,
  legacyReadsRetired,
} from "@/lib/data-encryption-keys";
import { assertLegacyWriteAllowed } from "@/lib/data-encryption-legacy-write-guard";
import { prisma } from "@/lib/prisma";
import {
  LEGACY_ENCRYPTION_VERSION,
  RING_ENCRYPTION_VERSION,
  codeHashKeyId,
  keyedCodeHash,
  parseTwoFactorSecret,
  type TwoFactorSecretEnvelope,
} from "@/lib/two-factor-key-format";
import {
  assertTwoFactorActorMayAct,
  recordTwoFactorMutation,
  TWO_FACTOR_AUDIT_ACTIONS,
  type TwoFactorPersonActor,
  type TwoFactorRequestContext,
} from "@/lib/two-factor-audit";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
/** HKDF purpose of the authenticator ring sub-key; the legacy label below stays frozen. */
const TOTP_SECRET_RING_PURPOSE = "two-factor-secret:v2";
const NO_KEY_MESSAGE =
  "AUTH_SECRET or NEXTAUTH_SECRET is required for two-factor authentication";

const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_SESSION_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const TWO_FACTOR_RECOVERY_CODE_COUNT = 10;
const TWO_FACTOR_TOTP_PERIOD_SECONDS = 30;
const TWO_FACTOR_TOTP_WINDOW = 1;
// test seam
export const TWO_FACTOR_MAX_FAILED_ATTEMPTS = 5;
const TWO_FACTOR_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The key every two-factor WRITE uses (`data-encryption-keys.ts`): the ring's
 * current key, or the auth secret while no ring is set — in which case every
 * format below is byte-for-byte what it was before #4456.
 */
function writeKey(): DataKey {
  const key = currentDataKey();
  if (!key) throw new Error(NO_KEY_MESSAGE);
  return key;
}

/**
 * Refuse a durable two-factor write (an enrolment, replacement recovery codes)
 * that would fall back to the auth secret while stored data names a ring key
 * (#4456 review): the same rule, from the same place, as credential capture
 * (`data-encryption-legacy-write-guard.ts`). Throws `DataKeyRingMissingError`,
 * which the route reports as a server error. A ring write never asks. Email
 * codes and session challenges are short-lived and exempt; see the note above
 * `createTwoFactorEmailCode`.
 */
async function assertTwoFactorWriteAllowed(
  db: Parameters<typeof assertLegacyWriteAllowed>[0],
): Promise<void> {
  if (writeKey().legacy) await assertLegacyWriteAllowed(db);
}

/** The AES key for an authenticator secret: frozen legacy formula, or ring sub-key. */
function totpEncryptionKey(key: DataKey): Buffer {
  if (!key.legacy) return deriveDataSubkey(key, TOTP_SECRET_RING_PURPOSE);
  return createHash("sha256")
    .update(legacySecretOf(key))
    .update(":two-factor-secret:v1")
    .digest();
}

// test seam
export function encryptTwoFactorSecret(plaintext: string): string {
  const key = writeKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, totpEncryptionKey(key), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return [
    ...(key.legacy ? [LEGACY_ENCRYPTION_VERSION] : [RING_ENCRYPTION_VERSION, key.id]),
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted,
  ].join(":");
}

/**
 * The key a stored authenticator secret names — `v1` the legacy key, `v2` its
 * ring id — and that key alone; never the others in turn. The envelope is read
 * by `parseTwoFactorSecret`, the same parser the setup count uses.
 */
function totpKeyFor(stored: string): { key: DataKey; envelope: TwoFactorSecretEnvelope } {
  const envelope = parseTwoFactorSecret(stored);
  if (!envelope) {
    throw new Error("Invalid encrypted two-factor secret format");
  }
  const key = dataKeyById(envelope.keyId);
  if (!key) {
    throw new Error(
      envelope.keyId === LEGACY_AUTH_SECRET_KEY_ID
        ? legacyReadsRetired()
          ? `This two-factor secret cannot be read: ${LEGACY_READS_RETIRED_MESSAGE}`
          : NO_KEY_MESSAGE
        : `The data-encryption key "${envelope.keyId}" this two-factor secret was written under is not in DATA_ENCRYPTION_KEYS`,
    );
  }
  return { key, envelope };
}

// test seam
export function decryptTwoFactorSecret(encrypted: string): string {
  const { key, envelope } = totpKeyFor(encrypted);
  const { ivHex, authTagHex, ciphertextHex: ciphertext } = envelope;
  const authTag = Buffer.from(authTagHex, "hex");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted two-factor secret authentication tag length");
  }
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    totpEncryptionKey(key),
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

/** The hash a new code is STORED under: the current key's (test seam). */
export function hashTwoFactorCode(code: string) {
  return keyedCodeHash(writeKey(), code);
}

/**
 * Every hash a presented code may be stored under, for a LOOKUP (`codeHash IN
 * …`): one per ring key, or the legacy hash alone while no ring is set. Once a
 * ring is set the legacy hash is not a candidate, which is what retires the
 * recovery codes issued under the auth secret (owner decision on #4456).
 */
export function twoFactorCodeHashCandidates(code: string): string[] {
  const keys = codeHashKeys();
  if (keys.length === 0) throw new Error(NO_KEY_MESSAGE);
  return keys.map((key) => keyedCodeHash(key, code));
}

// test seam
export function hashEmailOtpCode(code: string) {
  return hashTwoFactorCode(normalizeOtpCode(code));
}

// test seam
export function hashRecoveryCode(code: string) {
  return hashTwoFactorCode(normalizeRecoveryCode(code));
}

/**
 * Is a stored recovery-code hash one no lookup can match any more — written
 * under a key `codeHashKeys()` no longer returns? A legacy (unprefixed) hash is
 * retired the moment a ring is set; a ring hash, when its key leaves the ring.
 */
export function isRetiredRecoveryCodeHash(codeHash: string): boolean {
  const id = codeHashKeyId(codeHash);
  return !codeHashKeys().some((key) => key.id === id);
}


/**
 * Does this member still hold unused recovery codes that can no longer sign
 * them in? Drives the notice telling them to generate a new set (owner
 * decision on #4456: legacy codes are invalidated at cut-over and the affected
 * members are told). Advisory, so an invalid ring answers false rather than
 * breaking the page that asks; the sign-in itself still fails closed.
 */
export async function memberHoldsRetiredRecoveryCodes(memberId: string): Promise<boolean> {
  const codes = await prisma.twoFactorRecoveryCode.findMany({
    where: { memberId, usedAt: null },
    select: { codeHash: true },
  });
  try {
    return codes.some((code) => isRetiredRecoveryCodeHash(code.codeHash));
  } catch (error) {
    if (error instanceof DataKeyRingError) return false;
    throw error;
  }
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

// Not refused while a ring is missing (#4456 review), unlike the durable writers
// that call assertTwoFactorWriteAllowed, and nor is the session challenge below.
// Both are short-lived — an email code ten minutes, a challenge two — so a legacy
// hash leaves nothing depending on AUTH_SECRET once it expires. Refusing them
// would lock out every email two-factor member, admins included, who then could
// not reach Admin → Setup to see why.
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
  const record = await prisma.twoFactorEmailCode.findFirst({
    where: { memberId, codeHash: { in: twoFactorCodeHashCandidates(normalizeOtpCode(code)) } },
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
//
// Not refused while a ring is missing (#4456 review): short-lived, like the email
// code above. It never leaves the sign-in that mints it, lives two minutes and is
// consumed under the same key.
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
      tokenHash: { in: twoFactorCodeHashCandidates(token) },
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
  const record = await prisma.twoFactorRecoveryCode.findFirst({
    where: { memberId, codeHash: { in: twoFactorCodeHashCandidates(normalizeRecoveryCode(code)) } },
  });

  if (!record || record.memberId !== memberId || record.usedAt) {
    return false;
  }

  // Claimed on the hash it matched too, so a code the data-key re-encrypt
  // retired meanwhile (its hash rewritten) is not used after all (#4456).
  const updated = await prisma.twoFactorRecoveryCode.updateMany({
    where: { id: record.id, codeHash: record.codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  return updated.count === 1;
}

export async function replaceRecoveryCodes(params: {
  memberId: string;
  /** Who replaced them: the member themself on the regenerate route (#3454). Never a job. */
  actor: TwoFactorPersonActor;
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
    await assertTwoFactorWriteAllowed(tx);
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
  /** Who enrolled — the member themself on the enrolment routes (#3454). Never a job. */
  actor: TwoFactorPersonActor;
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
    await assertTwoFactorWriteAllowed(tx);
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
