/**
 * Moving stored data to the current data-encryption key (#4456, plan step 5):
 * the library behind `pnpm run data-keys:reencrypt`.
 *
 * WHAT MOVES. Every integration credential and every authenticator secret not
 * already under the ring's CURRENT key — whether under `AUTH_SECRET` or an
 * older ring key — is re-encrypted, unchanged, under it. Recovery-code hashes
 * cannot be re-keyed (`two-factor-key-format.ts`); with
 * `retireLegacyRecoveryCodes` the unused ones hashed under the auth secret are
 * retired instead (owner decision of 1 Nov 2026), and either way they are
 * counted.
 *
 * HOW, AND WHY THIS IS SAFE BESIDE THE LIVE APP (`INV-LOCK-001`..`003`; no
 * advisory key is taken or added). One row is one short transaction with no
 * provider call in it, through the writers that already own each row:
 *   - a credential goes through `withCredentialTransaction` and the store's
 *     compare-and-set (`expect: version`), read and claimed on the same
 *     transaction, and its audit row names the `data-key-reencrypt` job
 *     (INV-PRIV-020). The Xero token set is fenced first by the token store's
 *     own lease rows, in their lock order (`fenceXeroTokenSetRewrite`), so a
 *     refresh that has spent its token always gets to save it;
 *   - an authenticator secret and a recovery code go through
 *     `two-factor-rekey.ts`, each update guarded on the exact value read.
 * A row that changed underneath loses its claim: no write, no audit row, no
 * side effect. It is retried on the next pass, up to `maxPasses`; what still
 * loses is reported, and a later run picks it up.
 *
 * IT ONLY WRITES UNDER THE KEY THE OPERATOR NAMED (#4456 review). The command
 * reads its ring from the environment it is started in — and the database
 * client loads `.env` from the current directory for any variable not
 * exported — so a stale ring could re-encrypt everything under a key the app
 * does not hold, or move the app's newer-key rows back to an older key. So a
 * run that writes REQUIRES `--expect-fingerprint`, copied from Admin → Setup's
 * fingerprint of the app's CURRENT key, and refuses unless its own target key
 * has that fingerprint. As a second guard it decrypts a row already stored
 * under the target id and refuses if it cannot (`checkTargetKey`). A dry run
 * needs no fingerprint, and prints the target key's.
 *
 * NOTHING HERE PRINTS A VALUE. Rows are named by provider and key, or counted;
 * a plaintext lives only between the read and the write of its own row.
 */

import type { Prisma } from "@prisma/client";

import {
  DATA_ENCRYPTION_KEYS_ENV,
  DATA_ENCRYPTION_LEGACY_KEY_ENV,
  DATA_KEY_REENCRYPT_JOB_NAME,
  LEGACY_KEY_RETIRED,
  DataKeyRingError,
  dataKeyFingerprint,
  type DataKey,
} from "@/lib/data-encryption-key-material";
import { readDataKeyRing } from "@/lib/data-encryption-keys";
import { credentialVersionOf, StaleCredentialWriteError } from "@/lib/integration-credential-actor";
import {
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  withCredentialTransaction,
} from "@/lib/integration-credentials";
import { DATA_KEY_SOURCE_PREFIX } from "@/lib/integration-crypto";
import { prisma } from "@/lib/prisma";
import { exactContains, exactPrefix } from "@/lib/prisma-exact-prefix";
import { RETIRED_RECOVERY_CODE_KEY_ID, RING_ENCRYPTION_VERSION } from "@/lib/two-factor-key-format";
import {
  LEGACY_RECOVERY_CODE_WHERE,
  retireLegacyRecoveryCodes,
  rewrapTwoFactorSecret,
  type RekeyOutcome,
} from "@/lib/two-factor-rekey";
import { decryptTwoFactorSecret } from "@/lib/two-factor";
import { fenceXeroTokenSetRewrite, XERO_OAUTH_TOKEN_PROVIDER } from "@/lib/xero-token-store";

