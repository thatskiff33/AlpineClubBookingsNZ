#!/usr/bin/env bash
# Put the PostgreSQL client tools of a CI service container's own image first
# on PATH for the rest of the job (#5193).
#
# The runner image ships whatever PostgreSQL client its Ubuntu release packages,
# and that is not the service's major version: on ubuntu-26.04 a newer
# `pg_dump` writes statements the PostgreSQL 16 service refuses on restore
# (#5192). So `pg_dump` and `psql` become shims that run the tool from the very
# image the service runs, read from the container rather than restated here, on
# the host network so the service's published port is reachable as is.
#
#   bash scripts/ci/postgres-client-from-service.sh <service container id>
#
# Callers pass a connection URL and feed SQL through stdin or -c (#5374).
# Host file paths (-f file, \i, \copy to a file) and PGHOST, PGUSER,
# PGDATABASE and PGPORT do not reach the container, which sees only the
# environment variables the shim forwards below.
set -euo pipefail

container="${1:?usage: postgres-client-from-service.sh <service container id>}"
: "${RUNNER_TEMP:?RUNNER_TEMP is not set; this runs inside a GitHub Actions job}"
: "${GITHUB_PATH:?GITHUB_PATH is not set; this runs inside a GitHub Actions job}"

image="$(docker inspect --format '{{.Config.Image}}' "$container")"
if [ -z "$image" ]; then
  echo "Could not read the image of service container ${container}" >&2
  exit 1
fi

bin_dir="${RUNNER_TEMP}/postgres-client-bin"
mkdir -p "$bin_dir"
for tool in pg_dump psql; do
  # libpq reads the password and options from the environment as well as the
  # URL; the backup code passes PGPASSWORD that way, so the shim forwards them.
  # One line: the image-pin census (check-image-pins.mjs) reads this command.
  cat > "${bin_dir}/${tool}" <<SHIM
#!/usr/bin/env bash
exec docker run --rm -i --network host -e PGPASSWORD -e PGOPTIONS -e PGSSLMODE -e PGCONNECT_TIMEOUT -e PGAPPNAME --entrypoint ${tool} '${image}' "\$@"
SHIM
  chmod +x "${bin_dir}/${tool}"
done

echo "$bin_dir" >> "$GITHUB_PATH"
echo "PostgreSQL client tools from ${image}:"
"${bin_dir}/pg_dump" --version
"${bin_dir}/psql" --version
