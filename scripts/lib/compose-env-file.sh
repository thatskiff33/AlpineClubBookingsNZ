# shellcheck shell=bash
# Exports every KEY=VALUE in a compose-style env file into the calling shell.
# Sourced by scripts/e2e-stack.sh and scripts/load-stack.sh, so both stacks
# read their env file the same way.
#
# Not `source`: values may contain spaces (e.g. cron schedules), and unquoted
# values may carry trailing "  # comment" annotations. A key given twice takes
# its LAST value, as Compose's own --env-file does.
read_compose_env_file() {
  local line key value
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    value="${value%%[[:space:]]\#*}" # strip inline comment
    value="${value%"${value##*[![:space:]]}"}" # trim trailing whitespace
    export "$key=$value"
  done < "$1"
}
