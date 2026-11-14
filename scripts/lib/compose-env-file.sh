# shellcheck shell=bash
#
# The `.env` readers every deploy-path check shares (#4275, #4026; moved here from
# scripts/run-production-blue-green-deploy.sh by #4980).
#
# SOURCED, NEVER RUN. It defines functions and nothing else, so sourcing it has no
# side effect. Two callers source it:
#
# - scripts/run-production-blue-green-deploy.sh, for its wrapper and its engine;
# - scripts/check-environment-role.sh, First Bootstrap's role gate, through
#   scripts/lib/environment-role-check.sh.
#
# Living in its own file is what lets both reach the SAME grammar: sourcing the
# deploy script would start the production wrapper, so before #4980 nothing
# outside it could call these, and a second caller would have needed a copy.
#
# Requires bash (it uses `local` and substring expansion).

# ---------------------------------------------------------------------------
# Readers shared by the wrapper and the engine (#4275)
# ---------------------------------------------------------------------------
#
# Every other deploy helper is defined inside `run_production_wrapper` or
# `run_internal_blue_green_deploy`, so it exists only in the process that runs
# that function — and the two run in different processes (the wrapper re-enters
# the deploy script with `--internal-blue-green-deploy`). These are the readers both
# halves need, so they are defined once, at file level, rather than twice in two
# grammars that drift apart: the wrapper's first image-repository reader kept
# quotes, missed `export KEY=` and took the FIRST duplicate, while Compose
# unquotes, honours `export` and takes the LAST.

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# A deployment-supplied value made safe to echo at an operator's terminal.
#
# The application deliberately reduces this same string to printable ASCII before
# it reaches a log line or a page (`sanitizeEnvironmentRoleRawValue` in
# src/lib/environment-role-declaration.ts), for the plain reason that a value
# holding a newline or an escape sequence must not be able to write a second line
# into — or repaint — the terminal of the person reading the refusal. A shell that
# echoed the raw value would be the hole that module closes, reopened one layer
# out. Control characters become `?` rather than being deleted, so the operator
# can SEE that something is in there; the cap matches the app's 64 characters
# including the `...` marker, so the whole result is printable ASCII.
printable_deploy_value() {
  local sanitized

  sanitized="$(printf '%s' "$1" | tr -c ' -~' '?')"
  if [ "${#sanitized}" -gt 64 ]; then
    printf '%s...' "${sanitized:0:61}"
  else
    printf '%s' "$sanitized"
  fi
}

# Every shape Docker Compose's `.env` parser accepts as an assignment of any of
# the given keys, as one extended regular expression (#4026).
#
#   env_assignment_pattern KEY [KEY...]
#
# THE ONE SPELLING OF THIS GRAMMAR. Every deploy-path reader that must agree
# with Compose about whether a line assigns a key builds its pattern here, in
# the deploy wrapper, the deploy engine and First Bootstrap's role gate alike.
# A downstream fork's own deploy guard sources this file rather than keeping a
# hand-made copy pinned equal by a test of its own.
#
# THE SHAPE WAS THE FINDING, twice. The first version of the #3034 check counted
# with `awk -F=` and `$1 == key`, which needs the key to be the WHOLE first
# `=`-field — so three shapes Compose honours slipped past it, measured against
# real `docker compose v5.3.1`: an INDENTED line, an `export `-prefixed line, and
# spaces around the `=`. Then #4026 measured `docker compose config` on Compose
# v5.6.0 and found its parser also takes a YAML-style COLON as the separator:
# `KEY: value`, `KEY:value`, `KEY : value` and `export KEY: value`. Any of those
# appearing a SECOND time further down a .env whose first line is correct passed
# the duplicate check and handed every container the second value. Appending to a
# .env by hand, or from a rehearsal script, produces exactly those shapes.
#
# What it matches, mirroring Compose's dotenv parser: optional leading
# whitespace; an optional `export` followed by whitespace; the key exactly; then
# optional whitespace and an `=` or a `:`. A comment line cannot match, because a
# `#` before the key fails the anchor, and a longer name sharing the prefix
# (`KEY_EXTRA=`) cannot either, because only whitespace may sit between the key
# and its separator.
#
# CAPTURE GROUPS ARE FIXED so a `sed -E` caller can append its own value group:
# group 1 is the `export` prefix, group 2 is the key that matched, and a caller's
# first group after the pattern is `\3`. The keys are literal environment-variable
# names from the deploy scripts ([A-Za-z_][A-Za-z0-9_]*); none of them holds a regex or
# `sed` delimiter character, and a name that did would be refused below rather
# than silently matching something else.
env_assignment_pattern() {
  local alternation=""
  local key

  for key in "$@"; do
    case "$key" in
      '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
        echo "env_assignment_pattern: not a plain variable name: $(printable_deploy_value "$key")" >&2
        return 1
        ;;
    esac
    alternation="${alternation:+$alternation|}$key"
  done
  if [ -z "$alternation" ]; then
    echo "env_assignment_pattern: needs at least one key" >&2
    return 1
  fi

  printf '^[[:space:]]*(export[[:space:]]+)?(%s)[[:space:]]*[=:]' "$alternation"
}

