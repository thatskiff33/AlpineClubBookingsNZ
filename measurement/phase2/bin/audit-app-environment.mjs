import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const fail = (message) => { throw new Error(message); };
export const AUDITED_KEYS = Object.freeze([
  "ADDY_API_KEY", "ADDY_API_SECRET", "AI_DIAGNOSTICS_DATABASE_URL", "APP_RUNTIME_ROLE", "AUTH_SECRET", "AUTH_TRUST_HOST", "BACKUP_CRON_SCHEDULE",
  "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "CRON_ENABLED", "CRON_SECRET", "DATABASE_URL", "EMAIL_FROM",
  "EMAIL_SERVER_HOST", "EMAIL_SERVER_PASSWORD", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER", "KEEP_ALIVE_TIMEOUT",
  "LEGACY_DASHBOARD_EXPORT_TOKEN", "LOG_LEVEL", "MIROTALK_URL", "MIRO_JWT_EXP", "MIRO_JWT_KEY", "MIRO_MEETING_PASSWORD",
  "MIRO_MEETING_PRESENTER", "MIRO_MEETING_USERNAME", "NEXTAUTH_SECRET", "NEXTAUTH_URL", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_SENTRY_DSN",
  "NODE_ENV", "SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "SEED_LODGE_PASSWORD", "SENTRY_AUTH_TOKEN", "SENTRY_DSN",
  "SENTRY_ORG", "SENTRY_PROJECT", "SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN", "SES_SNS_TOPIC_ARN", "SMTP_HOST", "SMTP_PORT",
  "TZ", "USE_AWS_SES", "USE_SMTP_RELAY", "XERO_MOCK_API_ORIGIN", "XERO_MOCK_INTERNAL_ORIGIN",
  // ENV-SAFETY (#3034/#3035): the two variables that decide whether this stack
  // can contact anybody at all. They were outside the frozen-env audit while
  // being exactly what the audit exists to freeze, so a stack could silently
  // change from "captures its mail" to "sends nothing" or the reverse without
  // the audit noticing.
  "APP_ENVIRONMENT_ROLE", "USE_LOCAL_CAPTURE",
].sort());
export const LIVE_PROVIDER_KEYS = Object.freeze([
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "BACKUP_ENABLED", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_RETENTION_DAYS", "BACKUP_RESTORE_VALIDATION_URL", "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET", "XERO_ENCRYPTION_KEY", "XERO_REDIRECT_URI", "XERO_WEBHOOK_KEY",
]);
const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:ADDY|AI_DIAGNOSTICS|ANTHROPIC|AUTH|AWS|BACKUP|COOKIE|CRON|DATABASE|DB|EMAIL|GA|GOOGLE|MIRO|NEXTAUTH|PASSWORD|SECRET|SEED|SENTRY|SES|SMTP|STRIPE|TOKEN|XERO)(?:_|$)/i;
const INFLUENTIAL_FORBIDDEN_KEYS = Object.freeze(["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_OPTIONS"]);

