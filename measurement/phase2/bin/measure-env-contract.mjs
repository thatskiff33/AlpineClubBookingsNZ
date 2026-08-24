import { createHmac } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MEASURE_ENV_KEYS = Object.freeze([
  "ADDY_API_KEY", "ADDY_API_SECRET", "AI_DIAGNOSTICS_DATABASE_URL", "APP_IMAGE", "AUTH_SECRET", "AUTH_TRUST_HOST",
  "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "BACKUP_CRON_SCHEDULE", "CRON_ENABLED", "CRON_SECRET",
  "DB_PASSWORD", "EMAIL_FROM", "EMAIL_SERVER_HOST", "EMAIL_SERVER_PASSWORD", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER",
  "LEGACY_DASHBOARD_EXPORT_TOKEN", "LOG_LEVEL", "MIROTALK_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "NEXT_PUBLIC_SENTRY_DSN",
  "SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "SEED_LODGE_PASSWORD", "SEED_THEME_COMPLETE", "SENTRY_AUTH_TOKEN", "SENTRY_DSN",
  "SENTRY_ORG", "SENTRY_PROJECT", "SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN", "SES_SNS_TOPIC_ARN", "SMTP_HOST", "SMTP_PORT",
  "USE_AWS_SES", "USE_SMTP_RELAY", "XERO_MOCK_API_ORIGIN", "XERO_MOCK_INTERNAL_ORIGIN",
  // ENV-SAFETY 2 (#3035): the flag that decides whether this stack transmits at
  // all belongs inside the frozen env contract, not outside it.
  "USE_LOCAL_CAPTURE",
].sort());

const fail = (message) => { throw new Error(message); };
const hmacKey = (path) => {
  const absolute = resolve(path);
  if (!isAbsolute(path) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) fail("measurement env HMAC key must be an absolute private regular file");
  const value = readFileSync(absolute, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) fail("measurement env HMAC key is invalid");
  return value;
};
const keyedSnapshotHmac = (bytes, key) => createHmac("sha256", Buffer.from(key, "hex")).update(bytes).digest("hex");
const AMBIENT_FORBIDDEN_KEYS = Object.freeze([...new Set([
  ...MEASURE_ENV_KEYS,
  "AI_DIAGNOSTICS_DB_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BACKUP_ENABLED", "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_RETENTION_DAYS",
  "BACKUP_RESTORE_VALIDATION_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MIRO_JWT_KEY", "MIRO_MEETING_PASSWORD",
  "MIRO_MEETING_PRESENTER", "MIRO_MEETING_USERNAME", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_ENCRYPTION_KEY", "XERO_REDIRECT_URI",
  "XERO_WEBHOOK_KEY",
])].sort());

export function parseMeasureEnv(path) {
  const absolute = resolve(path);
  if (!isAbsolute(path) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) fail("measurement env path must be an existing absolute non-reparse regular file");
  const bytes = readFileSync(absolute);
  if ([...bytes].some((byte) => byte === 0 || (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) || byte === 0x7f)) fail("measurement env contains control bytes");
  const values = {};
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail(`measurement env contains an invalid line ${index + 1}`);
    const [, key, raw] = match;
    if (Object.hasOwn(values, key)) fail(`measurement env contains duplicate key ${key}`);
    let value = raw;
    if (/^["']/.test(raw)) {
      if (raw.length < 2 || raw.at(-1) !== raw[0]) fail(`measurement env contains an unterminated quoted value on line ${index + 1}`);
      value = raw.slice(1, -1);
    }
    values[key] = value;
  }
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(MEASURE_ENV_KEYS)) fail("measurement env key inventory differs from the reviewed exact set");
  return { absolute, bytes, values };
}

export function auditMeasureEnvFile(path, { ambient = process.env } = {}) {
  const parsed = parseMeasureEnv(path);
  const ambientUpper = new Set(Object.keys(ambient).map((key) => key.toUpperCase()));
  // APP_IMAGE was historically used as a command-scoped selector by the
  // wrapper. It is ignored: Compose receives only MEASURE_APP_IMAGE and the
  // frozen snapshot remains authoritative for every other reviewed key.
  const overrides = AMBIENT_FORBIDDEN_KEYS.filter((key) => key !== "APP_IMAGE" && ambientUpper.has(key));
  if (overrides.length) fail(`ambient environment overrides measurement env keys: ${overrides.join(",")}`);
  return { schema_version: 1, key_names: MEASURE_ENV_KEYS, ambient_override_keys: [], ignored_non_authoritative_keys: ambientUpper.has("APP_IMAGE") ? ["APP_IMAGE"] : [], authoritative_private_snapshot: true, verified: true };
}

export function createMeasureEnvSnapshot(source, destination, { ambient = process.env, key = null } = {}) {
  const audit = auditMeasureEnvFile(source, { ambient });
  const target = resolve(destination);
  if (!isAbsolute(destination) || existsSync(target)) fail("measurement env snapshot destination must be a new absolute path");
  const sourceBytes = readFileSync(resolve(source));
  writeFileSync(target, sourceBytes, { flag: "wx", mode: 0o600 });
  if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || !readFileSync(target).equals(sourceBytes)) fail("measurement env private snapshot does not exactly match its source");
  if (process.platform !== "win32" && (statSync(target).mode & 0o077) !== 0) fail("measurement env private snapshot permissions are not restrictive");
  parseMeasureEnv(target);
  if (key !== null && !/^[a-f0-9]{64}$/.test(key)) fail("measurement env HMAC key is invalid");
  return { ...audit, snapshot_hmac_sha256: key === null ? null : keyedSnapshotHmac(sourceBytes, key) };
}

export function verifyMeasureEnvSnapshot(path, { key, expectedHmac, ambient = process.env } = {}) {
  const audit = auditMeasureEnvFile(path, { ambient });
  if (!/^[a-f0-9]{64}$/.test(key ?? "") || !/^[a-f0-9]{64}$/.test(expectedHmac ?? "")) fail("measurement env snapshot HMAC verification inputs are invalid");
  const actual = keyedSnapshotHmac(readFileSync(resolve(path)), key);
  if (actual !== expectedHmac) fail("measurement env private snapshot changed after it was frozen");
  return { ...audit, snapshot_hmac_sha256: actual };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args.length === 8 && args[0] === "--snapshot-source" && args[2] === "--snapshot-out" && args[4] === "--hmac-key-file" && args[6] === "--audit-out") {
    const audit = createMeasureEnvSnapshot(args[1], args[3], { key: hmacKey(args[5]) });
    writeFileSync(resolve(args[7]), `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx" });
  } else if (args.length === 6 && args[0] === "--verify-snapshot" && args[2] === "--hmac-key-file" && args[4] === "--expected-hmac") {
    verifyMeasureEnvSnapshot(args[1], { key: hmacKey(args[3]), expectedHmac: args[5] });
  } else if (args.length === 4 && args[0] === "--get" && args[2] === "--env-file") {
    const parsed = parseMeasureEnv(args[3]);
    if (!Object.hasOwn(parsed.values, args[1])) fail(`measurement env has no key ${args[1]}`);
    process.stdout.write(parsed.values[args[1]]);
  } else fail("usage: measure-env-contract.mjs --snapshot-source <absolute> --snapshot-out <private-absolute> --hmac-key-file <private-key> --audit-out <new-json> | --verify-snapshot <private-absolute> --hmac-key-file <private-key> --expected-hmac <hex> | --get <key> --env-file <private-absolute>");
}
