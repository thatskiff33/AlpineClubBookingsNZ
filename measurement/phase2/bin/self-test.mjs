import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUDITED_KEYS, LIVE_PROVIDER_KEYS, auditAppEnvironment } from "./audit-app-environment.mjs";
import { CORRECTNESS_CENSUS, EXPECTED_PRODUCER_SOURCE_PATHS, PHASE2_DEFERRED_CHECK_IDS, PRODUCER_CHECK_SCHEMA, buildPhase2Correctness, classifyPreTimingResult, correctnessCensus, sha256File, validateCensus, validatePhase2Correctness, validateProducerFilesManifest, validateProducerResult, validateRuntimeProvenance, verifyLiveProducerSource } from "./correctness-contract.mjs";
import { parseStrictHttpHeaders } from "./http-evidence.mjs";
import { readGitArchive } from "./git-archive.mjs";
import { verifyCorrectnessRouteEvidence } from "./correctness-route-evidence.mjs";
import { compareStackIdentities, verifyStackIdentity } from "./correctness-stack-identity.mjs";
import { MEASURE_ENV_KEYS, auditMeasureEnvFile, createMeasureEnvSnapshot, parseMeasureEnv, verifyMeasureEnvSnapshot } from "./measure-env-contract.mjs";
import { FINAL_ORCHESTRATION_PROFILE, FINAL_SIDE_PARAMETERS, PROFILE_FINAL, PROFILE_NONFINAL, assertDeclaredProfile, classifyOrchestrationProfile, classifySideProfile } from "./measurement-profile.mjs";
import { scanEvidence, verifySecretScan } from "./scan-evidence-secrets.mjs";
import { finalizeSealedTree, verifySealedTree } from "./sealed-tree.mjs";
import { conventionalMedian, rankedQuantile } from "./statistics.mjs";
import { verifyPostFinalizationRuntimeIdentity } from "./runtime-identity.mjs";
import { verifyHarnessAgainstProducerArchive } from "./verify-harness-source.mjs";
import { verifyCorrectnessCompletion } from "./verify-correctness-evidence.mjs";
import { finalizeCorrectnessEvidence } from "./finalize-correctness-evidence.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const bin = resolve(import.meta.dirname);
const temp = mkdtempSync(join(tmpdir(), "issue-2352-phase2-selftest-"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const run = (script, args, options = {}) => execFileSync(process.execPath, [join(bin, script), ...args], { cwd: repo, encoding: "utf8", stdio: "pipe", ...options });
const rejects = (script, args, pattern) => assert.throws(() => run(script, args), pattern);
const mkdirs = (...paths) => paths.forEach((path) => mkdirSync(path, { recursive: true }));

assert.equal(conventionalMedian([4, 1, 3, 2]), 2.5);
assert.equal(rankedQuantile([1, 2, 3, 4], 0.95), 4);
assert.equal(classifySideProfile(FINAL_SIDE_PARAMETERS), PROFILE_FINAL);
assert.equal(classifyOrchestrationProfile(FINAL_ORCHESTRATION_PROFILE), PROFILE_FINAL);
assert.equal(assertDeclaredProfile(PROFILE_NONFINAL, PROFILE_FINAL, "rehearsal"), PROFILE_NONFINAL);
assert.throws(() => assertDeclaredProfile(PROFILE_FINAL, PROFILE_NONFINAL, "weakened"), /weakens or changes/);

const headers = 'HTTP/1.1 103 Early Hints\r\nLink: </x>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nETag: "bound"\r\nX-Nextjs-Cache: HIT\r\n\r\n';
assert.equal(parseStrictHttpHeaders(headers).headers.etag, '"bound"');
for (const duplicate of [
  'HTTP/1.1 200 OK\r\nX-Nextjs-Cache: HIT\r\nx-nextjs-cache: HIT\r\n\r\n',
  'HTTP/1.1 200 OK\r\nETag: "a"\r\netag: "a"\r\n\r\n',
]) assert.throws(() => parseStrictHttpHeaders(duplicate), /duplicate/i);
assert.throws(() => parseStrictHttpHeaders('HTTP/1.1 200 OK\r\n folded\r\n\r\n'), /folded|malformed/i);

const envDir = join(temp, "env-contract");
mkdirs(envDir);
const envValues = Object.fromEntries(MEASURE_ENV_KEYS.map((key) => [key, key === "DB_PASSWORD" ? '"quoted=value"' : key === "APP_IMAGE" ? "fixture@sha256:" + "1".repeat(64) : ""]));
const envPath = join(envDir, ".env.measure");
writeFileSync(envPath, `${MEASURE_ENV_KEYS.map((key) => `${key}=${envValues[key]}`).join("\r\n")}\r\n`);
assert.equal(parseMeasureEnv(envPath).values.DB_PASSWORD, "quoted=value");
assert.doesNotThrow(() => auditMeasureEnvFile(envPath, { ambient: { APP_IMAGE: "ignored-command-selector" } }));
assert.throws(() => auditMeasureEnvFile(envPath, { ambient: { AUTH_SECRET: "override" } }), /ambient environment overrides/);
const snapshotPath = join(envDir, "private.snapshot");
const snapshotKey = "9".repeat(64);
const snapshotAudit = createMeasureEnvSnapshot(envPath, snapshotPath, { ambient: {}, key: snapshotKey });
assert.deepEqual(readFileSync(snapshotPath), readFileSync(envPath));
assert.doesNotThrow(() => verifyMeasureEnvSnapshot(snapshotPath, { ambient: {}, key: snapshotKey, expectedHmac: snapshotAudit.snapshot_hmac_sha256 }));
writeFileSync(snapshotPath, readFileSync(snapshotPath, "utf8").replace('DB_PASSWORD="quoted=value"', 'DB_PASSWORD="changed=value"'));
assert.throws(() => verifyMeasureEnvSnapshot(snapshotPath, { ambient: {}, key: snapshotKey, expectedHmac: snapshotAudit.snapshot_hmac_sha256 }), /changed after it was frozen/);
const duplicateEnv = join(envDir, "duplicate.env");
writeFileSync(duplicateEnv, `${readFileSync(envPath, "utf8")}DB_PASSWORD=again\n`);
assert.throws(() => parseMeasureEnv(duplicateEnv), /duplicate key/);
const controlEnv = join(envDir, "control.env");
writeFileSync(controlEnv, Buffer.concat([readFileSync(envPath), Buffer.from([0])]));
assert.throws(() => parseMeasureEnv(controlEnv), /control bytes/);
try {
  const link = join(envDir, "linked.env"); symlinkSync(envPath, link, "file");
  assert.throws(() => parseMeasureEnv(link), /non-reparse/);
} catch (error) { if (error.code !== "EPERM") throw error; }

const measureStackSource = readFileSync(resolve(repo, "measurement/stack/measure-stack.sh"), "utf8");
for (const contract of [
  /with-private-env -- <command>/,
  /tacbookings-measure-phase2\.lock/,
  /randomBytes\(32\)/,
  /--snapshot-source "\$\(cygpath -am measurement\/stack\/\.env\.measure\)"/,
  /--snapshot-out "\$snapshot" --hmac-key-file "\$key_file" --audit-out "\$audit_file"/,
  /MEASURE_ENV_SNAPSHOT="\$snapshot"/,
  /MEASURE_ENV_SNAPSHOT_HMAC_SHA256="\$snapshot_hmac"/,
  /PHASE2_ENV_AUDIT_HMAC_KEY_FILE="\$key_file"/,
  /grep -qx "token=\$lock_token"/,
  /rm -f -- "\$lock_dir\/\.env\.measure\.snapshot" "\$lock_dir\/runtime-env-hmac\.key"/,
  /"\$@" && command_status=0 \|\| command_status=\$\?/,
  /cleanup_private_env "\$command_status"/,
]) assert.match(measureStackSource, contract);
assert(measureStackSource.indexOf("with_private_env") < measureStackSource.indexOf(': "${MEASURE_ENV_SNAPSHOT:'),
  "the wrapper must create its private bindings before inner stack commands require them");

const sourceSection = (source, start, end) => {
  const startAt = source.indexOf(start);
  const endAt = end === null ? source.length : source.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) throw new Error(`missing stack source section: ${start}`);
  return source.slice(startAt, endAt);
};
const requireOrdered = (source, markers, message) => {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    if (next < 0) throw new Error(message);
    cursor = next;
  }
};
const assertStackPreparationOrdering = (source) => {
  const reset = sourceSection(source, "prepare_database() {", "require_absolute_file_path() {");
  requireOrdered(reset, [
    "compose up -d --wait postgres",
    "stop_application_writers",
    "DROP SCHEMA public CASCADE",
    "npx prisma migrate deploy",
    "npx tsx prisma/demo-seed.ts",
    "npx tsx prisma/seed.ts",
  ], "stack preparation must stop app and caddy before reset, migration and both seeds");

  const dump = sourceSection(source, "create_canonical_dump() (", "prepare_stack() (");
  requireOrdered(dump, [
    "pg_dump",
    "pg_restore --list",
    "fs.linkSync",
    'sha256sum "$archive"',
  ], "canonical dump must be verified and atomically published before completion");

  const preparation = sourceSection(source, "prepare_stack() (", "restore_canonical_dump() {");
  requireOrdered(preparation, [
    "trap cleanup_failed_preparation EXIT",
    "prepare_database",
    'create_canonical_dump "$archive"',
    "start_application_writers",
    "preparation_complete=true",
    "trap - EXIT INT TERM",
  ], "canonical dump publication must precede writer restart and successful guard release");
  if (!/cleanup_failed_preparation\(\) \{[\s\S]*?stop_application_writers >\/dev\/null 2>&1 \|\| true[\s\S]*?exit "\$status"/.test(preparation)) {
    throw new Error("failed stack preparation must leave app and caddy stopped");
  }

  const restore = sourceSection(source, "restore_canonical_dump() {", 'case "${1:-}" in');
  requireOrdered(restore, ["stop_application_writers", "DROP SCHEMA IF EXISTS public CASCADE"],
    "canonical restore must stop app and caddy before resetting the schema");

  const actions = sourceSection(source, 'case "${1:-}" in', null);
  if (!/prepare\) prepare_stack ;;/.test(actions)
      || !/prepare-canonical-dump\)[\s\S]*?prepare_stack "\$1"/.test(actions)
      || /prepare-canonical-dump\)[\s\S]*?\n\s+prepare\n\s+create_canonical_dump/.test(actions)) {
    throw new Error("stack actions must use the guarded factored preparation path");
  }
};
assertStackPreparationOrdering(measureStackSource);