/** Passes before what still loses its claim is reported rather than retried. */
export const DEFAULT_MAX_PASSES = 3;
/** The pause before a retry pass: long enough for a Xero refresh to save. */
export const RETRY_PAUSE_MS = 2_000;

/** The run was refused before anything was read: no usable ring. Safe to print. */
export class ReencryptRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReencryptRefusedError";
  }
}

export interface ReencryptOptions {
  /** Read and count only; write nothing. */
  dryRun: boolean;
  /** Also retire the unused recovery codes hashed under the auth secret. */
  retireLegacyRecoveryCodes: boolean;
  /**
   * The fingerprint Admin → Setup shows for the app's current key. Required
   * unless `dryRun`; the run refuses unless its target key has it.
   */
  expectFingerprint?: string;
  maxPasses?: number;
  /** test seam: how to wait between passes. */
  pause?: (ms: number) => Promise<void>;
  /** test seam: only these rows. The command never passes it. */
  scope?: { providers?: readonly string[]; memberIds?: readonly string[] };
}

/** One table's run. `moved` is "would move" in a dry run. */
export interface StoreTally {
  moved: number;
  /** Claims lost to a concurrent writer in the last pass that tried them. */
  lostClaims: number;
  unreadable: number;
  /** Rows not under the current key once the run ended, counted afresh. */
  remaining: number;
}

export interface ReencryptReport {
  currentKeyId: string;
  /** `dataKeyFingerprint` of the key moved to: compare it with Admin → Setup's. */
  currentKeyFingerprint: string;
  /** What proved this environment's key is the app's, or null when nothing could yet. */
  keyCheckedAgainst: "a stored credential" | "a stored authenticator secret" | null;
  /** True when `--expect-fingerprint` was given and matched (always, for a run that wrote). */
  fingerprintConfirmed: boolean;
  /** The command that moves the rows, for a dry run to print. */
  runCommand: string;
  dryRun: boolean;
  passes: number;
  credentials: StoreTally;
  authenticatorSecrets: StoreTally;
  recoveryCodes: {
    /** Unused codes still hashed under the auth secret, after the run. */
    legacyUnused: number;
    /** Codes retired by this run ("would retire" in a dry run). */
    retired: number;
    /** Unused codes under a ring key that is not the current one. */
    olderRingKeyUnused: number;
  };
}

/**
 * The key the run moves rows to: the ring's current key. Refuses, with a
 * message naming no value, when no ring is set or it is invalid — the
 * re-encrypt only ever moves data AWAY from the auth secret.
 */
export function requireReencryptTarget(): DataKey {
  const ring = readDataKeyRing();
  if (ring.status === "invalid") {
    throw new ReencryptRefusedError(`Refused: ${ring.reason}`);
  }
  if (ring.status === "unset") {
    throw new ReencryptRefusedError(
      `Refused: ${DATA_ENCRYPTION_KEYS_ENV} is not set, so there is no key to move stored data to. Set it first (CONFIGURATION.md → Data-encryption keys).`,
    );
  }
  return ring.current;
}

type Outcome = RekeyOutcome | "already-current" | "gone";

/** Rolls a credential transaction back without a write, carrying why. */
class RowNotMoved extends Error {
  constructor(readonly outcome: Exclude<Outcome, "moved">) {
    super(outcome);
  }
}

interface CredentialRow {
  provider: string;
  key: string;
}

function scopeWhere(options: ReencryptOptions) {
  return {
    credential: options.scope?.providers ? { provider: { in: [...options.scope.providers] } } : {},
    member: options.scope?.memberIds ? { id: { in: [...options.scope.memberIds] } } : {},
    code: options.scope?.memberIds ? { memberId: { in: [...options.scope.memberIds] } } : {},
  };
}

/** Credential rows not under `target`, in a fixed order. */
function credentialsOffTarget(target: DataKey, options: ReencryptOptions): Prisma.IntegrationCredentialWhereInput {
  return { ...scopeWhere(options).credential, NOT: { secretSource: `${DATA_KEY_SOURCE_PREFIX}${target.id}` } };
}