export function auditAppEnvironment(inspect, hmacKey) {
  if (!/^[a-f0-9]{64}$/.test(hmacKey ?? "")) fail("app environment audit HMAC key is invalid");
  if (!Array.isArray(inspect) || inspect.length !== 1 || !Array.isArray(inspect[0]?.Config?.Env)) fail("app environment audit requires one Docker inspect payload with Config.Env");
  const values = {};
  const foldedKeys = new Set();
  for (const item of inspect[0].Config.Env) {
    const equals = item.indexOf("=");
    if (equals < 1) fail("app environment contains a malformed entry");
    const key = item.slice(0, equals);
    const folded = key.toUpperCase();
    if (Object.hasOwn(values, key) || foldedKeys.has(folded)) fail(`app environment contains duplicate key ${key}`);
    foldedKeys.add(folded);
    values[key] = item.slice(equals + 1);
  }
  for (const key of AUDITED_KEYS) if (!Object.hasOwn(values, key)) fail(`app environment is missing audited key ${key}`);
  const known = new Set([...AUDITED_KEYS, ...LIVE_PROVIDER_KEYS]);
  const unknownSensitive = Object.keys(values).filter((key) => SENSITIVE_KEY_PATTERN.test(key) && !known.has(key));
  if (unknownSensitive.length) fail(`app environment contains unknown provider/sensitive keys: ${unknownSensitive.sort().join(",")}`);
  const influential = Object.keys(values).filter((key) => INFLUENTIAL_FORBIDDEN_KEYS.includes(key.toUpperCase()));
  if (influential.length) fail(`app environment contains unapproved influential keys: ${influential.sort().join(",")}`);
  const forbidden = LIVE_PROVIDER_KEYS.filter((key) => (values[key] ?? "") !== "");
  if (forbidden.length) fail(`app environment contains nonblank prohibited live-provider keys: ${forbidden.join(",")}`);
  if (values.APP_RUNTIME_ROLE !== "web-measure" || values.CRON_ENABLED !== "false" || values.NODE_ENV !== "production" || values.TZ !== "Pacific/Auckland" || values.KEEP_ALIVE_TIMEOUT !== "65000" || values.LOG_LEVEL !== "info") fail("measurement app runtime role/cron/runtime constants differ from the reviewed profile");
  if (values.BACKUP_CRON_SCHEDULE !== "0 3 * * *" || values.MIRO_JWT_EXP !== "1h") fail("inert backup/Miro runtime defaults differ from the reviewed profile");
  if (values.AUTH_TRUST_HOST !== "true" || values.AUTH_SECRET === "" || values.NEXTAUTH_SECRET === "" || values.AUTH_SECRET !== values.NEXTAUTH_SECRET || values.CRON_SECRET === "") fail("measurement auth/cron secret invariants failed");
  // ENV-SAFETY 2 (#3035): mailpit is now declared a CAPTURE transport rather than
  // an ordinary relay, and the difference is load-bearing rather than cosmetic.
  // This stack declares APP_ENVIRONMENT_ROLE=non-production, and a copy pointed at
  // an ordinary relay has EVERY send suppressed at the delivery boundary — so the
  // old pairing (USE_SMTP_RELAY=true) would now describe a stack that sends
  // nothing, and the harness would be measuring the wrong thing while reporting a
  // clean audit.
  if (values.APP_ENVIRONMENT_ROLE !== "non-production") fail("the measurement app must declare itself a non-production copy");
  if (values.USE_AWS_SES !== "false" || values.USE_SMTP_RELAY !== "false" || values.USE_LOCAL_CAPTURE !== "true" || values.EMAIL_SERVER_HOST !== "mailpit" || values.EMAIL_SERVER_PORT !== "1025") fail("measurement email provider is not the DECLARED local Mailpit capture");
  if (values.EMAIL_SERVER_USER === "" || values.EMAIL_SERVER_PASSWORD === "" || !/@(?:measurement\.)?invalid$/i.test(values.EMAIL_FROM)) fail("measurement local email identity/credentials are incomplete");
  for (const key of ["AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "SES_SNS_TOPIC_ARN", "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "ADDY_API_KEY", "ADDY_API_SECRET", "LEGACY_DASHBOARD_EXPORT_TOKEN", "SMTP_HOST", "SMTP_PORT", "AI_DIAGNOSTICS_DATABASE_URL", "MIROTALK_URL", "MIRO_JWT_KEY", "MIRO_MEETING_USERNAME", "MIRO_MEETING_PASSWORD", "MIRO_MEETING_PRESENTER", "XERO_MOCK_API_ORIGIN", "XERO_MOCK_INTERNAL_ORIGIN", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "SEED_LODGE_PASSWORD"]) {
    if (values[key] !== "") fail(`${key} must be blank in the measurement app`);
  }
  if (values.SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN !== "false") fail("unsafe missing SES topic mode must be disabled");
  if (values.NEXTAUTH_URL !== "http://localhost:8027") fail("NEXTAUTH_URL is not the local measurement Caddy");
  let database;
  try { database = new URL(values.DATABASE_URL); }
  catch { fail("DATABASE_URL is not a valid isolated measurement Postgres URL"); }
  if (database.protocol !== "postgresql:" || database.username !== "tac" || database.password === "" || database.hostname !== "postgres" || database.port !== "5432" || database.pathname !== "/tacbookings" || database.searchParams.size !== 2 || database.searchParams.get("connection_limit") !== "10" || database.searchParams.get("pool_timeout") !== "10") fail("DATABASE_URL is not exactly the isolated measurement Postgres contract");
  const runtimeKeys = Object.keys(values).sort();
  const canonical = runtimeKeys.map((key) => `${key.length}:${key}:${values[key].length}:${values[key]}`).join("|");
  return {
    schema_version: 1,
    audited_key_names: AUDITED_KEYS,
    runtime_key_names: runtimeKeys,
    prohibited_live_provider_keys: [],
    unknown_sensitive_key_names: [],
    classifications: {
      cron: "disabled",
      database: "measurement-postgres",
      email: "local-mailpit",
      ses: "disabled-dummy",
      sentry: "disabled-dummy",
      addy: "disabled-dummy",
      xero: "disabled-local-mock-only",
      ai_diagnostics: "disabled",
      mirotalk: "disabled",
      stripe: "env-keys-absent-db-provider-not-invoked",
    },
    keyed_fingerprint_sha256: createHmac("sha256", Buffer.from(hmacKey, "hex")).update(canonical).digest("hex"),
    verified: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out") fail("usage: docker inspect app | audit-app-environment.mjs --out <new-json>");
  const out = resolve(args[1]);
  if (existsSync(out)) fail("app environment audit output already exists");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const keyPath = process.env.PHASE2_ENV_AUDIT_HMAC_KEY_FILE;
  if (!keyPath || !existsSync(keyPath)) fail("private app environment audit HMAC key file is missing");
  const result = auditAppEnvironment(JSON.parse(input), readFileSync(keyPath, "utf8").trim());
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