const EXPECTED_PUBLIC_STACK_ACTIONS = [
  "with-private-env",
  "prepare",
  "prepare-canonical-dump",
  "restore-canonical-dump",
  "database-fingerprint",
  "provider-isolation-audit",
  "app-image",
  "restart-app",
  "up",
  "stop",
  "down",
  "destroy",
  "compose",
];
const assertPublicStackActionCensus = (source) => {
  const wrapperMatch = /if \[\[ "\$\{1:-\}" == ([a-z][a-z0-9-]*) \]\]; then/.exec(source);
  if (!wrapperMatch) throw new Error("public stack action census is missing the private wrapper");
  const actions = sourceSection(source, 'case "${1:-}" in', null);
  const caseActions = [...actions.matchAll(/^  ([a-z][a-z0-9-]*)\)/gm)].map((match) => match[1]);
  const actual = [wrapperMatch[1], ...caseActions];
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_PUBLIC_STACK_ACTIONS)) {
    throw new Error(`public stack action census differs: ${actual.join(",")}`);
  }
  if (!/prepare-canonical-dump\)[\s\S]*?prepare_stack "\$1"/.test(actions)) {
    throw new Error("the public canonical dump action must use guarded stack preparation");
  }
  const header = sourceSection(source, "#!/usr/bin/env bash", "set -euo pipefail");
  if (/^#\s+measurement\/stack\/measure-stack\.sh create-canonical-dump\b/m.test(header)
      || /\|create-canonical-dump <(?:absolute-)?path>/.test(actions)) {
    throw new Error("standalone canonical dump action must not be documented or advertised");
  }
};
assertPublicStackActionCensus(measureStackSource);

const directDumpActionMutation = measureStackSource.replace(
  "  restore-canonical-dump)",
  '  create-canonical-dump)\n    create_canonical_dump "$1"\n    ;;\n  restore-canonical-dump)',
);
assert.notEqual(directDumpActionMutation, measureStackSource, "direct-dump action mutation fixture must apply");
assert.throws(() => assertPublicStackActionCensus(directDumpActionMutation), /public stack action census differs/);

const unguardedCombinedActionMutation = measureStackSource.replace(
  '    prepare_stack "$1"',
  '    create_canonical_dump "$1"',
);
assert.notEqual(unguardedCombinedActionMutation, measureStackSource, "unguarded combined-action mutation fixture must apply");
assert.throws(() => assertPublicStackActionCensus(unguardedCombinedActionMutation), /must use guarded stack preparation/);

const missingPreResetStopMutation = measureStackSource.replace(
  '  stop_application_writers\n\n  echo "==> Resetting database schema"',
  '  : # mutation: schema reset would retain live writers\n\n  echo "==> Resetting database schema"',
);
assert.notEqual(missingPreResetStopMutation, measureStackSource, "writer-stop mutation fixture must apply");
assert.throws(() => assertStackPreparationOrdering(missingPreResetStopMutation), /stop app and caddy before reset/);

const startBeforeDumpMutation = measureStackSource.replace(
  '  if [[ -n "$archive" ]]; then\n    create_canonical_dump "$archive"\n  fi\n  start_application_writers',
  '  start_application_writers\n  if [[ -n "$archive" ]]; then\n    create_canonical_dump "$archive"\n  fi',
);
assert.notEqual(startBeforeDumpMutation, measureStackSource, "writer-restart mutation fixture must apply");
assert.throws(() => assertStackPreparationOrdering(startBeforeDumpMutation), /dump publication must precede writer restart/);

const missingFailureStopMutation = measureStackSource.replace(
  "      stop_application_writers >/dev/null 2>&1 || true",
  "      true # mutation: writers would remain available after a partial restart",
);
assert.notEqual(missingFailureStopMutation, measureStackSource, "failure-stop mutation fixture must apply");
assert.throws(() => assertStackPreparationOrdering(missingFailureStopMutation), /must leave app and caddy stopped/);

const phase2Readme = readFileSync(resolve(repo, "measurement/phase2/README.md"), "utf8");
const correctnessReadme = readFileSync(resolve(repo, "measurement/current-main-refresh/README.md"), "utf8");
for (const readme of [phase2Readme, correctnessReadme]) {
  assert.match(readme, /measure-stack\.sh with-private-env --/);
  assert.match(readme, /finalize-correctness-evidence\.mjs/);
}
assert.match(phase2Readme, /prepare-canonical-dump/);
assert.match(phase2Readme, /process\.versions\.node/);
assert.match(phase2Readme, /\.nvmrc is authoritative/);
assert.match(phase2Readme, /Every schema reset stops both `app` and `caddy` before `DROP SCHEMA`/);
assert.match(phase2Readme, /atomically published, then starts them/);
assert.match(phase2Readme, /leaves both services stopped/);
assert.doesNotMatch(phase2Readme, /^bash measurement\/stack\/measure-stack\.sh (?:prepare|down)$/m,
  "manual stack commands must not bypass the private snapshot wrapper");
assert.match(correctnessReadme, /\.\.\/phase2\/README\.md/);
assert.doesNotMatch(correctnessReadme, /\]\(\.\.\/README\.md\)/,
  "the correctness README must not link to a nonexistent measurement hub");