/** Authenticator secrets not under `target`. */
function secretsOffTarget(target: DataKey, options: ReencryptOptions): Prisma.MemberWhereInput {
  return {
    ...scopeWhere(options).member,
    AND: [
      { totpSecret: { not: null } },
      { NOT: { totpSecret: exactPrefix(`${RING_ENCRYPTION_VERSION}:${target.id}:`) } },
    ],
  };
}

/**
 * Unused recovery codes under a ring key other than `target`: a `:` (so not
 * legacy), and neither the current key's prefix nor the retired marker.
 */
function olderRingKeyCodes(target: DataKey, options: ReencryptOptions): Prisma.TwoFactorRecoveryCodeWhereInput {
  return {
    ...scopeWhere(options).code,
    usedAt: null,
    codeHash: exactContains(":"),
    NOT: [
      { codeHash: exactPrefix(`${target.id}:`) },
      { codeHash: exactPrefix(`${RETIRED_RECOVERY_CODE_KEY_ID}:`) },
    ],
  };
}

/** Move one credential row, claimed on the version read inside its transaction. */
async function moveCredential(row: CredentialRow, target: DataKey): Promise<Outcome> {
  const targetSource = `${DATA_KEY_SOURCE_PREFIX}${target.id}`;
  try {
    await withCredentialTransaction([row.provider], async (tx) => {
      if (
        row.provider === XERO_OAUTH_TOKEN_PROVIDER &&
        !(await fenceXeroTokenSetRewrite(tx))
      ) {
        throw new RowNotMoved("lost-claim");
      }
      const stored = await readIntegrationCredentialRow(tx, row.provider, row.key);
      if (stored.status === "not_configured") throw new RowNotMoved("gone");
      if (stored.status === "needs_reentry") throw new RowNotMoved("unreadable");
      if (stored.secretSource === targetSource) throw new RowNotMoved("already-current");
      // The row's own timestamp, kept: the same value under a new key is not a
      // newer credential, and verified markers compare it (#4456 review C3).
      // Read AFTER `stored` and checked against its version (review round 2),
      // so a write landing between the two reads makes this move lose instead
      // of having its timestamp rolled back; a later one fails the claim.
      const stamp = await tx.integrationCredential.findUnique({
        where: { provider_key: { provider: row.provider, key: row.key } },
        select: { ciphertext: true, iv: true, authTag: true, updatedAt: true },
      });
      if (!stamp || credentialVersionOf(stamp) !== stored.version) throw new RowNotMoved("lost-claim");
      await setIntegrationCredentialInTransaction({
        tx,
        provider: row.provider,
        key: row.key,
        value: stored.value,
        actor: { kind: "system", actor: DATA_KEY_REENCRYPT_JOB_NAME },
        expect: { expect: "version", version: stored.version },
        cause: { kind: "data-key-reencrypt" },
        keepUpdatedAt: stamp.updatedAt,
      });
    });
    return "moved";
  } catch (error) {
    if (error instanceof RowNotMoved) return error.outcome;
    if (error instanceof StaleCredentialWriteError) return "lost-claim";
    throw error;
  }
}

/** A dry run's verdict on a credential: readable now, or not. Writes nothing. */
async function inspectCredential(row: CredentialRow): Promise<Outcome> {
  const stored = await readIntegrationCredentialRow(prisma, row.provider, row.key);
  if (stored.status === "not_configured") return "gone";
  return stored.status === "configured" ? "moved" : "unreadable";
}

/** A dry run's verdict on an authenticator secret. Writes nothing. */
function inspectSecret(stored: string): Outcome {
  try {
    decryptTwoFactorSecret(stored);
    return "moved";
  } catch (error) {
    if (error instanceof DataKeyRingError) throw error;
    return "unreadable";
  }
}

function emptyTally(): StoreTally {
  return { moved: 0, lostClaims: 0, unreadable: 0, remaining: 0 };
}

/**
 * Run `move` over `items`, retrying the ones that lost their claim on the next
 * pass. Returns the tally and how many passes ran.
 */
