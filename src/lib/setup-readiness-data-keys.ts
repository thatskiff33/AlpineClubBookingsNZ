/**
 * The "Data Encryption Key" readiness step (#4456): is stored data wrapped by a
 * rotatable `DATA_ENCRYPTION_KEYS` ring key, or still by `AUTH_SECRET` alone?
 *
 * Pure, like the rest of `setup-readiness.ts`: the ring comes from the env the
 * caller passes, and the row counts from `SetupDatabaseSnapshot.dataKeyUsage`,
 * read by `setup-readiness-db.ts`. It never names or prints a key's value.
 *
 * Not a boot failure in this release (plan assumption 6): an existing club keeps
 * running unchanged until its operator adds a key. Red here means "this is
 * unsafe now", never "the app will not start", and no deploy gates on it. But
 * red is red: with no ring set and anything stored, Admin → Setup shows the
 * overall report blocked and `pnpm run setup:check` exits 1 until a key is set.
 * (An INVALID ring is different: `runtime-config.ts` fails readiness for it.)
 */

import {
  DATA_ENCRYPTION_KEYS_ENV,
  DATA_ENCRYPTION_LEGACY_KEY_ENV,
  LEGACY_AUTH_SECRET_KEY_ID,
  LEGACY_KEY_RETIRED,
  dataKeyFingerprint,
  parseDataEncryptionKeys,
} from "@/lib/data-encryption-key-material";
import { wrappingKeyIdOf } from "@/lib/integration-crypto";
import { RETIRED_RECOVERY_CODE_KEY_ID } from "@/lib/two-factor-key-format";

type CountsByKeyId = Readonly<Record<string, number>>;

/**
 * The bucket for a stored format no write produces. It holds a `:`, which no
 * ring key id may (`KEY_ID_PATTERN`), so no ring can ever appear to cover it.
 */
const UNRECOGNISED_PREFIX = "unrecognised:";

/** What the database holds, by the key each row names. Never a value. */
export interface DataKeyUsageSnapshot {
  /** Credential rows per key id (`legacy-auth-secret` for an auth-secret row). */
  credentialRowsByKeyId: CountsByKeyId;
  /** Authenticator-app secrets per key id (`legacy-auth-secret` for `v1`). */
  totpRowsByKeyId: CountsByKeyId;
  /** Unused recovery codes per key id (`legacy-auth-secret` for an unprefixed hash). */
  recoveryCodesByKeyId: CountsByKeyId;
  /**
   * Does any stored credential, authenticator secret or recovery code name a
   * ring key? The writers' own answer (`ringKeyedDataExists`), read once by the
   * snapshot, so the step's "the ring is missing" verdict and the writers'
   * refusal are one definition (#4456 review).
   */
  ringKeyedDataPresent: boolean;
}