const validRuntimeValues = Object.fromEntries(AUDITED_KEYS.map((key) => [key, ""]));
Object.assign(validRuntimeValues, {
  APP_RUNTIME_ROLE: "web-measure", CRON_ENABLED: "false", NODE_ENV: "production", TZ: "Pacific/Auckland", KEEP_ALIVE_TIMEOUT: "65000", LOG_LEVEL: "info",
  AUTH_TRUST_HOST: "true", AUTH_SECRET: "fixture-auth", NEXTAUTH_SECRET: "fixture-auth", CRON_SECRET: "fixture-cron", NEXTAUTH_URL: "http://localhost:8027",
  // #3035: the DECLARED capture pairing the real stack now renders. The fixture
  // used to pin the stale relay pairing, so the self-test stayed GREEN while the
  // real audit was broken — the same vacuous shape this epic keeps hitting.
  APP_ENVIRONMENT_ROLE: "non-production", USE_AWS_SES: "false", USE_SMTP_RELAY: "false", USE_LOCAL_CAPTURE: "true", EMAIL_SERVER_HOST: "mailpit", EMAIL_SERVER_PORT: "1025", EMAIL_SERVER_USER: "measurement", EMAIL_SERVER_PASSWORD: "measurement-only", EMAIL_FROM: "noreply@measurement.invalid",
  DATABASE_URL: "postgresql://tac:fixture-db@postgres:5432/tacbookings?connection_limit=10&pool_timeout=10", SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN: "false", BACKUP_CRON_SCHEDULE: "0 3 * * *", MIRO_JWT_EXP: "1h",
});
const inspectFor = (values, extras = {}) => [{ Config: { Env: Object.entries({ ...values, ...extras }).map(([key, value]) => `${key}=${value}`) } }];
const hmacKey = "a".repeat(64);
const runtimeAudit = auditAppEnvironment(inspectFor(validRuntimeValues), hmacKey);
assert.equal(runtimeAudit.verified, true);
assert.equal(runtimeAudit.keyed_fingerprint_sha256, auditAppEnvironment([{ Config: { Env: [...inspectFor(validRuntimeValues)[0].Config.Env].reverse() } }], hmacKey).keyed_fingerprint_sha256);
for (const key of LIVE_PROVIDER_KEYS) assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { [key]: "live-value" }), hmacKey), /prohibited live-provider/);
assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { ANTHROPIC_API_KEY: "" }), hmacKey), /unknown provider\/sensitive/);
for (const key of ["NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) assert.throws(() => auditAppEnvironment(inspectFor(validRuntimeValues, { [key]: "http://proxy.invalid" }), hmacKey), /unapproved influential/);
assert.notEqual(runtimeAudit.keyed_fingerprint_sha256, auditAppEnvironment(inspectFor(validRuntimeValues, { HARMLESS_IMAGE_METADATA: "changed" }), hmacKey).keyed_fingerprint_sha256);
const invalidDatabaseSecret = "not-a-url-private-material";
assert.throws(() => auditAppEnvironment(inspectFor({ ...validRuntimeValues, DATABASE_URL: invalidDatabaseSecret }), hmacKey), (error) => /not a valid isolated/.test(error.message) && !error.message.includes(invalidDatabaseSecret));
for (const [key, value] of [["APP_RUNTIME_ROLE", "web"], ["CRON_ENABLED", "true"], ["NEXTAUTH_URL", "https://live.example"], ["AUTH_SECRET", "different"], ["DATABASE_URL", "postgresql://tac:x@other:5432/tacbookings?connection_limit=10&pool_timeout=10"], ["USE_AWS_SES", "true"], ["NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-live"],
  // #3035: the two environment-safety values. `production` here would be a
  // measurement stack claiming to be the club's live site; dropping the capture
  // declaration would be a copy that silently sends nothing at all.
  ["APP_ENVIRONMENT_ROLE", "production"], ["APP_ENVIRONMENT_ROLE", ""], ["USE_LOCAL_CAPTURE", "false"], ["USE_SMTP_RELAY", "true"]]) {
  assert.throws(() => auditAppEnvironment(inspectFor({ ...validRuntimeValues, [key]: value }), hmacKey));
}
const duplicatedEnvInspect = inspectFor(validRuntimeValues); duplicatedEnvInspect[0].Config.Env.push("AUTH_SECRET=again");
assert.throws(() => auditAppEnvironment(duplicatedEnvInspect, hmacKey), /duplicate key/);

const databaseAudit = { schema_version: 1, forbidden_integration_credential_count: 0, xero_token_count: 0, club_module_settings_rows: 0, unsafe_club_module_settings_rows: 0, analytics_settings_rows: 0, unsafe_analytics_settings_rows: 0 };
const dbInput = join(temp, "db-audit.json"); writeFileSync(dbInput, JSON.stringify(databaseAudit));
run("verify-database-isolation.mjs", ["--input", dbInput, "--out", join(temp, "db-audit-verified.json")]);
for (const key of ["forbidden_integration_credential_count", "xero_token_count", "unsafe_club_module_settings_rows", "unsafe_analytics_settings_rows"]) {
  const input = join(temp, `db-${key}.json`); writeFileSync(input, JSON.stringify({ ...databaseAudit, [key]: 1 }));
  rejects("verify-database-isolation.mjs", ["--input", input, "--out", join(temp, `db-${key}-out.json`)], /permits a live provider/);
}

const scanRoot = join(temp, "scan-safe"); mkdirs(scanRoot); writeFileSync(join(scanRoot, "safe.txt"), "AUTH_SECRET=${AUTH_SECRET}\nSOME_API_KEY=placeholder\nTOKEN_COUNT=1\nEMAIL_FROM=noreply@measurement.invalid\n");
const scanPath = join(scanRoot, "secret-scan.json");
const scan = scanEvidence({ root: scanRoot, out: scanPath });
verifySecretScan({ root: scanRoot, report: scan });
for (const [name, bytes, pattern] of [
  ["quoted", Buffer.from('AUTH_SECRET="real-secret-material"\n'), /potential secrets/],
  ["argument", Buffer.from('--token "real-command-token"\n'), /potential secrets/],
  ["utf16", Buffer.from('DB_PASSWORD="utf16-secret-material"', "utf16le"), /potential secrets/],
  ["nul-private-key", Buffer.concat([Buffer.from([0]), Buffer.from("-----BEGIN PRIVATE KEY-----")]), /potential secrets/],
  ["sentry", Buffer.from("NEXT_PUBLIC_SENTRY_DSN=https://publickey@o1.ingest.sentry.io/123\n"), /potential secrets/],
  ["ai-diagnostics", Buffer.from("AI_DIAGNOSTICS_DATABASE_URL=postgresql://ai:private@remote/db\n"), /potential secrets/],
  ["legacy", Buffer.from("LEGACY_DASHBOARD_EXPORT_TOKEN=legacy-private-token\n"), /potential secrets/],
  ["miro", Buffer.from("MIRO_JWT_KEY=miro-private-material\n"), /potential secrets/],
  ["xero", Buffer.from("XERO_WEBHOOK_KEY=xero-private-material\n"), /potential secrets/],
  ["generic-aws", Buffer.from("AWS_SECRET_ACCESS_KEY=aws-private-material\n"), /potential secrets/],
  ["aws-session", Buffer.from("AWS_SESSION_TOKEN=very-private-session-token-material\n"), /potential secrets/],
  ["aws-security", Buffer.from("AWS_SECURITY_TOKEN=very-private-security-token-material\n"), /potential secrets/],
  ["anthropic", Buffer.from("ANTHROPIC_API_KEY=anthropic-private-material\n"), /potential secrets/],
  ["generic-api-key", Buffer.from("SOME_API_KEY=generic-private-material\n"), /potential secrets/],
  ["backup", Buffer.from("BACKUP_S3_SECRET_ACCESS_KEY=backup-private-material\n"), /potential secrets/],
  ["allowed-substring", Buffer.from("AUTH_SECRET=real-measurement-secret\n"), /potential secrets/],
  ["nul-split", Buffer.from("A\0U\0T\0H\0_\0S\0E\0C\0R\0E\0T\0=\0n\0u\0l\0-\0s\0p\0l\0i\0t\0-\0s\0e\0c\0r\0e\0t\n"), /potential secrets/],
]) {
  const root = join(temp, `scan-${name}`); mkdirs(root); writeFileSync(join(root, "evidence.bin"), bytes);
  assert.throws(() => scanEvidence({ root, out: join(root, "secret-scan.json") }), pattern);
}

const sealed = join(temp, "sealed"); mkdirs(join(sealed, "nested")); writeFileSync(join(sealed, "nested", "evidence.txt"), "immutable\n");
finalizeSealedTree({ root: sealed }); verifySealedTree(sealed);
writeFileSync(join(sealed, "extra.txt"), "late\n"); assert.throws(() => verifySealedTree(sealed), /census differs/);
const sealedExtraDir = join(temp, "sealed-extra-dir"); mkdirs(sealedExtraDir); writeFileSync(join(sealedExtraDir, "evidence.txt"), "immutable\n"); finalizeSealedTree({ root: sealedExtraDir }); mkdirSync(join(sealedExtraDir, "empty-extra")); assert.throws(() => verifySealedTree(sealedExtraDir), /census differs/);

assert.doesNotThrow(() => validateCensus(correctnessCensus()));
assert.throws(() => validateCensus({ ...correctnessCensus(), checks: correctnessCensus().checks.slice(1) }), /exact reviewed MC\/BND census/);
const preTimingChecks = CORRECTNESS_CENSUS.filter((check) => check.required_sides.includes("current")).map((check) => PHASE2_DEFERRED_CHECK_IDS.current.includes(check.id)
  ? { id: check.id, applicability: "deferred_to_phase2", outcome: "DEFERRED_TO_PHASE2", producer_ids: [], evidence: [] }
  : { id: check.id, applicability: "required", outcome: "PASS", producer_ids: [check.allowed_producers[0]], evidence: [{ path: `fixture/${check.id}`, sha256: "1".repeat(64) }] });
assert.equal(classifyPreTimingResult("current", preTimingChecks, { passed: true, findings: [] }), "pre_timing_passed");
assert.notEqual(classifyPreTimingResult("current", preTimingChecks, { passed: true, findings: [] }), "passed");
const promotedBeforeTiming = preTimingChecks.map((check) => check.id === "MC-08B" ? { ...check, applicability: "required", outcome: "PASS" } : check);
assert.throws(() => classifyPreTimingResult("current", promotedBeforeTiming, { passed: true, findings: [] }), /not exactly deferred/);
const forgedDeferral = preTimingChecks.map((check) => check.id === "MC-01A" ? { ...check, applicability: "deferred_to_phase2", outcome: "DEFERRED_TO_PHASE2", producer_ids: [], evidence: [] } : check);
assert.throws(() => classifyPreTimingResult("current", forgedDeferral, { passed: true, findings: [] }), /non-phase2 check cannot be deferred/);
const currentPhase2 = buildPhase2Correctness("current");
assert.doesNotThrow(() => validatePhase2Correctness(currentPhase2, "current"));
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.slice(1) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, outcome: "FAIL" } : check) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, id: "BND-02" } : check) }, "current"), /exact sealed current contract/);
assert.throws(() => validatePhase2Correctness({ ...currentPhase2, checks: currentPhase2.checks.map((check) => check.id === "MC-08B" ? { ...check, producer_id: "cms-lifecycle" } : check) }, "current"), /exact sealed current contract/);