async function inPasses<T>(
  items: readonly T[],
  move: (item: T) => Promise<Outcome>,
  options: ReencryptOptions,
): Promise<{ tally: StoreTally; passes: number }> {
  const tally = emptyTally();
  const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_MAX_PASSES);
  let pending = [...items];
  let passes = 0;
  while (pending.length > 0 && passes < maxPasses) {
    if (passes > 0) await (options.pause ?? defaultPause)(RETRY_PAUSE_MS);
    passes += 1;
    const lost: T[] = [];
    for (const item of pending) {
      const outcome = await move(item);
      if (outcome === "moved") tally.moved += 1;
      else if (outcome === "unreadable") tally.unreadable += 1;
      else if (outcome === "lost-claim") lost.push(item);
    }
    pending = lost;
  }
  tally.lostClaims = pending.length;
  return { tally, passes };
}

function defaultPause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a fingerprint looks like (`dataKeyFingerprint`): four groups of four hex digits. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/i;

/** A fingerprint as an operator may paste it: case and surrounding space ignored. */
function normaliseFingerprint(text: string): string {
  return text.trim().toLowerCase();
}

/** The flag as an instruction. Its value only ever comes from the app's own page. */
const RUN_COMMAND_PLACEHOLDER = "pnpm run data-keys:reencrypt --expect-fingerprint <fingerprint from Admin → Setup>";

/**
 * The first guard on the target key: a run that writes must name the app's
 * current key by its fingerprint (`--expect-fingerprint`, from Admin → Setup),
 * and this command's target key must have it. Refuses before anything is read.
 * Resolves whether a fingerprint was given and matched; a dry run may omit it.
 */
function requireExpectedFingerprint(target: DataKey, options: ReencryptOptions): boolean {
  const actual = dataKeyFingerprint(target);
  if (options.expectFingerprint === undefined) {
    if (options.dryRun) return false;
    // No fingerprint of this command's own key here (round 3): only the app's
    // page may supply the value, so nothing here offers one to copy.
    throw new ReencryptRefusedError(
      `Refused: a run that writes needs --expect-fingerprint <fingerprint from Admin → Setup>: the fingerprint Admin → Setup → "Data Encryption Key" shows for the app's current key. Run with --dry-run to see what would move.`,
    );
  }
  // The supplied value is never echoed (round 3): a mis-paste may be a key.
  if (!FINGERPRINT_PATTERN.test(options.expectFingerprint.trim())) {
    throw new ReencryptRefusedError(
      "Refused before reading anything: --expect-fingerprint is not a fingerprint (four groups of four hex digits, as Admin → Setup shows it). The value given is not repeated here.",
    );
  }
  if (normaliseFingerprint(options.expectFingerprint) !== actual) {
    throw new ReencryptRefusedError(
      `Refused before reading anything: this command would write under its key "${target.id}" (fingerprint ${actual}), but --expect-fingerprint names a different key. Its ${DATA_ENCRYPTION_KEYS_ENV} is not the app's: a stale .env, or a ring whose first key is not the app's current one. Variables exported in this shell win; anything unset is read from the .env in the current directory.`,
    );
  }
  return true;
}

/** How many stored rows under the target id the key check tries, newest first. */
const KEY_CHECK_CANDIDATES = 5;

/**
 * The second guard on the target key (the first is `--expect-fingerprint`):
 * decrypt a credential, else an authenticator secret, already stored under the
 * target id, newest first. A row that cannot be read here refuses the run
 * (`ReencryptRefusedError`); a row that vanished between its lookup and its
 * read proves nothing, so the next candidate is tried. Null when nothing under
 * the target id could be read: the first cut-over. It proves only that this
 * command's key decrypts data stored under that id.
 */
