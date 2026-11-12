#!/usr/bin/env bash
# Sekreton's pre-ship migration gate: the sandbox's parity with the required
# CI checks `Migration drift check` (its drift step) and `Data migration
# verification` (its two migration proofs), so a task's pull request does not
# reach CI with a migration nobody checked.
#
# 1. Always: the read-only data-migration verification coverage gate.
# 2. The rest runs only when the change since origin/main touches what CI's
#    own skip list says can move these jobs (`CHANGE_SCOPES.migrations` in
#    scripts/ci/change-scope.mjs, read here rather than copied: INV-SSOT). Any
#    failure to list or classify the change runs everything (fail closed).
# 3. On a disposable loopback cluster (scripts/ci/disposable-postgres.sh):
#    `pnpm run db:check-drift` against a main and a shadow database, then each
#    data-migration realdb suite in its own `vitest run`, as CI does, and a
#    check that every suite really ran with no skips (check-realdb-ran.mjs).
#
# SEKRETON_MIGRATION_CHECKS_FORCE=1 forces step 3 whatever the change (used to
# test this script on a branch that changes no migration).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

bash scripts/check-data-migration-verification.sh

# Skip only on an explicit, well-formed "not needed" answer; an error, a
# missing origin/main or any other output runs the full checks.
base_ref=origin/main
scope_answer=""
if [ "${SEKRETON_MIGRATION_CHECKS_FORCE:-}" = "1" ]; then
  echo "SEKRETON_MIGRATION_CHECKS_FORCE=1: running the full migration checks."
elif scope_answer=$(node --input-type=module - "$base_ref" <<'JS'
import { gitDiffChangedFiles, parseNameStatus } from "./scripts/ci/pr-body.mjs";
import { CHANGE_SCOPES, touchesAny } from "./scripts/ci/change-scope.mjs";
const [, , base] = process.argv;
const scope = CHANGE_SCOPES.migrations;
const files = parseNameStatus(gitDiffChangedFiles(base, "HEAD")).map((record) => record.path);
const { needed, reason } = touchesAny(files, scope.triggers, scope.subject);
console.error(`Migration scope against ${base}: ${reason}`);
console.log(needed ? "migration-scope=needed" : "migration-scope=not-needed");
JS
); then
  if [ "$scope_answer" = "migration-scope=not-needed" ]; then
    echo "Nothing this change touches can move the migration checks; drift and data-migration suites skipped (coverage gate above ran)."
    exit 0
  fi
else
  echo "Could not classify the change against $base_ref; running the full migration checks." >&2
fi

# shellcheck source=scripts/ci/disposable-postgres.sh
source scripts/ci/disposable-postgres.sh
start_disposable_postgres sekreton-migration-checks
for db in drift_main drift_shadow data_migration_verification; do
  "${pg_runner[@]}" createdb -h 127.0.0.1 -p "$pg_port" -U postgres "$db"
done
export TMPDIR=/tmp/scratch
export NODE_OPTIONS=--max-old-space-size=1800

# Prisma replays prisma/migrations into the shadow database (which must already
# exist) and diffs the result against schema.prisma, as CI's drift step does.
DATABASE_URL="postgresql://postgres@127.0.0.1:$pg_port/drift_main" \
SHADOW_DATABASE_URL="postgresql://postgres@127.0.0.1:$pg_port/drift_shadow" \
  pnpm run db:check-drift

# The suites create and drop their own scratch databases from this one.
export DATABASE_URL="postgresql://postgres@127.0.0.1:$pg_port/data_migration_verification"
export DATA_MIGRATION_VERIFICATION_DATABASE_URL="$DATABASE_URL"
files=(
  src/lib/__tests__/data-migration-verification.realdb.test.ts
  src/lib/__tests__/school-organisation-backfill-fail-closed.realdb.test.ts
)
# One path per `vitest run`, as CI does: a multi-path run silently drops a path
# that matches nothing. Each report is then checked for skips.
index=0
for file in "${files[@]}"; do
  index=$((index + 1))
  pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json \
    --outputFile="$pg_dir/report-$index.json" "$file"
  node --input-type=module - "$pg_dir/report-$index.json" "$file" <<'JS'
import { readFileSync } from "node:fs";
import { unexercisedRealdbFiles } from "./scripts/ci/check-realdb-ran.mjs";
const [, , report, ...files] = process.argv;
const problems = unexercisedRealdbFiles(JSON.parse(readFileSync(report, "utf8")), files);
if (problems.length) throw new Error(problems.join("\n"));
console.log(`${files[0]} ran against PostgreSQL with no skips.`);
JS
done
echo "Migration drift and data-migration verification passed."