const sourceRepo = join(temp, "producer-source-repo"); mkdirs(sourceRepo);
execFileSync("git", ["init", "--quiet"], { cwd: sourceRepo });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: sourceRepo });
execFileSync("git", ["config", "user.email", "phase2-selftest@example.invalid"], { cwd: sourceRepo });
execFileSync("git", ["config", "user.name", "Phase 2 self-test"], { cwd: sourceRepo });
for (const [index, path] of EXPECTED_PRODUCER_SOURCE_PATHS.entries()) {
  const absolute = join(sourceRepo, ...path.split("/")); mkdirs(resolve(absolute, "..")); writeFileSync(absolute, `reviewed producer source ${index}\n`);
}
execFileSync("git", ["add", "."], { cwd: sourceRepo });
execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: sourceRepo });
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRepo, encoding: "utf8" }).trim();
const exactSourceArchive = join(temp, "reviewed-producers.tar");
execFileSync("git", ["archive", "--format=tar", `--output=${exactSourceArchive}`, sourceRevision], { cwd: sourceRepo });
const exactSourceManifest = join(temp, "reviewed-producers.sha256");
const archivedSources = readGitArchive(exactSourceArchive);
const validSourceManifestText = `# schema_version=1\n# producer_source_archive_sha256=${sha256File(exactSourceArchive)}\n# producer_source_commit=${sourceRevision}\n${EXPECTED_PRODUCER_SOURCE_PATHS.map((path) => `${sha(archivedSources.files.get(path))}  ${path}`).join("\n")}\n`;
writeFileSync(exactSourceManifest, validSourceManifestText);
const fixtureProducerManifest = join(temp, "fixture-producers.sha256"); writeFileSync(fixtureProducerManifest, validSourceManifestText);
assert.equal(validateProducerFilesManifest(exactSourceManifest, exactSourceArchive).archiveRevision, sourceRevision);
assert.deepEqual(EXPECTED_PRODUCER_SOURCE_PATHS, [...EXPECTED_PRODUCER_SOURCE_PATHS].sort());
const integratedProducerManifestBuilder = resolve(repo, "measurement/current-main-refresh/bin/build-producer-manifest.mjs");
if (existsSync(integratedProducerManifestBuilder)) {
  const integratedManifest = join(temp, "integrated-producer-files.sha256");
  execFileSync(process.execPath, [integratedProducerManifestBuilder, "--producer-source-archive", exactSourceArchive, "--producer-source-commit", sourceRevision, "--out", integratedManifest], { cwd: repo, encoding: "utf8", stdio: "pipe" });
  assert.equal(validateProducerFilesManifest(integratedManifest, exactSourceArchive).count, EXPECTED_PRODUCER_SOURCE_PATHS.length);
}
const harnessFixturePaths = EXPECTED_PRODUCER_SOURCE_PATHS.filter((path) => path.startsWith("measurement/phase2/bin/") || ["docker-compose.yml", "Caddyfile.staging", "measurement/stack/docker-compose.measure.yml", "measurement/stack/measure-stack.sh"].includes(path));
const harnessFixtureManifest = join(temp, "live-harness.sha256");
const writeHarnessFixture = () => writeFileSync(harnessFixtureManifest, `${harnessFixturePaths.map((path) => `${sha256File(join(sourceRepo, ...path.split("/")))}  ${join(sourceRepo, ...path.split("/"))}`).join("\n")}\n`);
writeHarnessFixture();
assert.doesNotThrow(() => verifyHarnessAgainstProducerArchive({ harnessManifestPath: harnessFixtureManifest, producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo }));
for (const sourcePath of ["measurement/phase2/bin/verify-harness-source.mjs", "measurement/phase2/bin/summarise.mjs", "measurement/phase2/bin/aggregate-pairs.mjs"]) {
  const livePath = join(sourceRepo, ...sourcePath.split("/"));
  writeFileSync(livePath, "modified after reviewed producer archive binding\n");
  writeHarnessFixture();
  assert.throws(() => verifyHarnessAgainstProducerArchive({ harnessManifestPath: harnessFixtureManifest, producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo }), /differ from the reviewed producer source archive/);
  writeFileSync(livePath, archivedSources.files.get(sourcePath));
}
writeHarnessFixture();
assert.doesNotThrow(() => verifyHarnessAgainstProducerArchive({ harnessManifestPath: harnessFixtureManifest, producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo }));
const liveProducerOptions = { producerManifestPath: exactSourceManifest, producerArchivePath: exactSourceArchive, producerCommit: sourceRevision, repoRoot: sourceRepo };
assert.equal(verifyLiveProducerSource(liveProducerOptions).count, EXPECTED_PRODUCER_SOURCE_PATHS.length);
const extraGovernedSource = join(sourceRepo, "measurement", "phase2", "bin", "unreviewed-extra.mjs");
writeFileSync(extraGovernedSource, "unreviewed extra source\n");
assert.throws(() => verifyLiveProducerSource(liveProducerOptions), /missing, extra, or case-drifted/);
unlinkSync(extraGovernedSource);
const preservedResults = join(sourceRepo, "measurement", "phase2", "results", "preserved-evidence.json"); mkdirs(resolve(preservedResults, "..")); writeFileSync(preservedResults, "{}\n");
assert.equal(verifyLiveProducerSource(liveProducerOptions).count, EXPECTED_PRODUCER_SOURCE_PATHS.length);
const exactCaseSource = join(sourceRepo, "measurement", "phase2", "bin", "summarise.mjs");
const wrongCaseSource = join(sourceRepo, "measurement", "phase2", "bin", "Summarise.mjs");
renameSync(exactCaseSource, wrongCaseSource);
assert.throws(() => verifyLiveProducerSource(liveProducerOptions), /wrong case|case-drifted/);
renameSync(wrongCaseSource, exactCaseSource);
const symlinkSource = join(sourceRepo, "measurement", "phase2", "bin", "statistics.mjs");
const symlinkTarget = join(temp, "reviewed-statistics-source.mjs"); writeFileSync(symlinkTarget, archivedSources.files.get("measurement/phase2/bin/statistics.mjs"));
unlinkSync(symlinkSource);
try {
  symlinkSync(symlinkTarget, symlinkSource, "file");
  assert.throws(() => verifyLiveProducerSource(liveProducerOptions), /symbolic link|differs from the reviewed archive/);
  unlinkSync(symlinkSource);
} catch (error) {
  if (error.code !== "EPERM") throw error;
}
writeFileSync(symlinkSource, archivedSources.files.get("measurement/phase2/bin/statistics.mjs"));
assert.equal(verifyLiveProducerSource(liveProducerOptions).count, EXPECTED_PRODUCER_SOURCE_PATHS.length);
writeFileSync(exactSourceManifest, `${readFileSync(exactSourceManifest, "utf8")} ${"0".repeat(64)}  arbitrary.txt\n`);
assert.throws(() => validateProducerFilesManifest(exactSourceManifest, exactSourceArchive), /invalid producer-files|archive binding|source-path census/);