async function checkTargetKey(
  target: DataKey,
  options: ReencryptOptions,
): Promise<ReencryptReport["keyCheckedAgainst"]> {
  const refuse = () =>
    new ReencryptRefusedError(
      `Refused before writing anything: data the app stored under the key "${target.id}" cannot be read with the "${target.id}" this command holds (fingerprint ${dataKeyFingerprint(target)}). Either this environment's ${DATA_ENCRYPTION_KEYS_ENV} is not the app's, or that row is damaged. Variables exported in this shell win; anything unset is read from the .env in the current directory.`,
    );
  const credentials = await prisma.integrationCredential.findMany({
    where: { ...scopeWhere(options).credential, secretSource: `${DATA_KEY_SOURCE_PREFIX}${target.id}` },
    select: { provider: true, key: true },
    orderBy: { updatedAt: "desc" },
    take: KEY_CHECK_CANDIDATES,
  });
  for (const credential of credentials) {
    const stored = await readIntegrationCredentialRow(prisma, credential.provider, credential.key);
    if (stored.status === "needs_reentry") throw refuse();
    if (stored.status === "configured") return "a stored credential";
  }
  const members = await prisma.member.findMany({
    where: { ...scopeWhere(options).member, totpSecret: exactPrefix(`${RING_ENCRYPTION_VERSION}:${target.id}:`) },
    select: { totpSecret: true },
    orderBy: { updatedAt: "desc" },
    take: KEY_CHECK_CANDIDATES,
  });
  for (const member of members) {
    if (!member.totpSecret) continue;
    if (inspectSecret(member.totpSecret) === "unreadable") throw refuse();
    return "a stored authenticator secret";
  }
  return null;
}

/**
 * Move every row not under the current key to it, or (dry run) say what would
 * move. Refuses with `ReencryptRefusedError` before reading anything when the
 * ring is unset or invalid.
 */
export async function reencryptStoredData(options: ReencryptOptions): Promise<ReencryptReport> {
  const target = requireReencryptTarget();
  const scope = scopeWhere(options);
  const fingerprintConfirmed = requireExpectedFingerprint(target, options);
  const keyCheckedAgainst = await checkTargetKey(target, options);

  const credentialRows = await prisma.integrationCredential.findMany({
    where: credentialsOffTarget(target, options),
    select: { provider: true, key: true },
    orderBy: [{ provider: "asc" }, { key: "asc" }],
  });
  const credentials = await inPasses(
    credentialRows,
    (row) => (options.dryRun ? inspectCredential(row) : moveCredential(row, target)),
    options,
  );

  // Ids only: each secret is read just before its own claim.
  const members = await prisma.member.findMany({
    where: secretsOffTarget(target, options),
    select: { id: true },
    orderBy: { id: "asc" },
  });
  // A lost claim re-reads the member, so the retry claims on the value now stored.
  const secrets = await inPasses(
    members.map((member) => member.id),
    async (memberId) => {
      const fresh = await prisma.member.findFirst({
        where: { ...secretsOffTarget(target, options), id: memberId },
        select: { totpSecret: true },
      });
      if (!fresh?.totpSecret) return "already-current";
      if (options.dryRun) return inspectSecret(fresh.totpSecret);
      return rewrapTwoFactorSecret(memberId, fresh.totpSecret);
    },
    options,
  );

  const legacyCodes = { ...scope.code, usedAt: null, ...LEGACY_RECOVERY_CODE_WHERE };
  let retired = 0;
  if (options.retireLegacyRecoveryCodes) {
    if (options.dryRun) {
      retired = await prisma.twoFactorRecoveryCode.count({ where: legacyCodes });
    } else {
      const holders = await prisma.twoFactorRecoveryCode.findMany({
        where: legacyCodes,
        select: { memberId: true },
        distinct: ["memberId"],
        orderBy: { memberId: "asc" },
      });
      for (const { memberId } of holders) retired += await retireLegacyRecoveryCodes(memberId);
    }
  }

  const [credentialsRemaining, secretsRemaining, legacyUnused, olderRingKeyUnused] = await Promise.all([
    prisma.integrationCredential.count({ where: credentialsOffTarget(target, options) }),
    prisma.member.count({ where: secretsOffTarget(target, options) }),
    prisma.twoFactorRecoveryCode.count({ where: legacyCodes }),
    prisma.twoFactorRecoveryCode.count({ where: olderRingKeyCodes(target, options) }),
  ]);

  return {
    currentKeyId: target.id,
    currentKeyFingerprint: dataKeyFingerprint(target),
    keyCheckedAgainst,
    fingerprintConfirmed,
    runCommand: `${RUN_COMMAND_PLACEHOLDER}${options.retireLegacyRecoveryCodes ? " --retire-legacy-recovery-codes" : ""}`,
    dryRun: options.dryRun,
    passes: Math.max(credentials.passes, secrets.passes),
    credentials: { ...credentials.tally, remaining: credentialsRemaining },
    authenticatorSecrets: { ...secrets.tally, remaining: secretsRemaining },
    recoveryCodes: { legacyUnused, retired, olderRingKeyUnused },
  };
}