# One layer of matching surrounding quotes, removed (#4275: shared by the `.env`
# reader below and the deploy script's rendered-Compose readers, which meet the same
# quoting from two directions). Compose's dotenv parser unquotes `KEY="value"`,
# and `docker compose config` writes a string that YAML would otherwise read as
# a boolean, a number or nothing back WITH quotes (`USE_AWS_SES: "true"`,
# `EMAIL_SERVER_HOST: ""`). Compared character by character rather than by a
# `case` pattern, because a pattern holding both quote characters inside a
# single-quoted shell word is unreadable and easy to get subtly wrong.
strip_matching_quotes() {
  local value="$1"
  local first
  local last

  if [ "${#value}" -ge 2 ]; then
    first="${value%"${value#?}"}"
    last="${value#"${value%?}"}"
    if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then
      value="${value#?}"
      value="${value%?}"
    fi
  fi

  printf '%s' "$value"
}

# The value Compose would resolve for this key from an env file (#3034; shared
# since #4027 by every reader that must agree with the containers).
#
#   compose_env_file_value KEY [FILE]
#
# FILE defaults to `.env` in the working directory, which is the engine's
# project `.env`. The wrapper passes the SOURCE repository's `.env` (#4275), so
# the image-repository settings it reads there follow the same grammar as every
# value Compose hands a container, rather than a second reader's.
#
# LAST-WINS, matching Compose dotenv parsing rather than the first-match reader
# used for every other `require_*_env_key`. A duplicate is refused before this matters, but if
# that refusal is ever relaxed this reader agrees with the containers instead of
# disagreeing with them, which is the safer default of the two.
#
# It then undoes what Compose undoes: an `export ` prefix, whitespace around the
# `=` or `:`, an inline comment (the same `[[:space:]]+#` rule `get_env_file_value`
# applies for every other key), and ONE layer of matching surrounding quotes.
# Those last three are why `APP_ENVIRONMENT_ROLE = production`,
# `export APP_ENVIRONMENT_ROLE=production` and `APP_ENVIRONMENT_ROLE="production"`
# no longer abort a deploy Compose would have resolved to `production` — and in
# particular why the first two are no longer reported as a MISSING entry for a key
# plainly present in the file, which is what gets an operator editing the wrong
# line under deploy pressure.
#
# One place it stays narrower than Compose: a `#` INSIDE a quoted value is treated
# as an inline comment and truncated. That can only shorten a value, so it can only
# turn an accepted value into a refused one — never the reverse — and the refusal
# names the sanitized value it read.
compose_env_file_value() {
  local key="$1"
  local file="${2:-.env}"
  local pattern
  local value

  pattern="$(env_assignment_pattern "$key")" || return 1
  value="$(
    sed -nE "s/${pattern}[[:space:]]*(.*)$/\3/p" "$file" |
      tail -n 1
  )"
  value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
  strip_matching_quotes "$(trim_whitespace "$value")"
}