// Exercise the composed correctness finalizer/verifier by default. This is a
// complete dependency-free facsimile of both side trees, not a classifier-only
// test: every immutable input and every raw producer artifact is created before
// the real finalizer builds and seals its derived chain.
const appSourceRepo = join(temp, "app-source-repo"); mkdirs(appSourceRepo);
execFileSync("git", ["init", "--quiet"], { cwd: appSourceRepo });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: appSourceRepo });
execFileSync("git", ["config", "user.email", "phase2-selftest@example.invalid"], { cwd: appSourceRepo });
execFileSync("git", ["config", "user.name", "Phase 2 self-test"], { cwd: appSourceRepo });
writeFileSync(join(appSourceRepo, "app-source.txt"), "immutable application source fixture\n");
execFileSync("git", ["add", "."], { cwd: appSourceRepo });
execFileSync("git", ["commit", "--quiet", "-m", "app fixture"], { cwd: appSourceRepo });
const appSourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appSourceRepo, encoding: "utf8" }).trim();
const appSourceArchive = join(temp, "reviewed-app.tar");
execFileSync("git", ["archive", "--format=tar", `--output=${appSourceArchive}`, appSourceRevision], { cwd: appSourceRepo });
const fixtureDatabaseArchive = join(temp, "canonical-fixture.dump"); writeFileSync(fixtureDatabaseArchive, "canonical isolated database fixture\n");
const fixtureFingerprint = "6".repeat(64);
const fixturePostgresImage = `sha256:${"7".repeat(64)}`;
const fixtureWriterCensus = archivedSources.files.get("measurement/current-main-refresh/public-writer-census.json");

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const runtimeFixtureRoot = join(temp, "runtime-fixture"); mkdirs(join(runtimeFixtureRoot, "node_modules"));
const runtimePackageNames = ["@playwright/test", "playwright", "playwright-core", "axe-core"];
const runtimeVersion = "1.2.3";
const runtimeIntegrity = "sha512-YWJj";
const runtimePackageEntries = Object.fromEntries(runtimePackageNames.map((name) => [`node_modules/${name}`, { version: runtimeVersion, integrity: runtimeIntegrity }]));
const runtimeRootPackagePath = join(runtimeFixtureRoot, "package.json"); writeJson(runtimeRootPackagePath, { name: "phase2-runtime-fixture", version: "1.0.0", engines: { node: ">=24.0.0 <25" } });
const runtimeRootLockPath = join(runtimeFixtureRoot, "package-lock.json"); writeJson(runtimeRootLockPath, { lockfileVersion: 3, packages: { "": { name: "phase2-runtime-fixture", version: "1.0.0" }, ...runtimePackageEntries } });
const runtimeInstalledLockPath = join(runtimeFixtureRoot, "node_modules", ".package-lock.json"); writeJson(runtimeInstalledLockPath, { lockfileVersion: 3, packages: runtimePackageEntries });
const runtimePackages = {};
for (const name of runtimePackageNames) {
  const packagePath = join(runtimeFixtureRoot, "node_modules", ...name.split("/"), "package.json"); mkdirs(resolve(packagePath, "..")); writeJson(packagePath, { name, version: runtimeVersion, ...(name === "playwright" ? { main: "index.js" } : {}) });
  runtimePackages[name] = { version: runtimeVersion, package_json_path: packagePath, package_json_sha256: sha256File(packagePath), root_lock_integrity: runtimeIntegrity, installed_lock_integrity: runtimeIntegrity };
}
const runtimeBrowserRegistryPath = join(runtimeFixtureRoot, "node_modules", "playwright-core", "browsers.json"); writeJson(runtimeBrowserRegistryPath, { browsers: [{ name: "chromium", revision: "1234", browserVersion: "141.0.0.0" }] });
const runtimeChromiumExecutablePath = join(runtimeFixtureRoot, "chromium", "chrome.exe"); mkdirs(resolve(runtimeChromiumExecutablePath, "..")); writeFileSync(runtimeChromiumExecutablePath, "fixture Chromium executable bytes\n");
writeFileSync(join(runtimeFixtureRoot, "node_modules", "playwright", "index.js"), `exports.chromium={executablePath:()=>${JSON.stringify(runtimeChromiumExecutablePath)}};\n`);
const describedRuntimeFile = (path) => ({ path, size_bytes: statSync(path).size, sha256: sha256File(path) });
const runtimePhysicalNodeExecutable = realpathSync.native(process.execPath);
const runtimeProvenanceFixture = {
  schema_version: 1,
  node: { version: process.version, executable: describedRuntimeFile(runtimePhysicalNodeExecutable) },
  root_package: describedRuntimeFile(runtimeRootPackagePath),
  root_lock: { ...describedRuntimeFile(runtimeRootLockPath), lockfile_version: 3 },
  installed_lock: { ...describedRuntimeFile(runtimeInstalledLockPath), lockfile_version: 3 },
  packages: runtimePackages,
  chromium: { browser_version: "141.0.0.0", revision: "1234", registry: describedRuntimeFile(runtimeBrowserRegistryPath), executable: describedRuntimeFile(runtimeChromiumExecutablePath) },
};
const runtimeFixtureContext = { repoRoot: runtimeFixtureRoot, nodeExecutable: process.execPath, nodeVersion: process.version, chromiumExecutable: runtimeChromiumExecutablePath };
assert.equal(runtimeProvenanceFixture.node.executable.path, realpathSync.native(runtimeFixtureContext.nodeExecutable), "fnm aliases must resolve to the exact physical Node executable recorded in provenance");
assert.doesNotThrow(() => validateRuntimeProvenance(runtimeProvenanceFixture, runtimeFixtureContext));
assert.throws(() => validateRuntimeProvenance(runtimeProvenanceFixture, { ...runtimeFixtureContext, repoRoot: join(temp, "fabricated-runtime-root") }), /lock\/package\/Node identity|file binding/);
const crossPackageRuntime = structuredClone(runtimeProvenanceFixture);
crossPackageRuntime.packages.playwright.package_json_path = runtimeProvenanceFixture.packages["axe-core"].package_json_path;
crossPackageRuntime.packages.playwright.package_json_sha256 = runtimeProvenanceFixture.packages["axe-core"].package_json_sha256;
assert.throws(() => validateRuntimeProvenance(crossPackageRuntime, runtimeFixtureContext), /package binding/);
const wrongNodeRuntime = structuredClone(runtimeProvenanceFixture); wrongNodeRuntime.node.executable = describedRuntimeFile(runtimeChromiumExecutablePath);
assert.throws(() => validateRuntimeProvenance(wrongNodeRuntime, runtimeFixtureContext), /lock\/package\/Node identity/);
const wrongChromiumRuntime = structuredClone(runtimeProvenanceFixture); wrongChromiumRuntime.chromium.executable = describedRuntimeFile(runtimePhysicalNodeExecutable);
assert.throws(() => validateRuntimeProvenance(wrongChromiumRuntime, runtimeFixtureContext), /registry\/executable/);
const rootPackageBytes = readFileSync(runtimeRootPackagePath);
writeJson(runtimeRootPackagePath, { name: "phase2-runtime-fixture", version: "1.0.0" });
const wrongEngineRuntime = structuredClone(runtimeProvenanceFixture); wrongEngineRuntime.root_package = describedRuntimeFile(runtimeRootPackagePath);
assert.throws(() => validateRuntimeProvenance(wrongEngineRuntime, runtimeFixtureContext), /lock\/package\/Node identity/);
writeFileSync(runtimeRootPackagePath, rootPackageBytes);