/** Did the run leave any ciphertext on an old key? (Recovery codes are not ciphertext.) */
export function reencryptLeftRows(report: ReencryptReport): boolean {
  return report.credentials.remaining > 0 || report.authenticatorSecrets.remaining > 0;
}

/** The report as lines for an operator. Counts, key ids and verdicts only: never a value. */
export function formatReencryptReport(report: ReencryptReport): string[] {
  const verb = report.dryRun ? "would move" : "moved";
  const store = (table: string, tally: StoreTally) => [
    `${table}: ${verb} ${tally.moved}, lost claim ${tally.lostClaims}, unreadable ${tally.unreadable}`,
    `${table}: remaining on old keys: ${tally.remaining}`,
  ];
  const lines = [
    `Data-encryption re-encrypt to the key "${report.currentKeyId}"${report.dryRun ? " (dry run: nothing written)" : ""}, ${report.passes} pass${report.passes === 1 ? "" : "es"}.`,
    ...(report.fingerprintConfirmed
      ? [`Key "${report.currentKeyId}", fingerprint ${report.currentKeyFingerprint}: matches --expect-fingerprint.`]
      : [
          `This command's key "${report.currentKeyId}" has the fingerprint ${report.currentKeyFingerprint}: compare with Admin → Setup, do not copy into the command.`,
          `If Admin → Setup → "Data Encryption Key" shows that same fingerprint for the app's current key, run: ${report.runCommand}`,
        ]),
    report.keyCheckedAgainst
      ? `Decrypt check: this command's key "${report.currentKeyId}" reads ${report.keyCheckedAgainst} stored under that id.`
      : `Decrypt check: nothing readable is stored under "${report.currentKeyId}" yet, so only the fingerprint vouches for the key.`,
    ...store("IntegrationCredential", report.credentials),
    ...store("Member.totpSecret", report.authenticatorSecrets),
    `TwoFactorRecoveryCode: legacy (AUTH_SECRET) unused: ${report.recoveryCodes.legacyUnused}${
      report.recoveryCodes.retired > 0
        ? `; ${report.dryRun ? "would retire" : "retired"} ${report.recoveryCodes.retired}`
        : ""
    }`,
    `TwoFactorRecoveryCode: unused under an older ring key: ${report.recoveryCodes.olderRingKeyUnused}`,
  ];
  if (report.credentials.lostClaims + report.authenticatorSecrets.lostClaims > 0) {
    lines.push("Some rows changed while being moved (for example a Xero token refresh). Run again to move them.");
  }
  if (report.credentials.unreadable + report.authenticatorSecrets.unreadable > 0) {
    lines.push(
      "Unreadable rows cannot be moved: their key is missing or retired. Restore the key and run again, or re-enter those credentials and ask those members to re-enrol their authenticator app.",
    );
  }
  if (report.recoveryCodes.legacyUnused > 0) {
    lines.push(
      "Legacy recovery codes no longer sign anyone in under the ring, but would on an instance without it. Run with --retire-legacy-recovery-codes to retire them in the database; their members are told to generate a new set.",
    );
  }
  if (report.recoveryCodes.olderRingKeyUnused > 0) {
    lines.push(
      "Keep each older key in the ring until its recovery codes are used or replaced: removing it retires them.",
    );
  }
  if (!report.dryRun && !reencryptLeftRows(report)) {
    lines.push(
      `No credential or authenticator secret is left on AUTH_SECRET or an older key. You can rotate AUTH_SECRET, and set ${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED} to stop reading anything under it.`,
    );
  }
  return lines;
}
