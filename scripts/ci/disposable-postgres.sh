# shellcheck shell=bash
# A disposable, loopback-only PostgreSQL cluster for Sekreton's sandbox checks.
#
# SOURCED, never executed: `source scripts/ci/disposable-postgres.sh`, then
# `start_disposable_postgres <label>`. It is the one home of the cluster start
# that `kept-change-realdb.sh` and `sekreton-migration-checks.sh` share
# (INV-SSOT): finding the server tools, dropping root, a fresh directory, a free
# high port, initdb, start, and the stop on exit.
#
# After it returns, the caller has:
#   pg_dir     the cluster's scratch directory (data/, init.log, postgres.log)
#   pg_port    the loopback port it listens on (55442-65535)
#   pg_runner  an array prefix for PostgreSQL client and server commands:
#              empty, or `runuser -u postgres --` when the caller is root
# and an EXIT trap that stops the cluster. The caller creates its own databases,
# e.g. `"${pg_runner[@]}" createdb -h 127.0.0.1 -p "$pg_port" -U postgres <name>`.
# The caller must run under `set -euo pipefail`, so any failed step stops it.

# Stops the cluster `start_disposable_postgres` started. Safe to call twice.
stop_disposable_postgres() {
  "${pg_runner[@]}" pg_ctl -D "$pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
}

start_disposable_postgres() {
  local label=$1

  # Distribution packages install server tools outside PATH (the major varies).
  local pg_bin
  for pg_bin in /usr/lib/postgresql/*/bin; do
    if [ -x "$pg_bin/initdb" ]; then
      export PATH="$pg_bin:$PATH"
      break
    fi
  done
  command -v initdb >/dev/null || { echo 'PostgreSQL must be installed by .sekreton/config.toml' >&2; exit 1; }

  mkdir -p /tmp/scratch
  pg_dir=$(mktemp -d "/tmp/scratch/$label.XXXXXX")
  # PostgreSQL refuses root even when the check runner itself is privileged.
  # Only the new disposable cluster belongs to the package's postgres account;
  # migrations and tests keep the caller's checkout and dependency permissions.
  pg_runner=()
  if [ "$(id -u)" -eq 0 ]; then
    chown postgres:postgres "$pg_dir"
    pg_runner=(runuser -u postgres --)
  fi
  trap stop_disposable_postgres EXIT

  # Realdb suite safety guards require loopback and port 55442+. Probe a high
  # port before launch; a collision still fails closed at pg_ctl.
  pg_port=$(node --input-type=module -e '
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
  "${pg_runner[@]}" initdb -D "$pg_dir/data" -U postgres --auth-local=trust --auth-host=trust > "$pg_dir/init.log"
  "${pg_runner[@]}" pg_ctl -D "$pg_dir/data" -l "$pg_dir/postgres.log" -o "-h 127.0.0.1 -p $pg_port -k $pg_dir" -w start
}
