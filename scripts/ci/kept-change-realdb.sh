#!/usr/bin/env bash
# Disposable, loopback-only PostgreSQL proof for #4324 and #3403 in Sekreton.
set -euo pipefail

# Distribution packages install server tools outside PATH (the major varies).
for pg_bin in /usr/lib/postgresql/*/bin; do
  if [ -x "$pg_bin/initdb" ]; then
    export PATH="$pg_bin:$PATH"
    break
  fi
done
command -v initdb >/dev/null || { echo 'PostgreSQL must be installed by .sekreton/config.toml' >&2; exit 1; }
mkdir -p /tmp/scratch
race_dir=$(mktemp -d /tmp/scratch/kept-change-realdb.XXXXXX)
# PostgreSQL refuses root even when the check runner itself is privileged.
# Only the new disposable cluster belongs to the package's postgres account;
# migrations and tests keep the caller's checkout and dependency permissions.
postgres_runner=()
if [ "$(id -u)" -eq 0 ]; then
  chown postgres:postgres "$race_dir"
  postgres_runner=(runuser -u postgres --)
fi
cleanup() {
  "${postgres_runner[@]}" pg_ctl -D "$race_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
# The suite safety guard requires loopback, port 55442+, and this DB marker.
# Probe a high port before launch; a collision still fails closed at pg_ctl.
race_port=$(node --input-type=module -e '
import net from "node:net";
import { randomInt } from "node:crypto";
for (let attempt = 0; attempt < 20; attempt++) {
  const port = randomInt(55442, 65536);
  const server = net.createServer();
  const free = await new Promise(resolve => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
  if (free) { console.log(port); process.exit(0); }
}
process.exit(1);
')
"${postgres_runner[@]}" initdb -D "$race_dir/data" -U postgres --auth-local=trust --auth-host=trust > "$race_dir/init.log"
"${postgres_runner[@]}" pg_ctl -D "$race_dir/data" -l "$race_dir/postgres.log" -o "-h 127.0.0.1 -p $race_port -k $race_dir" -w start
"${postgres_runner[@]}" createdb -h 127.0.0.1 -p "$race_port" -U postgres concurrency_race_1881
export DATABASE_URL="postgresql://postgres@127.0.0.1:$race_port/concurrency_race_1881"
export CONCURRENCY_RACE_DATABASE_URL="$DATABASE_URL"
export RUN_CONCURRENCY_RACE_TESTS=1
export TMPDIR=/tmp/scratch
export NODE_OPTIONS=--max-old-space-size=1800
pnpm run db:migrate
files=(
  src/lib/__tests__/kept-change-capture-record.realdb.test.ts
  src/lib/__tests__/superseded-ask-invoice-carry.realdb.test.ts
  src/lib/__tests__/additional-capture-receipt.realdb.test.ts
  src/lib/__tests__/primary-invoice-edit-race.realdb.test.ts
)
# An explicit report plus the existing validator rejects green describe.skip.
pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile="$race_dir/report.json" "${files[@]}"
node --input-type=module - "$race_dir/report.json" "${files[@]}" <<'JS'
import { readFileSync } from "node:fs";
import { unexercisedRealdbFiles } from "./scripts/ci/check-realdb-ran.mjs";
const [, , report, ...files] = process.argv;
const problems = unexercisedRealdbFiles(JSON.parse(readFileSync(report, "utf8")), files);
if (problems.length) throw new Error(problems.join("\n"));
console.log(`All ${files.length} kept-change and adjacent PostgreSQL suites ran with no skips.`);
JS