function writeCorrectnessStack(root, stage, imageId) {
  const directoryName = stage === "before" ? "inputs" : "postcondition-evidence";
  const directory = join(root, directoryName); mkdirs(directory);
  const container = (service) => ({
    schema_version: 1,
    service,
    container_id: (service === "app" ? (stage === "before" ? "1" : "2") : "3").repeat(64),
    image_id: service === "app" ? imageId : fixturePostgresImage,
    compose_project: "tacbookings-measure",
    compose_service: service,
    network_mode: "tacbookings-measure_default",
    networks: { "tacbookings-measure_default": { NetworkID: "4".repeat(64), IPAddress: service === "app" ? "172.30.0.4" : "172.30.0.2" } },
    ports: { [service === "app" ? "3000/tcp" : "5432/tcp"]: [{ HostIp: "127.0.0.1", HostPort: service === "app" ? "3003" : "5435" }] },
  });
  const leaves = {
    "app-container-inspect.json": container("app"),
    "postgres-container-inspect.json": container("postgres"),
    "postgres-server-version.json": { schema_version: 1, version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    "database-fingerprint.json": { schema_version: 1, logical_fingerprint: fixtureFingerprint },
  };
  for (const [name, value] of Object.entries(leaves)) writeJson(join(directory, name), value);
  const relative = (name) => `${directoryName}/${name}`;
  const bound = (name) => ({ path: relative(name), sha256: sha256File(join(directory, name)) });
  const aggregate = {
    schema_version: 1, stage, compose_project: "tacbookings-measure", image_id: imageId,
    app: { ...bound("app-container-inspect.json"), container_id: leaves["app-container-inspect.json"].container_id },
    postgres: { ...bound("postgres-container-inspect.json"), container_id: leaves["postgres-container-inspect.json"].container_id, image_id: fixturePostgresImage },
    postgres_server: { ...bound("postgres-server-version.json"), version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    database: { ...bound("database-fingerprint.json"), logical_fingerprint: fixtureFingerprint },
    verified: true,
    captured_at: stage === "before" ? "2026-08-06T00:00:00.000Z" : "2026-08-06T00:04:00.000Z",
  };
  const aggregatePath = join(directory, `stack-identity-${stage}.json`); writeJson(aggregatePath, aggregate);
  return aggregatePath;
}

function writeCorrectnessRoutes(root, side, imageId) {
  const directory = join(root, "raw", "cms-lifecycle"); mkdirs(directory);
  const files = [];
  const sample = (stem, cache, body, etag = null) => {
    const headersPath = `raw/cms-lifecycle/${stem}.headers`;
    const bodyPath = `raw/cms-lifecycle/${stem}.body.html`;
    writeFileSync(join(root, ...headersPath.split("/")), `HTTP/1.1 200 OK\r\n${cache ? `X-Nextjs-Cache: ${cache}\r\n` : ""}${etag ? `ETag: ${etag}\r\n` : ""}\r\n`);
    writeFileSync(join(root, ...bodyPath.split("/")), body);
    files.push(headersPath, bodyPath);
    return { headersPath, bodyPath };
  };
  const etag = '"fixture-route"';
  const about1 = sample("binding-about-1", side === "current" ? "MISS" : null, "stable about fixture", side === "current" ? etag : null);
  const about2 = sample("binding-about-2", side === "current" ? "HIT" : null, "stable about fixture", side === "current" ? etag : null);
  const dynamic = Object.fromEntries([["/", "binding-root"], ["/join", "binding-join"], ["/contact", "binding-contact"]].map(([route, stem]) => [route, sample(stem, null, `dynamic fixture ${route}`)]));
  const aboutBodySha = sha256File(join(root, ...about2.bodyPath.split("/")));
  const document = {
    schema_version: 1, side, image_id: imageId,
    routes: {
      "/about": {
        samples: [[side === "current" ? "miss" : "first", about1], [side === "current" ? "hit" : "second", about2]].map(([phase, value]) => ({ phase, headers_path: value.headersPath, body_path: value.bodyPath })),
        derived: side === "current" ? { status: 200, next_cache: "HIT", etag, body_sha256: aboutBodySha } : { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null },
      },
      ...Object.fromEntries(Object.entries(dynamic).map(([route, value]) => [route, { samples: [{ phase: "request", headers_path: value.headersPath, body_path: value.bodyPath }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } }])),
    },
  };
  const evidencePath = "raw/cms-lifecycle/route-response-evidence.json"; writeJson(join(root, ...evidencePath.split("/")), document); files.push(evidencePath);
  return files;
}

function prepareComposedCorrectness(name, side, mutation = {}) {
  const root = join(temp, `composed-${name}`);
  mkdirs(join(root, "inputs"), join(root, "postcondition-evidence"), join(root, "raw", "orchestrator"), join(root, "producer-results"));
  const imageId = `sha256:${(side === "current" ? "a" : "b").repeat(64)}`;
  const census = mutation.censusTamper ? { ...correctnessCensus(), checks: correctnessCensus().checks.slice(1) } : correctnessCensus();
  const censusPath = join(root, "inputs", "check-census.json"); writeJson(censusPath, census);
  const writerPath = join(root, "inputs", "public-writer-census.json");
  writeFileSync(writerPath, mutation.writerTamper ? Buffer.concat([fixtureWriterCensus, Buffer.from("\nwriter census tamper\n")]) : fixtureWriterCensus);
  const producerManifestPath = join(root, "inputs", "producer-files.sha256"); writeFileSync(producerManifestPath, validSourceManifestText);
  const runtimeProvenancePath = join(root, "inputs", "runtime-provenance.json");
  const runtimeProvenance = structuredClone(runtimeProvenanceFixture);
  if (mutation.runtimeSchemaTamper) runtimeProvenance.packages.playwright.root_lock_integrity = null;
  if (mutation.runtimeChromiumTamper) runtimeProvenance.chromium.revision = "not-a-revision";
  writeJson(runtimeProvenancePath, runtimeProvenance);
  const imageInspectPath = join(root, "inputs", "image-inspect.json"); writeJson(imageInspectPath, { id: imageId, oci_revision: appSourceRevision });
  const containerInspectPath = join(root, "inputs", "container-inspect.json"); writeJson(containerInspectPath, { id: "5".repeat(64), image_id: imageId, compose_project: "tacbookings-measure", compose_service: "app" });
  const stackBeforePath = writeCorrectnessStack(root, "before", imageId);
  writeCorrectnessStack(root, "after", imageId);

  const buildRawPath = join(root, "inputs", "image-build-scan.raw.json");
  writeJson(buildRawPath, { schema_version: 1, image_id: imageId, oci_revision: appSourceRevision, scanned_roots: ["/app/.next/server", "/app/.next/static"], scanned_file_count: 1, scanned_bytes: 1, filesystem_aggregate_sha256: "8".repeat(64), public_sentry_dsn_literal_count: 0, public_sentry_identifier_count: 0, locations: [] });
  const buildRuntimePath = join(root, "inputs", "image-build-runtime-env.json"); writeJson(buildRuntimePath, { schema_version: 1, image_id: imageId, present: false, blank: true });
  const buildIdentityPath = join(root, "inputs", "image-build-identity.json");
  writeJson(buildIdentityPath, {
    schema_version: 1, image_id: imageId, oci_revision: appSourceRevision,
    raw_scan_path: "inputs/image-build-scan.raw.json", raw_scan_sha256: sha256File(buildRawPath),
    scanned_roots: ["/app/.next/server", "/app/.next/static"], scanned_file_count: 1, scanned_bytes: 1,
    filesystem_aggregate_sha256: "8".repeat(64), public_sentry_dsn_literal_count: 0,
    runtime_env: { present: false, blank: true },
    safe_build_input_evidence: { status: "unavailable", reason: "OCI image metadata does not retain Docker build-argument values; the compiled filesystem scan is authoritative" },
    verdict: "passed",
  });

  let producerArchivePath = exactSourceArchive;
  if (mutation.sourceTamper) {
    producerArchivePath = join(temp, `${name}-producer-source.tar`);
    writeFileSync(producerArchivePath, Buffer.concat([readFileSync(exactSourceArchive), Buffer.from("tamper")]));
  }
  const immutable = {
    schema_version: 1, run_id: name, side,
    source: { commit: appSourceRevision, archive_path: appSourceArchive, archive_sha256: sha256File(appSourceArchive) },
    producer_source: { commit: sourceRevision, archive_path: producerArchivePath, archive_sha256: sha256File(producerArchivePath) },
    image: {
      reference: `fixture@${imageId}`, id: imageId, oci_revision: appSourceRevision, inspect_path: imageInspectPath, inspect_sha256: sha256File(imageInspectPath),
      build_evidence: { raw_path: buildRawPath, raw_sha256: sha256File(buildRawPath), typed_path: buildIdentityPath, typed_sha256: sha256File(buildIdentityPath), runtime_path: buildRuntimePath, runtime_sha256: sha256File(buildRuntimePath) },
    },
    container: { inspect_path: containerInspectPath, inspect_sha256: sha256File(containerInspectPath) },
    stack_identity_before: { path: stackBeforePath, sha256: sha256File(stackBeforePath) },
    runtime_provenance: { path: runtimeProvenancePath, sha256: sha256File(runtimeProvenancePath) },
    database: { archive_path: fixtureDatabaseArchive, archive_sha256: sha256File(fixtureDatabaseArchive), logical_fingerprint_before: fixtureFingerprint },
    environment: { base_url: "http://127.0.0.1:8027", compose_project: "tacbookings-measure", release_id_sha256: "9".repeat(64) },
    check_census_path: censusPath, check_census_sha256: sha256File(censusPath),
    writer_census_path: writerPath, writer_census_sha256: sha256File(writerPath),
    producer_files_path: producerManifestPath, producer_files_sha256: sha256File(producerManifestPath),
    created_at: "2026-08-06T00:01:00.000Z",
  };
  if (mutation.schemaDrift) immutable.unreviewed_field = true;
  writeJson(join(root, "inputs", "immutable-inputs.json"), immutable);

  const routePaths = writeCorrectnessRoutes(root, side, imageId);
  for (const [producerId, checkIds] of Object.entries(PRODUCER_CHECK_SCHEMA[side])) {
    const producerDirectory = join(root, "raw", producerId); mkdirs(producerDirectory);
    const genericPath = `raw/${producerId}/evidence.txt`; writeFileSync(join(root, ...genericPath.split("/")), `public fixture evidence for ${producerId}\n`);
    const ownedPaths = [genericPath, ...(producerId === "cms-lifecycle" ? routePaths : [])].sort((left, right) => left.localeCompare(right));
    const observations = checkIds.map((checkId) => ({
      check_id: checkId,
      outcome: "PASS",
      assertions: [`fixture assertion for ${checkId}`],
      evidence_paths: [checkId === "BND-02" && producerId === "cms-lifecycle" ? "raw/cms-lifecycle/route-response-evidence.json" : genericPath],
    }));
    if (mutation.cyclicEvidence && producerId === Object.keys(PRODUCER_CHECK_SCHEMA[side])[0]) observations[0].evidence_paths = ["raw-evidence-manifest.json"];
    // A chain that seals honestly but does not pass. It replaced MC-03D's
    // permanent OWNER_DISPOSITION_NEEDED as the fixture guarding the
    // "not pre-timing ready" gate, once MC-03D became a measurable check
    // (#2663) and every current-side check began passing.
    if (mutation.unverifiedCheck && producerId === Object.keys(PRODUCER_CHECK_SCHEMA[side])[0]) observations[0].outcome = "UNVERIFIED";
    writeJson(join(root, "producer-results", `${producerId}.json`), {
      schema_version: 1, run_id: name, producer_id: producerId, side,
      started_at: "2026-08-06T00:02:00.000Z", ended_at: "2026-08-06T00:03:00.000Z", exit_code: 0,
      cleanup: { status: mutation.failedCleanup && producerId === Object.keys(PRODUCER_CHECK_SCHEMA[side])[0] ? "failed" : "passed", evidence_paths: [genericPath] },
      observations,
      owned_artifacts: ownedPaths.map((path) => ({ path, sha256: sha256File(join(root, ...path.split("/"))), size_bytes: statSync(join(root, ...path.split("/"))).size })),
    });
  }
  writeJson(join(root, "raw", "orchestrator", "app-health.json"), { status: "healthy" });
  if (mutation.extraRaw) writeFileSync(join(root, "raw", "route-manifests", "unowned.txt"), "unowned raw fixture\n");
  writeJson(join(root, "postconditions.json"), {
    schema_version: 1, run_id: name, side,
    database_fingerprint_before: fixtureFingerprint, database_fingerprint_after: fixtureFingerprint, database_unchanged: true,
    app_health: { status: "passed", evidence_paths: ["raw/orchestrator/app-health.json"] },
    completed_at: "2026-08-06T00:05:00.000Z",
  });
  return root;
}

const finalizerTestOptions = { runtimeContext: runtimeFixtureContext, liveSourceRoot: sourceRepo };
const baselineComposed = prepareComposedCorrectness("baseline-composed", "baseline");
finalizeCorrectnessEvidence(baselineComposed, finalizerTestOptions);
const baselineVerified = verifyCorrectnessCompletion(join(baselineComposed, "COMPLETED.json"), { runtimeContext: runtimeFixtureContext });
assert.equal(baselineVerified.report.result, "pre_timing_passed");
assert.deepEqual(baselineVerified.report.checks.filter((check) => check.outcome === "DEFERRED_TO_PHASE2").map((check) => check.id), ["BND-09"]);
const currentComposed = prepareComposedCorrectness("current-composed", "current");
finalizeCorrectnessEvidence(currentComposed, finalizerTestOptions);
const currentVerified = verifyCorrectnessCompletion(join(currentComposed, "COMPLETED.json"), { runtimeContext: runtimeFixtureContext });
assert.equal(currentVerified.report.result, "pre_timing_passed");
assert.deepEqual(currentVerified.report.checks.filter((check) => check.outcome === "DEFERRED_TO_PHASE2").map((check) => check.id), ["MC-08B", "BND-09"]);
// MC-03D is a measured check now, so no side is permanently blocked and the
// current side reaches pre_timing_passed. The gate that refuses a sealed but
// non-passing chain still has to hold, so it is proved against a chain that is
// honestly unverified rather than against MC-03D's old standing block.
const currentUnverified = prepareComposedCorrectness("current-unverified", "current", { unverifiedCheck: true });
finalizeCorrectnessEvidence(currentUnverified, finalizerTestOptions);
assert.equal(verifyCorrectnessCompletion(join(currentUnverified, "COMPLETED.json"), { requirePassed: false, runtimeContext: runtimeFixtureContext }).report.result, "unverified");
assert.throws(() => verifyCorrectnessCompletion(join(currentUnverified, "COMPLETED.json"), { runtimeContext: runtimeFixtureContext }), /not pre-timing ready/);

for (const [name, mutation, pattern] of [
  ["schema-drift", { schemaDrift: true }, /invalid schema/],
  ["runtime-schema-drift", { runtimeSchemaTamper: true }, /runtime provenance package binding/],
  ["runtime-chromium-drift", { runtimeChromiumTamper: true }, /runtime provenance identity/],
  ["census-tamper", { censusTamper: true }, /exact reviewed MC\/BND census/],
  ["failed-cleanup", { failedCleanup: true }, /cleanup\/observations\/artifacts/],
  ["source-tamper", { sourceTamper: true }, /archive|producer-files manifest headers/],
  ["writer-tamper", { writerTamper: true }, /writer census differs/],
  ["extra-raw", { extraRaw: true }, /owned artifact census|outside the authoritative/],
  ["cyclic-evidence", { cyclicEvidence: true }, /semantic evidence|create-only directory/],
]) {
  const root = prepareComposedCorrectness(name, "baseline", mutation);
  assert.throws(() => finalizeCorrectnessEvidence(root, finalizerTestOptions), pattern);
}
const postProducerDriftRoot = prepareComposedCorrectness("post-producer-finalizer-drift", "baseline");
const liveFinalizerPath = join(sourceRepo, "measurement", "phase2", "bin", "finalize-correctness-evidence.mjs");
writeFileSync(liveFinalizerPath, "modified after producer output completed\n");
assert.throws(() => finalizeCorrectnessEvidence(postProducerDriftRoot, finalizerTestOptions), /live producer source differs/);
for (const name of ["raw-evidence-manifest.json", "route-expectations.json", "secret-scan.json", "correctness-report.json", "COMPLETED.json"]) assert.equal(existsSync(join(postProducerDriftRoot, name)), false, `failed finalization must remove exact derived output ${name}`);
writeFileSync(liveFinalizerPath, archivedSources.files.get("measurement/phase2/bin/finalize-correctness-evidence.mjs"));
assert.doesNotThrow(() => finalizeCorrectnessEvidence(postProducerDriftRoot, finalizerTestOptions));
const finalizerSource = readFileSync(join(bin, "finalize-correctness-evidence.mjs"), "utf8");
const finalizerLiveChecks = [...finalizerSource.matchAll(/verifyLiveProducerSource\(producerSourceVerification\)/g)].map((match) => match.index);
assert.equal(finalizerLiveChecks.length, 2, "correctness finalizer must verify exact live producer source twice");
assert(finalizerLiveChecks[0] < finalizerSource.indexOf("const rawManifest = buildRawManifest") && finalizerLiveChecks[1] > finalizerSource.indexOf("const completion =") && finalizerLiveChecks[1] < finalizerSource.indexOf('writeFileSync(paths["COMPLETED.json"]'),
  "correctness finalizer live-source checks must bracket all derivation and precede COMPLETED");

const producerImmutable = { run_id: "producer-fixture", side: "baseline", created_at: "2026-08-06T00:00:00.000Z" };
const producerArtifact = { path: "raw/route-manifests/evidence.json", sha256: "a".repeat(64), size_bytes: 1 };
const producerResult = {
  schema_version: 1, run_id: producerImmutable.run_id, producer_id: "route-manifests", side: "baseline",
  started_at: "2026-08-06T00:00:01.000Z", ended_at: "2026-08-06T00:00:02.000Z", exit_code: 0,
  cleanup: { status: "passed", evidence_paths: [producerArtifact.path] },
  observations: [{ check_id: "BND-01", outcome: "PASS", assertions: ["reviewed route manifest analysis passed"], evidence_paths: [producerArtifact.path] }],
  owned_artifacts: [producerArtifact],
};
assert.doesNotThrow(() => validateProducerResult(producerResult, { immutable: producerImmutable, producerId: "route-manifests" }));
assert.throws(() => validateProducerResult({ ...producerResult, producer_id: "generic-check" }, { immutable: producerImmutable, producerId: "generic-check" }), /outside the reviewed registry/);
assert.throws(() => validateProducerResult({ ...producerResult, observations: [{ ...producerResult.observations[0], check_id: "BND-02" }] }, { immutable: producerImmutable, producerId: "route-manifests" }), /producer observation is invalid/);
assert.throws(() => validateProducerResult({ ...producerResult, started_at: "2026-08-05T23:59:59.000Z" }, { immutable: producerImmutable, producerId: "route-manifests" }), /chronology/);

const routeRoot = join(temp, "route-contract"); const routeRaw = join(routeRoot, "raw", "cms-lifecycle"); mkdirs(routeRaw);
const routeImageId = `sha256:${"7".repeat(64)}`;
const routeFiles = new Map();
const writeRouteSample = (stem, cache, body = "stable response") => {
  const headersPath = `raw/cms-lifecycle/${stem}.headers`, bodyPath = `raw/cms-lifecycle/${stem}.body.html`;
  writeFileSync(join(routeRoot, ...headersPath.split("/")), `HTTP/1.1 200 OK\r\n${cache ? `X-Nextjs-Cache: ${cache}\r\n` : ""}ETag: \"stable\"\r\n\r\n`);
  writeFileSync(join(routeRoot, ...bodyPath.split("/")), body);
  routeFiles.set(headersPath, { path: headersPath, producer_id: "cms-lifecycle", check_ids: [] }); routeFiles.set(bodyPath, { path: bodyPath, producer_id: "cms-lifecycle", check_ids: [] });
};
writeRouteSample("binding-about-1", "MISS"); writeRouteSample("binding-about-2", "HIT");
for (const stem of ["binding-root", "binding-join", "binding-contact"]) writeRouteSample(stem, null, stem);
const stableBodySha = sha256File(join(routeRaw, "binding-about-2.body.html"));
const routeDocument = { schema_version: 1, side: "current", image_id: routeImageId, routes: {
  "/about": { samples: [{ phase: "miss", headers_path: "raw/cms-lifecycle/binding-about-1.headers", body_path: "raw/cms-lifecycle/binding-about-1.body.html" }, { phase: "hit", headers_path: "raw/cms-lifecycle/binding-about-2.headers", body_path: "raw/cms-lifecycle/binding-about-2.body.html" }], derived: { status: 200, next_cache: "HIT", etag: '"stable"', body_sha256: stableBodySha } },
  "/": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-root.headers", body_path: "raw/cms-lifecycle/binding-root.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
  "/join": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-join.headers", body_path: "raw/cms-lifecycle/binding-join.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
  "/contact": { samples: [{ phase: "request", headers_path: "raw/cms-lifecycle/binding-contact.headers", body_path: "raw/cms-lifecycle/binding-contact.body.html" }], derived: { status: 200, next_cache: "ABSENT", etag: null, body_sha256: null } },
} };
const routeEvidencePath = "raw/cms-lifecycle/route-response-evidence.json"; writeFileSync(join(routeRoot, ...routeEvidencePath.split("/")), `${JSON.stringify(routeDocument)}\n`);
routeFiles.set(routeEvidencePath, { path: routeEvidencePath, producer_id: "cms-lifecycle", check_ids: ["BND-02"] });
assert.deepEqual(verifyCorrectnessRouteEvidence(routeRoot, { side: "current", image: { id: routeImageId } }, routeFiles).routes, Object.fromEntries(Object.entries(routeDocument.routes).map(([route, value]) => [route, value.derived])));
writeFileSync(join(routeRaw, "binding-about-2.body.html"), "mutated response");
assert.throws(() => verifyCorrectnessRouteEvidence(routeRoot, { side: "current", image: { id: routeImageId } }, routeFiles), /stable MISS\/HIT pair/);

const stackRoot = join(temp, "stack-contract"); const stackFingerprint = "8".repeat(64); const postgresImage = `sha256:${"9".repeat(64)}`;
const writeStackStage = (stage, appContainerId) => {
  const directoryName = stage === "before" ? "inputs" : "postcondition-evidence"; const directory = join(stackRoot, directoryName); mkdirs(directory);
  const container = (service, containerId, selectedImage, containerPort, hostPort) => ({ schema_version: 1, service, container_id: containerId, image_id: selectedImage, compose_project: "tacbookings-measure", compose_service: service, network_mode: "tacbookings-measure_default", networks: { "tacbookings-measure_default": { NetworkID: "1".repeat(64), IPAddress: service === "app" ? "172.20.0.4" : "172.20.0.2" } }, ports: { [`${containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] } });
  const leaves = {
    "app-container-inspect.json": container("app", appContainerId, routeImageId, 3000, 3003),
    "postgres-container-inspect.json": container("postgres", "2".repeat(64), postgresImage, 5432, 5435),
    "postgres-server-version.json": { schema_version: 1, version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    "database-fingerprint.json": { schema_version: 1, logical_fingerprint: stackFingerprint },
  };
  for (const [name, value] of Object.entries(leaves)) writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  const bound = (name) => ({ path: `${directoryName}/${name}`, sha256: sha256File(join(directory, name)) });
  const aggregate = { schema_version: 1, stage, compose_project: "tacbookings-measure", image_id: routeImageId,
    app: { ...bound("app-container-inspect.json"), container_id: appContainerId },
    postgres: { ...bound("postgres-container-inspect.json"), container_id: "2".repeat(64), image_id: postgresImage },
    postgres_server: { ...bound("postgres-server-version.json"), version: "16.9", version_num: "160009", database: "tacbookings", user: "tac" },
    database: { ...bound("database-fingerprint.json"), logical_fingerprint: stackFingerprint }, verified: true, captured_at: stage === "before" ? "2026-08-06T00:00:00.000Z" : "2026-08-06T00:01:00.000Z" };
  const aggregateName = `stack-identity-${stage}.json`; writeFileSync(join(directory, aggregateName), `${JSON.stringify(aggregate)}\n`);
  return verifyStackIdentity(stackRoot, `${directoryName}/${aggregateName}`, { stage, imageId: routeImageId, composeProject: "tacbookings-measure", databaseFingerprint: stackFingerprint });
};
const stackBefore = writeStackStage("before", "3".repeat(64)); const stackAfter = writeStackStage("after", "4".repeat(64));
assert.equal(compareStackIdentities(stackBefore, stackAfter), true);
writeFileSync(join(stackRoot, "postcondition-evidence", "database-fingerprint.json"), '{"schema_version":1,"logical_fingerprint":"mutated"}\n');
assert.throws(() => verifyStackIdentity(stackRoot, "postcondition-evidence/stack-identity-after.json", { stage: "after", imageId: routeImageId, composeProject: "tacbookings-measure", databaseFingerprint: stackFingerprint }), /checksum/);

const runtimeIdentity = { schema_version: 1, app: { container_id: "a".repeat(64), image_id: `sha256:${"b".repeat(64)}` }, postgres: { container_id: "c".repeat(64), image_id: `sha256:${"d".repeat(64)}`, server_version: "16.9" }, verified: true };
const runtimePath = join(temp, "runtime-after.json"); writeFileSync(runtimePath, `${JSON.stringify(runtimeIdentity)}\n`);
const runtimeSha = sha256File(runtimePath);
assert.doesNotThrow(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: runtimeSha, expected: runtimeIdentity }));
assert.throws(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: "e".repeat(64), expected: runtimeIdentity }), /checksum/);
assert.throws(() => verifyPostFinalizationRuntimeIdentity(runtimePath, { claimedSha256: runtimeSha, expected: { ...runtimeIdentity, app: { ...runtimeIdentity.app, container_id: "f".repeat(64) } } }), /differs semantically/);

const aggregateSource = readFileSync(join(bin, "aggregate-pairs.mjs"), "utf8");
for (const contract of ["finalProfileExact", "observations.length === 4", "PRELIMINARY_ONLY", "OWNER_REVIEW_REQUIRED", "isFuturePathInside", "common_runtime_environment_hmac_sha256", "autonomous_progression_authorised: false", "verifyHarnessSourceBinding"]) assert.match(aggregateSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert((aggregateSource.match(/verifyOrchestration\(args\.orchestration\)/g) ?? []).length >= 2,
  "aggregate must reverify its live archive-backed harness source at process start and immediately before writing outputs");
assert.match(aggregateSource, /verifyAggregateCompletion\(completionPath\)/,
  "aggregate must verify its final output seal before reporting success");
const aggregateSealRoot = join(temp, "aggregate-seal");
mkdirs(aggregateSealRoot);
const aggregatePrefix = join(aggregateSealRoot, "result");
const aggregateJsonPath = `${aggregatePrefix}.json`;
const aggregateMarkdownPath = `${aggregatePrefix}.md`;
const aggregateManifestPath = `${aggregatePrefix}.output-manifest.sha256`;
const aggregateCompletionPath = `${aggregatePrefix}.COMPLETED.json`;
writeFileSync(aggregateJsonPath, `${JSON.stringify({ schema_version: 2, integrity: { measurement_profile: PROFILE_NONFINAL, final_profile_exact: false } })}\n`);
writeFileSync(aggregateMarkdownPath, "# Result\n");
const aggregateFiles = [aggregateJsonPath, aggregateMarkdownPath].map((path) => ({ path, bytes: statSync(path).size, sha256: sha256File(path) }));
writeFileSync(aggregateManifestPath, `${aggregateFiles.map((record) => `${record.sha256}  ${record.bytes}  ${record.path}`).join("\n")}\n`);
writeFileSync(aggregateCompletionPath, `${JSON.stringify({ schema_version: 2, status: "COMPLETE", completed_at: new Date().toISOString(), measurement_profile: PROFILE_NONFINAL, final_profile_exact: false, pre_timing_correctness_ready: true, phase2_checks_passed: true, live_harness_source_verified_at_start_and_before_completion: true, orchestration_output_manifest_sha256: "a".repeat(64), aggregate_output_manifest_sha256: sha256File(aggregateManifestPath), aggregate_files: aggregateFiles, artifact_count: aggregateFiles.length })}\n`);
assert.doesNotThrow(() => run("aggregate-pairs.mjs", ["--verify-completion", aggregateCompletionPath]));
const validAggregateCompletion = JSON.parse(readFileSync(aggregateCompletionPath, "utf8"));
writeFileSync(aggregateCompletionPath, `${JSON.stringify({ ...validAggregateCompletion, final_profile_exact: true })}\n`);
rejects("aggregate-pairs.mjs", ["--verify-completion", aggregateCompletionPath], /profile differs/);
writeFileSync(aggregateCompletionPath, `${JSON.stringify(validAggregateCompletion)}\n`);
writeFileSync(aggregateJsonPath, "{\"tampered\":true}\n");
rejects("aggregate-pairs.mjs", ["--verify-completion", aggregateCompletionPath], /differs from its final seal/);
writeFileSync(aggregateJsonPath, `${JSON.stringify({ schema_version: 2, integrity: { measurement_profile: PROFILE_NONFINAL, final_profile_exact: false } })}\n`);
const restoredAggregateFiles = [aggregateJsonPath, aggregateMarkdownPath].map((path) => ({ path, bytes: statSync(path).size, sha256: sha256File(path) }));
writeFileSync(aggregateManifestPath, `${restoredAggregateFiles.map((record) => `${record.sha256}  ${record.bytes}  ${record.path}`).join("\n")}\n${restoredAggregateFiles[0].sha256}  ${restoredAggregateFiles[0].bytes}  ${restoredAggregateFiles[0].path}\n`);
writeFileSync(aggregateCompletionPath, `${JSON.stringify({ ...validAggregateCompletion, aggregate_output_manifest_sha256: sha256File(aggregateManifestPath), aggregate_files: restoredAggregateFiles })}\n`);
rejects("aggregate-pairs.mjs", ["--verify-completion", aggregateCompletionPath], /exactly two final artifacts/);
const orchestrationSource = readFileSync(join(bin, "orchestrate-pairs.sh"), "utf8");
for (const contract of ["PAIR_COUNT:-4", "MAX_INTER_SIDE_GAP_SECONDS:-600", "MAX_INTER_PAIR_GAP_SECONDS:-600", "QUIET_MONITOR_INTERVAL_SECONDS:-10", "final-decision orchestration profile cannot weaken"]) assert.match(orchestrationSource, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

console.log("phase-2 self-test: all contract mutations were rejected");
