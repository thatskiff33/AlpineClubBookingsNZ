/**
 * The "Data Encryption Key" readiness step (#4456): is stored data wrapped by a
 * rotatable `DATA_ENCRYPTION_KEYS` ring key, or still by `AUTH_SECRET` alone?
 *
 * Pure, like the rest of `setup-readiness.ts`: the ring comes from the env the
 * caller passes, and the row counts from `SetupDatabaseSnapshot.dataKeyUsage`,
 * read by `setup-readiness-db.ts`. It never names or prints a key's value.
 *
 * Not a boot failure in this release (plan assumption 6): an existing club keeps
 * running until its operator adds a key. Red here means "this is unsafe now",
 * never "the app will not start", and the step is not a required blocker. (An
 * INVALID ring is different: `runtime-config.ts` fails readiness for it.)
 */

import {
  DATA_ENCRYPTION_KEYS_ENV,
  LEGACY_AUTH_SECRET_KEY_ID,
  parseDataEncryptionKeys,
} from "@/lib/data-encryption-key-material";
import { wrappingKeyIdOf } from "@/lib/integration-crypto";

type CountsByKeyId = Readonly<Record<string, number>>;

/** What the database holds, by the key each row names. Never a value. */
export interface DataKeyUsageSnapshot {
  /** Credential rows per key id (`legacy-auth-secret` for an auth-secret row). */
  credentialRowsByKeyId: CountsByKeyId;
  /** Authenticator-app secrets per key id (`legacy-auth-secret` for `v1`). */
  totpRowsByKeyId: CountsByKeyId;
  /** Unused recovery codes per key id (`legacy-auth-secret` for an unprefixed hash). */
  recoveryCodesByKeyId: CountsByKeyId;
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
}): DataKeyUsageSnapshot {
  const credentialRowsByKeyId: Record<string, number> = {};
  for (const { secretSource, count } of input.credentialSources) {
    const id = wrappingKeyIdOf(secretSource) ?? `unrecognised:${secretSource}`;
    credentialRowsByKeyId[id] = (credentialRowsByKeyId[id] ?? 0) + count;
  }
  return {
    credentialRowsByKeyId,
    totpRowsByKeyId: countBy(input.totpKeyIds.map((id) => id ?? "unrecognised")),
    recoveryCodesByKeyId: countBy(input.recoveryCodeKeyIds),
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
const MOVE_HINT =
  "To move it now: re-enter each provider credential in Admin → Integrations (a save encrypts it under the data key), and ask members who use an authenticator app to re-enrol it.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const isLegacy = (id: string) => id === LEGACY_AUTH_SECRET_KEY_ID;

/** Credential and authenticator rows under ids `keep` rejects, as sentences. */
function rowsUnder(usage: DataKeyUsageSnapshot, keep: (id: string) => boolean): string[] {
  const lines: string[] = [];
  for (const [counts, noun] of [
    [usage.credentialRowsByKeyId, "provider credential"],
    [usage.totpRowsByKeyId, "authenticator-app secret"],
  ] as const) {
    for (const [id, count] of Object.entries(counts)) {
      if (count > 0 && keep(id)) {
        lines.push(
          isLegacy(id)
            ? `${plural(count, noun)} encrypted under AUTH_SECRET.`
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
): DataKeyCheckResult {
  const base = {
    id: "data-encryption-keys" as const,
    title: "Data Encryption Key",
    description:
      "Stored provider credentials and authenticator-app secrets are encrypted under this key ring, so AUTH_SECRET can be rotated without losing them.",
    required: false as const,
    href: "/admin/health",
  };
  const ring = parseDataEncryptionKeys(rawRing, authSecret);

  if (ring.status === "invalid") {
    return {
      ...base,
      status: "blocked",
      message: `${DATA_ENCRYPTION_KEYS_ENV} is set but cannot be used: credentials cannot be saved, two-factor sign-in fails, and data written under it cannot be read.`,
      details: [ring.reason, GENERATE_HINT],
    };
  }

  if (ring.status === "unset") {
    const ringKeyed = usage ? rowsUnder(usage, (id) => !isLegacy(id)) : [];
    if (ringKeyed.length > 0) {
      return {
        ...base,
        status: "blocked",
        message: `Stored data is encrypted under a data-encryption key, but ${DATA_ENCRYPTION_KEYS_ENV} is not set, so it cannot be read and new credentials cannot be saved. Put the ring back as it was.`,
        details: [...ringKeyed, ...(usage ? retiredRecoveryCodes(usage, isLegacy) : []), ROLLOUT_HINT],
      };
    }
    const legacy = usage ? rowsUnder(usage, isLegacy) : [];
    return {
      ...base,
      status: legacy.length > 0 ? "blocked" : "warning",
      message:
        legacy.length > 0
          ? `${DATA_ENCRYPTION_KEYS_ENV} is not set, so stored data is encrypted under AUTH_SECRET alone: rotating that secret would make it unreadable, and leaking it exposes it.`
          : `${DATA_ENCRYPTION_KEYS_ENV} is not set. New credentials and authenticator secrets will be encrypted under AUTH_SECRET until it is.`,
      details: [...legacy, ...(usage ? [] : ["Stored data was not checked."]), GENERATE_HINT, ROLLOUT_HINT],
    };
  }

  const ringIds = new Set(ring.keys.map((key) => key.id));
  if (!usage) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but stored data was not checked, so whether anything still depends on AUTH_SECRET is unknown.`,
      details: ["Re-run the check once the database is reachable."],
    };
  }

  const missing = rowsUnder(usage, (id) => !isLegacy(id) && !ringIds.has(id));
  if (missing.length > 0) {
    return {
      ...base,
      status: "blocked",
      message: `Some stored data names a data key that is not in ${DATA_ENCRYPTION_KEYS_ENV}, so it cannot be read.`,
      details: [...missing, "Put that key back in the ring, or re-enter what it holds."],
    };
  }

  const recovery = retiredRecoveryCodes(usage, (id) => ringIds.has(id));
  const legacy = rowsUnder(usage, isLegacy);
  if (legacy.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but some stored data still depends on AUTH_SECRET: rotating it now would make that data unreadable.`,
      details: [...legacy, ...recovery, MOVE_HINT],
    };
  }

  return {
    ...base,
    status: "complete",
    message: `Data is encrypted under the data key "${ring.current.id}".`,
    details: [
      `${plural(ring.keys.length, "key")} in the ring; the first is used for new data.`,
      "Nothing stored depends on AUTH_SECRET, so it can be rotated without losing data.",
      ...recovery,
    ],
  };
}
