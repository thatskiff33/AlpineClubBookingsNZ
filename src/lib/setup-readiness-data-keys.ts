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
 * never "the app will not start", and the step is not a required blocker.
 */

import {
  DATA_ENCRYPTION_KEYS_ENV,
  LEGACY_AUTH_SECRET_KEY_ID,
  parseDataEncryptionKeys,
} from "@/lib/data-encryption-keys";

/** What the database holds, by the key each row names. Never a value. */
export interface DataKeyUsageSnapshot {
  /** Credential rows per key id (`legacy-auth-secret` for an auth-secret row). */
  credentialRowsByKeyId: Readonly<Record<string, number>>;
  /** Authenticator-app secrets still in the legacy `v1` format. */
  legacyTotpSecrets: number;
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
const ROLLOUT_HINT =
  "Set it only once every running container is on this release: an older release cannot read data written under a data key.";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function buildDataEncryptionKeyCheck(
  rawRing: string | undefined,
  usage: DataKeyUsageSnapshot | undefined,
): DataKeyCheckResult {
  const base = {
    id: "data-encryption-keys" as const,
    title: "Data Encryption Key",
    description:
      "Stored provider credentials and authenticator-app secrets are encrypted under this key ring, so AUTH_SECRET can be rotated without losing them.",
    required: false as const,
    href: "/admin/health",
  };
  const ring = parseDataEncryptionKeys(rawRing);
  const counts = Object.entries(usage?.credentialRowsByKeyId ?? {});
  const legacyCredentials = usage?.credentialRowsByKeyId[LEGACY_AUTH_SECRET_KEY_ID] ?? 0;
  const legacyTotp = usage?.legacyTotpSecrets ?? 0;
  const legacyDetails = [
    ...(legacyCredentials > 0 ? [`${plural(legacyCredentials, "provider credential")} encrypted under AUTH_SECRET.`] : []),
    ...(legacyTotp > 0 ? [`${plural(legacyTotp, "authenticator-app secret")} encrypted under AUTH_SECRET.`] : []),
  ];

  if (ring.status === "invalid") {
    return {
      ...base,
      status: "blocked",
      message: `${DATA_ENCRYPTION_KEYS_ENV} is set but cannot be used: credentials cannot be saved, and data written under it cannot be read.`,
      details: [ring.reason, GENERATE_HINT],
    };
  }

  if (ring.status === "unset") {
    const atRisk = legacyCredentials + legacyTotp;
    return {
      ...base,
      status: atRisk > 0 ? "blocked" : "warning",
      message:
        atRisk > 0
          ? `${DATA_ENCRYPTION_KEYS_ENV} is not set, so stored data is encrypted under AUTH_SECRET alone: rotating that secret would make it unreadable, and leaking it exposes it.`
          : `${DATA_ENCRYPTION_KEYS_ENV} is not set. New credentials and authenticator secrets will be encrypted under AUTH_SECRET until it is.`,
      details: [...legacyDetails, GENERATE_HINT, ROLLOUT_HINT],
    };
  }

  const ringIds = new Set(ring.keys.map((key) => key.id));
  const missing = counts.filter(
    ([id, count]) => count > 0 && id !== LEGACY_AUTH_SECRET_KEY_ID && !ringIds.has(id),
  );
  if (missing.length > 0) {
    return {
      ...base,
      status: "blocked",
      message: `Some stored credentials name a data key that is not in ${DATA_ENCRYPTION_KEYS_ENV}, so they cannot be read.`,
      details: missing.map(
        ([id, count]) => `${plural(count, "provider credential")} under the key "${id}": put that key back in the ring, or re-enter them.`,
      ),
    };
  }

  if (legacyDetails.length > 0) {
    return {
      ...base,
      status: "warning",
      message: `New data is encrypted under the data key "${ring.current.id}", but some stored data still depends on AUTH_SECRET: rotating it now would make that data unreadable.`,
      details: [...legacyDetails, "Re-encrypt it under the data key before rotating AUTH_SECRET."],
    };
  }

  return {
    ...base,
    status: "complete",
    message: `Data is encrypted under the data key "${ring.current.id}".`,
    details: [
      `${plural(ring.keys.length, "key")} in the ring; the first is used for new data.`,
      ...(usage ? ["Nothing stored depends on AUTH_SECRET, so it can be rotated without losing data."] : ["Stored data was not checked."]),
    ],
  };
}
