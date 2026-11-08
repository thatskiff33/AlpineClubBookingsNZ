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
/** The re-encrypt as an instruction: its fingerprint only ever from the app's own page. */
const MOVE_COMMAND = "pnpm run data-keys:reencrypt --expect-fingerprint <fingerprint from Admin → Setup>";
/** Kept in step with DEPLOYMENT.md → "Moving stored data to the current key". */
const MOVE_HINT = `To move it now: run pnpm run data-keys:reencrypt --dry-run, then ${MOVE_COMMAND}. It re-encrypts each credential and authenticator secret under the current key and reports what remains.`;
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

/**
 * Unused recovery codes under an older ring key: information, never amber
 * (#4456 review round 3). They cannot be moved, so waiting for them could
 * hold a key in the ring for ever; removing the key retires them instead.
 */
function olderKeyRecoveryCodes(usage: DataKeyUsageSnapshot, isOlder: (id: string) => boolean): string[] {
  return Object.entries(usage.recoveryCodesByKeyId)
    .filter(([id, count]) => count > 0 && isOlder(id))
    .map(
      ([id, count]) =>
        `${plural(count, "unused recovery code")} under the older key "${id}": they cannot be moved, and removing that key retires them (their members are told to generate a new set).`,
    );
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

/**
 * Whose ring this is (#4456 review round 3): `app` only for the running app
 * (Admin → Setup), whose first key IS the current one; `shell` for anything
 * else, such as `setup:check`, whose env plus `.env` may be stale. The default
 * is the one that claims nothing.
 */
export type DataKeyRingSource = "app" | "shell";

export function buildDataEncryptionKeyCheck(
  rawRing: string | undefined,
  usage: DataKeyUsageSnapshot | undefined,
  authSecret?: string,
  rawLegacyKey?: string,
  source: DataKeyRingSource = "shell",
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
  const fromApp = source === "app";
  // Which key the ring makes current, and the fingerprint the re-encrypt must be
  // given (#4456 review). Only the RUNNING APP knows its current key: a shell's
  // ring (`setup:check`, env plus `.env`) may be stale, so it claims nothing,
  // prints no fingerprint, and says where the fingerprint comes from (round 3).
  const keyLine = fromApp
    ? `The current key "${ring.current.id}" has the fingerprint ${dataKeyFingerprint(ring.current)}. pnpm run data-keys:reencrypt writes only when run with --expect-fingerprint ${dataKeyFingerprint(ring.current)}, and refuses if its own key differs.`
    : `This shell's ring lists "${ring.current.id}" first: this shell's key, not necessarily the running app's. Take the fingerprint for pnpm run data-keys:reencrypt --expect-fingerprint only from Admin → Setup in the browser.`;
  const newData = fromApp
    ? `New data is encrypted under the data key "${ring.current.id}"`
    : `This shell's ring puts new data under "${ring.current.id}" (not necessarily the running app's key)`;
  if (!usage) {
    return {
      ...base,
      status: "warning",
      message: `${newData}, but stored data was not checked, so whether anything still depends on AUTH_SECRET is unknown.`,
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

  const isOlder = (id: string) => ringIds.has(id) && id !== ring.current.id;
  const recovery = retiredRecoveryCodes(usage, (id) => ringIds.has(id));
  const legacy = rowsUnder(usage, isLegacy);
  // Amber only for what can be moved (round 3, S5): credentials and
  // authenticator secrets. Recovery codes cannot be; they are information.
  const older = rowsUnder(usage, isOlder);
  const olderCodes = olderKeyRecoveryCodes(usage, isOlder);
  if (legacy.length > 0 && ring.legacyRetired) {
    return {
      ...base,
      status: "blocked",
      message: `${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED} stops reading anything under AUTH_SECRET, but some stored data is still under it, so it cannot be read.`,
      details: [
        keyLine,
        ...legacy,
        `Unset ${DATA_ENCRYPTION_LEGACY_KEY_ENV} and restart, run ${MOVE_COMMAND} until it reports nothing on AUTH_SECRET, then set it again.`,
      ],
    };
  }
  if (legacy.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `${newData}, but some stored data still depends on AUTH_SECRET: rotating it now would make that data unreadable.`,
      details: [keyLine, ...legacy, ...older, ...olderCodes, ...recovery, MOVE_HINT],
    };
  }

  // Not complete while a credential or an authenticator secret is under an
  // older ring key (#4456 review round 2): that key cannot leave the ring yet.
  if (older.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `${newData}, but some stored data is still under an older key in the ring. Remove that key only once nothing is under it.`,
      details: [keyLine, ...older, ...olderCodes, `Move them with ${MOVE_COMMAND}.`],
    };
  }

  return {
    ...base,
    status: "complete",
    message: fromApp
      ? `Data is encrypted under the data key "${ring.current.id}".`
      : `Stored credentials and authenticator secrets are all under "${ring.current.id}", the first key of this shell's ring (not necessarily the running app's).`,
    details: [
      keyLine,
      `${plural(ring.keys.length, "key")} in the ring; the first is used for new data.`,
      ring.legacyRetired
        ? `Nothing stored depends on AUTH_SECRET, and nothing is read under it (${DATA_ENCRYPTION_LEGACY_KEY_ENV}=${LEGACY_KEY_RETIRED}).`
        : RETIRE_LEGACY_HINT,
      ...olderCodes,
      ...recovery,
    ],
  };
}