function countBy(ids: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

/**
 * Fold what the database returned into counts per key id: both auth-secret
 * spellings are the legacy key, and a format no write produces is kept visible
 * as `unrecognised:…` so the step names it rather than dropping it.
 */
export function tallyDataKeyUsage(input: {
  credentialSources: ReadonlyArray<{ secretSource: string; count: number }>;
  /** The key id each stored authenticator secret names, or null if unrecognised. */
  totpKeyIds: ReadonlyArray<string | null>;
  recoveryCodeKeyIds: ReadonlyArray<string>;
  /** `ringKeyedDataExists`'s answer, passed through unchanged. */
  ringKeyedDataPresent: boolean;
}): DataKeyUsageSnapshot {
  const credentialRowsByKeyId: Record<string, number> = {};
  for (const { secretSource, count } of input.credentialSources) {
    const id = wrappingKeyIdOf(secretSource) ?? `${UNRECOGNISED_PREFIX}${secretSource}`;
    credentialRowsByKeyId[id] = (credentialRowsByKeyId[id] ?? 0) + count;
  }
  return {
    credentialRowsByKeyId,
    totpRowsByKeyId: countBy(input.totpKeyIds.map((id) => id ?? `${UNRECOGNISED_PREFIX}format`)),
    recoveryCodesByKeyId: countBy(input.recoveryCodeKeyIds),
    ringKeyedDataPresent: input.ringKeyedDataPresent,
  };
}

export interface DataKeyCheckResult {
  id: "data-encryption-keys";
  title: string;
  description: string;
  status: "complete" | "warning" | "blocked";
  required: false;
  message: string;
  details: string[];
  href: string;
}

const GENERATE_HINT =
  "Generate a key with: openssl rand -base64 32 — then set DATA_ENCRYPTION_KEYS=<id>:<that value> (for example k2026:...) and restart.";
/** Kept in step with DEPLOYMENT.md → "Adding a data-encryption key" and its rollback notes. */
const ROLLOUT_HINT =
  "Set it only once every running container is on this release. Once data is written under it, never unset it, roll back to an older release, or route traffic to a colour without it: that data cannot be read there.";
/** Kept in step with DEPLOYMENT.md → "Moving stored data to the current key". */
const MOVE_HINT =
  "To move it now: run pnpm run data-keys:reencrypt --dry-run, then the same with --expect-fingerprint and the fingerprint above. It re-encrypts each credential and authenticator secret under the current key and reports what remains.";
const RETIRE_LEGACY_HINT = `Nothing stored depends on AUTH_SECRET, so it can be rotated without losing data. To stop reading anything under it at all, set ${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED} and restart.`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const isLegacy = (id: string) => id === LEGACY_AUTH_SECRET_KEY_ID;
const isUnrecognised = (id: string) => id.startsWith(UNRECOGNISED_PREFIX);
/** A legacy recovery code the re-encrypt retired: under no key, and never ring data. */
const isRetired = (id: string) => id === RETIRED_RECOVERY_CODE_KEY_ID;
const isRingKeyId = (id: string) => !isLegacy(id) && !isUnrecognised(id) && !isRetired(id);

/**
 * Rows under ids `keep` accepts, as sentences: credentials and authenticator
 * secrets, and the unused recovery codes too when `withRecoveryCodes` is set.
 */
function rowsUnder(
  usage: DataKeyUsageSnapshot,
  keep: (id: string) => boolean,
  withRecoveryCodes = false,
): string[] {
  const lines: string[] = [];
  const stores: Array<readonly [CountsByKeyId, string]> = [
    [usage.credentialRowsByKeyId, "provider credential"],
    [usage.totpRowsByKeyId, "authenticator-app secret"],
  ];
  if (withRecoveryCodes) stores.push([usage.recoveryCodesByKeyId, "unused recovery code"]);
  for (const [counts, noun] of stores) {
    for (const [id, count] of Object.entries(counts)) {
      if (count > 0 && keep(id)) {
        lines.push(
          isLegacy(id)
            ? `${plural(count, noun)} encrypted under AUTH_SECRET.`
            : id.startsWith(UNRECOGNISED_PREFIX)
              ? `${plural(count, noun)} in a format no release writes, so it cannot be read.`
              : `${plural(count, noun)} under the data key "${id}".`,
        );
      }
    }
  }
  return lines;
}

/** Recovery codes no lookup can match under this ring: informational, never red. */
function retiredRecoveryCodes(usage: DataKeyUsageSnapshot, live: (id: string) => boolean): string[] {
  const retired = Object.entries(usage.recoveryCodesByKeyId)
    .filter(([id, count]) => count > 0 && !live(id))
    .reduce((sum, [, count]) => sum + count, 0);
  return retired > 0
    ? [`${plural(retired, "unused recovery code")} no longer work under this key ring; their members are told to generate a new set.`]
    : [];
}

export function buildDataEncryptionKeyCheck(
  rawRing: string | undefined,
  usage: DataKeyUsageSnapshot | undefined,
  authSecret?: string,
  rawLegacyKey?: string,
): DataKeyCheckResult {
  const base = {
    id: "data-encryption-keys" as const,
    title: "Data Encryption Key",
    description:
      "Stored provider credentials and authenticator-app secrets are encrypted under this key ring, so AUTH_SECRET can be rotated without losing them.",
    required: false as const,
    href: "/admin/health",
  };
  const ring = parseDataEncryptionKeys(rawRing, authSecret, rawLegacyKey);

  if (ring.status === "invalid") {
    return {
      ...base,
      status: "blocked",
      message: `${DATA_ENCRYPTION_KEYS_ENV} is set but cannot be used: credentials cannot be saved, two-factor sign-in fails, and data written under it cannot be read.`,
      details: [ring.reason, GENERATE_HINT],
    };
  }

  if (ring.status === "unset") {
    // Unreadable rows in a format no release writes are named, but are not
    // ring data: they never make the step say saves are refused.
    const unreadable = usage ? rowsUnder(usage, isUnrecognised, true) : [];
    // Red over ring data: the same answer the writers refuse on.
    if (usage?.ringKeyedDataPresent) {
      return {
        ...base,
        status: "blocked",
        message: `Stored data is encrypted under a data-encryption key, but ${DATA_ENCRYPTION_KEYS_ENV} is not set, so it cannot be read and no credential, authenticator or recovery code is saved under AUTH_SECRET alone until it is. Put the ring back as it was, or set a new key and re-enter the credentials and re-enrol the authenticators the old one held.`,
        details: [...rowsUnder(usage, isRingKeyId, true), ...unreadable, ROLLOUT_HINT],
      };
    }
    // Red over a credential or an authenticator secret on AUTH_SECRET alone.
    // Recovery codes do not count: they are retired at cut-over, not moved.
    const legacy = usage ? rowsUnder(usage, isLegacy) : [];
    return {
      ...base,
      status: legacy.length > 0 ? "blocked" : "warning",
      message:
        legacy.length > 0
          ? `${DATA_ENCRYPTION_KEYS_ENV} is not set, so stored data is encrypted under AUTH_SECRET alone: rotating that secret would make it unreadable, and leaking it exposes it.`
          : `${DATA_ENCRYPTION_KEYS_ENV} is not set. New credentials and authenticator secrets will be encrypted under AUTH_SECRET until it is.`,
      details: [...legacy, ...unreadable, ...(usage ? [] : ["Stored data was not checked."]), GENERATE_HINT, ROLLOUT_HINT],
    };
  }

  const ringIds = new Set(ring.keys.map((key) => key.id));
  // The running app's current key, one-way (#4456 review): the re-encrypt
  // writes only when given this fingerprint, and only under a key that has it.
  const fingerprint = dataKeyFingerprint(ring.current);
  const keyLine = `The current key "${ring.current.id}" has the fingerprint ${fingerprint}. pnpm run data-keys:reencrypt writes only when run with --expect-fingerprint ${fingerprint}, and refuses if its own key differs.`;
  const moveCommand = `pnpm run data-keys:reencrypt --expect-fingerprint ${fingerprint}`;
  if (!usage) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but stored data was not checked, so whether anything still depends on AUTH_SECRET is unknown.`,
      details: [keyLine, "Re-run the check once the database is reachable."],
    };
  }

  const missing = rowsUnder(usage, (id) => !isLegacy(id) && !ringIds.has(id));
  if (missing.length > 0) {
    return {
      ...base,
      status: "blocked",
      message: `Some stored data names a data key that is not in ${DATA_ENCRYPTION_KEYS_ENV}, so it cannot be read.`,
      details: [keyLine, ...missing, "Put that key back in the ring, or re-enter what it holds."],
    };
  }

  const recovery = retiredRecoveryCodes(usage, (id) => ringIds.has(id));
  const legacy = rowsUnder(usage, isLegacy);
  const older = rowsUnder(usage, (id) => ringIds.has(id) && id !== ring.current.id, true);
  if (legacy.length > 0 && ring.legacyRetired) {
    return {
      ...base,
      status: "blocked",
      message: `${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED} stops reading anything under AUTH_SECRET, but some stored data is still under it, so it cannot be read.`,
      details: [
        keyLine,
        ...legacy,
        `Unset ${DATA_ENCRYPTION_LEGACY_KEY_ENV} and restart, run pnpm run data-keys:reencrypt until it reports nothing on AUTH_SECRET, then set it again.`,
      ],
    };
  }
  if (legacy.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but some stored data still depends on AUTH_SECRET: rotating it now would make that data unreadable.`,
      details: [keyLine, ...legacy, ...older, ...recovery, MOVE_HINT],
    };
  }

  // Not complete while anything is under an older ring key (#4456 review
  // round 2): that key cannot leave the ring yet, and a run under a stale ring
  // could have put it there.
  if (older.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but some stored data is still under an older key in the ring. Remove that key only once nothing is under it.`,
      details: [
        keyLine,
        ...older,
        `Move the credentials and authenticator secrets with ${moveCommand}. Recovery codes cannot be moved: they stay under their key until used or replaced, and removing it retires them (their members are told to generate a new set).`,
      ],
    };
  }

  return {
    ...base,
    status: "complete",
    message: `Data is encrypted under the data key "${ring.current.id}".`,
    details: [
      keyLine,
      `${plural(ring.keys.length, "key")} in the ring; the first is used for new data.`,
      ring.legacyRetired
        ? `Nothing stored depends on AUTH_SECRET, and nothing is read under it (${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED}).`
        : RETIRE_LEGACY_HINT,
      ...recovery,
    ],
  };
}
