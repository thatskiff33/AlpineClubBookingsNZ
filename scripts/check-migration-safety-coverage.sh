#!/usr/bin/env bash
#
# PR-time coverage gate for blue/green migration safety (issue #1359 / audit F8).
#
# The deploy-time validator (scripts/validate-blue-green-migrations.sh) only
# inspects migrations that are still PENDING against a target database. A
# regex-matching migration committed without a ledger entry therefore stays
# invisible until a production/fork deploy hits the gate and aborts before
# cutover. This script closes that gap by asserting, at PR time, five things:
#
#   1. Ledger well-formedness: EVERY row in the ledger names a migration exactly
#      once and declares old_code_compatible from the closed vocabulary
#      (yes/no/windowed). Checked over the whole file rather than only the rows
#      the coverage sweep below reaches, because 73 of the 174 committed rows are
#      for migrations whose SQL matches no validator regex — their fourth column
#      used to be validated by nothing, so a near-miss spelling of `windowed`
#      disarmed the declaration silently (#2288).
#   2. Ledger coverage: every committed migration at or after the ledger
#      baseline whose SQL matches the validator's hot-table/breaking regexes
#      carries a well-formed docs/BLUE_GREEN_MIGRATION_SAFETY.tsv entry.
#   3. Timestamp hygiene: no two migrations share a timestamp prefix, so a new
#      migration can never sort ambiguously against an existing one. The
#      historical duplicate prefixes that predate this gate are grandfathered.
#   4. Same-release expand/contract (#3002): a migration this branch ADDS may not
#      be phase=contract while the migration its `previous_expand_release` names
#      is added on this branch too. That is an expand and its own contract in one
#      deploy, and since #3002 an epic reaches `main` as ONE merge, so an epic's
#      whole set of migrations lands in a single deploy. A contract release's
#      definition is that the previous runtime no longer depends on what is being
#      removed, and `previous_expand_release` has to name a migration that has
#      actually DRAINED; inside one deploy nothing has. Until now that was prose
#      in docs/BLUE_GREEN_MIGRATION_POLICY.md, and prose rules in this repository
#      have a measured failure rate — #2691 exists because four consecutive pull
#      requests re-fixed a rule that was already written down correctly, in the
#      right place, in strong language. This check is mechanical instead, and it
#      catches the same defect on an ordinary pull request as on an epic branch.
#      An acknowledgement (the escape hatch below) is available only to a row
#      declaring old_code_compatible=windowed, which is what makes the policy's
#      "and the pre-existing coverage check then still demands its rollback.sql"
#      true: that demand fires on `windowed` and on nothing else.
#   5. previous_expand_release names a migration THAT EXISTS. Check 4 matches
#      that value against directory names, and nothing else validated it — the
#      deploy validator only requires it to be non-empty and not `n/a`. So one
#      dropped word in a hand-typed 40-to-60 character name matched nothing,
#      check 4 found no pair, and the gate passed over exactly the case it
#      exists to catch.
#
# Check 4 is the only one that reads git. It compares against a BASE REF, and it
# FAILS rather than passing when it cannot read that comparison — an unresolvable
# ref, or a shallow clone that would narrow the diff silently. That is the rule
# `npm run pr:check` and the file-size ratchet already follow.
#
# Checks 1-3 and 5 are read-only and need no database or git — the script still
# runs as an early fail-fast step in CI's migration-drift job, and check 5 is
# live on a developer machine where check 4 skips.
#
# Arguments:
#   --base <ref> | --base=<ref>   base ref for check 4 (default origin/main),
#                                 matching scripts/ci/check-file-size-budget.ts.
#                                 PASS IT EXPLICITLY ON A `push` EVENT: there
#                                 `origin/main` IS the commit being tested, the
#                                 merge base is HEAD, and the added-migration set
#                                 is empty whatever the tree holds. ci.yml's
#                                 `File-size budget ratchet` step carries the
#                                 same reasoning at length.
#
# Overridable via environment (used by the contract tests):
#   MIGRATIONS_DIR             directory of migration folders (default prisma/migrations)
#   MIGRATION_SAFETY_LEDGER    ledger TSV path (default docs/BLUE_GREEN_MIGRATION_SAFETY.tsv)
#   MIGRATION_SAFETY_BASE_REF  base ref for check 4, when passing --base is awkward
set -Eeuo pipefail

# Deterministic, locale-independent string comparison for timestamp ordering.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Recorded BEFORE the default is applied. Check 4 needs to tell a real committed
# migration tree from a purpose-built fixture: a fixture directory under
# os.tmpdir() is in no git work tree, so "added on this branch" is not a question
# that can be asked of it, while the committed tree is always inside one.
if [ -n "${MIGRATIONS_DIR:-}" ]; then
  MIGRATIONS_DIR_OVERRIDDEN=1
else
  MIGRATIONS_DIR_OVERRIDDEN=0
fi
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${REPO_ROOT}/prisma/migrations}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-${REPO_ROOT}/docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"
VALIDATOR="${VALIDATOR:-${REPO_ROOT}/scripts/validate-blue-green-migrations.sh}"
BASE_REF="${MIGRATION_SAFETY_BASE_REF:-origin/main}"

# `--base <ref>` and `--base=<ref>`, the shape scripts/ci/check-file-size-budget.ts
# already uses. An unrecognised argument is refused rather than ignored: a typo in
# a workflow step must not read as "run with the default".
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      shift
      if [ "$#" -eq 0 ] || [ -z "$1" ]; then
        echo "check-migration-safety-coverage: --base needs a ref" >&2
        exit 1
      fi
      BASE_REF="$1"
      ;;
    --base=*)
      BASE_REF="${1#--base=}"
      if [ -z "$BASE_REF" ]; then
        echo "check-migration-safety-coverage: --base= needs a ref" >&2
        exit 1
      fi
      ;;
    *)
      echo "check-migration-safety-coverage: unrecognised argument ${1}" >&2
      echo "Usage: check-migration-safety-coverage.sh [--base <ref>]" >&2
      exit 1
      ;;
  esac
  shift
done

# The escape hatch for check 4, and deliberately a loud one. An owner may choose a
# ONE-RELEASE drop behind a maintenance window instead of a two-release retirement
# — docs/BLUE_GREEN_MIGRATION_POLICY.md records 20260803010000 and 20260803030000
# as exactly that shape — and a gate with no way to say so gets deleted rather
# than satisfied. Saying so lives in the contract row's own lock_impact_plan,
# beside the window it describes, so the justification cannot drift away from the
# row it excuses. A bare marker is not an acknowledgement: a reason has to follow.
SAME_RELEASE_ACK_MARKER="SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED:"
SAME_RELEASE_ACK_MIN_REASON_CHARS=40

# Timestamp prefixes shared by more than one migration on main before this gate
# existed. New migrations must not reuse a prefix; these are grandfathered so the
# ratchet passes on the current history while blocking any future collision.
GRANDFATHERED_DUPLICATE_PREFIXES=(
  20260408060000
  20260527090000
  20260613090000
  20260626120000
  20260628120000
  20260702100000
  20260704150000
)

failures=0

# ---------------------------------------------------------------------------
# Exact-line membership, WITHOUT a pipeline.
# ---------------------------------------------------------------------------
# Two checks below ask "is this name one of these names", and both used to ask
# it as `printf '%s\n' "$list" | grep -Fxq -- "$name"`. That construct returns
# the WRONG ANSWER, in the direction that reads as "absent", for reasons that
# have nothing to do with the strings:
#
#   `grep -q` exits at its FIRST match and closes the read end of the pipe. If
#   the writer has not finished by then - which happens whenever the payload
#   does not fit in the pipe's buffer - its next write gets EPIPE, `printf` dies
#   with status 141, and `set -o pipefail` then makes the surrounding `if` FALSE
#   even though the line was found. Measured on debian:bookworm-slim: a 38 KB
#   payload answers FOUND, a 208 KB payload answers `NOT FOUND (status 141)` for
#   a needle on its FIRST line. Nothing about the needle changed.
#
# So the answer depended on the payload's size against the pipe's capacity - and
# a pipe's capacity is not a constant either: Linux hands out single-page (4 KB)
# pipes once a user is over fs.pipe-user-pages-soft, which a full parallel test
# run can reach. That is how the same committed tree passed on a developer
# machine and failed in CI, printing "no such directory X" while listing X two
# lines later in the same message - the self-contradiction was the tell (#3036).
#
# In check 4 the same shape fails in the QUIETER and more dangerous direction:
# `is_added_on_this_branch` returning a false "no" makes the same-release
# expand/contract check `continue` past a real pair and report a pass - the exact
# silent-pass failure mode check 5 exists to prevent.
#
# Pure bash `case` has no writer, no reader, and no exit status to lose. The
# needle is quoted inside the pattern so it is matched literally, and the newline
# padding keeps it a whole-LINE match exactly as `grep -Fx` did. Any new
# membership test in these gates must use this helper. The guard is in
# scripts/__tests__/same-release-expand-contract.test.ts, which fails both a
# reintroduced `printf | grep -q` and a helper that has lost its newline padding
# (whole-line match degraded to substring).
list_contains_line() {
  # $1 = the exact line to look for, $2 = the newline-separated candidates.
  [ -n "${1:-}" ] || return 1
  local haystack
  haystack=$'\n'"${2:-}"$'\n'
  case "$haystack" in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  return 1
}

if [ ! -f "$MIGRATION_SAFETY_LEDGER" ]; then
  echo "check-migration-safety-coverage: ledger not found at ${MIGRATION_SAFETY_LEDGER}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Ledger well-formedness: closed vocabulary, no duplicate migration names.
# ---------------------------------------------------------------------------
# Delegated to the validator with NO migration arguments: its single ledger pass
# runs before the (then empty) migration loop, so this lints every row in the file
# and there is exactly one definition of the vocabulary rather than a second copy
# of the awk here to drift out of step. It runs unconditionally — before the
# coverage sweep, which only reads rows for in-scope migrations, and independently
# of whether any migration is in scope at all.
ledger_lint_err="$(mktemp)"
if ! MIGRATION_SAFETY_LEDGER="$MIGRATION_SAFETY_LEDGER" \
     ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=0 \
     BLUE_GREEN_MIGRATION_OVERRIDE_REASON="" \
     bash "$VALIDATOR" >/dev/null 2>"$ledger_lint_err"; then
  echo "Ledger well-formedness check FAILED: ${MIGRATION_SAFETY_LEDGER} has a malformed row." >&2
  echo "old_code_compatible must be exactly yes, no, or windowed, and each migration may appear once (see docs/BLUE_GREEN_MIGRATION_POLICY.md)." >&2
  # Drop the validator's own pending-migration trailer: no migration was passed.
  grep -v '^Pending migrations ' "$ledger_lint_err" >&2 || true
  failures=1
else
  ledger_row_count="$(
    awk -F'\t' '/^[[:space:]]*#/ { next } NF == 0 { next } { rows++ } END { print rows + 0 }' \
      "$MIGRATION_SAFETY_LEDGER"
  )"
  echo "Ledger well-formedness check passed for ${ledger_row_count} row(s)." >&2
fi
rm -f "$ledger_lint_err"

# ---------------------------------------------------------------------------
# 2. Ledger coverage for every migration at or after the ledger baseline.
# ---------------------------------------------------------------------------

# Baseline = the first data row's migration name. Migrations older than the
# baseline predate the ledger (documented as grandfathered historical
# migrations in docs/BLUE_GREEN_MIGRATION_POLICY.md) and are out of scope.
baseline_migration="$(
  awk -F'\t' '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    { print $1; exit }
  ' "$MIGRATION_SAFETY_LEDGER"
)"

if [ -z "$baseline_migration" ]; then
  echo "check-migration-safety-coverage: ledger ${MIGRATION_SAFETY_LEDGER} has no data rows" >&2
  exit 1
fi

covered_sql_files=()
while IFS= read -r migration_dir; do
  [ -n "$migration_dir" ] || continue
  migration_name="$(basename "$migration_dir")"
  # Skip anything older than the baseline (string compare is safe: names begin
  # with a zero-padded timestamp and LC_ALL=C makes it a byte comparison).
  if [[ "$migration_name" < "$baseline_migration" ]]; then
    continue
  fi
  sql_file="${migration_dir}/migration.sql"
  [ -f "$sql_file" ] && covered_sql_files+=("$sql_file")
done < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#covered_sql_files[@]}" -eq 0 ]; then
  echo "check-migration-safety-coverage: no migrations at or after baseline ${baseline_migration}" >&2
else
  # Run the deploy validator over every in-scope migration. The breaking-SQL
  # gate is a deploy-time authorization concern, not a coverage concern, so we
  # neutralise it here — documented contract migrations legitimately contain
  # breaking SQL. What must hold at PR time is that each matching migration has
  # a well-formed ledger entry, i.e. the validator does not report a missing or
  # malformed entry (its found_failure path).
  coverage_err="$(mktemp)"
  if ! MIGRATION_SAFETY_LEDGER="$MIGRATION_SAFETY_LEDGER" \
       ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
       BLUE_GREEN_MIGRATION_OVERRIDE_REASON="PR-time ledger-coverage check (documentation gate, not a deploy)" \
       BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 \
       bash "$VALIDATOR" "${covered_sql_files[@]}" >/dev/null 2>"$coverage_err"; then
    echo "Ledger coverage check FAILED: a migration matches the blue/green safety regexes but has no valid ${MIGRATION_SAFETY_LEDGER} entry." >&2
    echo "Add a ledger row (see docs/BLUE_GREEN_MIGRATION_POLICY.md) before merging." >&2
    grep -E 'missing|must |duplicate' "$coverage_err" >&2 || true
    failures=1
  else
    echo "Ledger coverage check passed for ${#covered_sql_files[@]} migration(s) at or after ${baseline_migration}." >&2
  fi
  rm -f "$coverage_err"
fi

# ---------------------------------------------------------------------------
# 3. Timestamp-prefix uniqueness ratchet (grandfathering known duplicates).
# ---------------------------------------------------------------------------
is_grandfathered() {
  local prefix="$1"
  local allowed
  for allowed in "${GRANDFATHERED_DUPLICATE_PREFIXES[@]}"; do
    [ "$prefix" = "$allowed" ] && return 0
  done
  return 1
}

duplicate_prefixes="$(
  for migration_dir in "$MIGRATIONS_DIR"/*/; do
    [ -d "$migration_dir" ] || continue
    name="$(basename "$migration_dir")"
    printf '%s\n' "${name%%_*}"
  done | sort | uniq -d
)"

if [ -n "$duplicate_prefixes" ]; then
  while IFS= read -r prefix; do
    [ -n "$prefix" ] || continue
    if is_grandfathered "$prefix"; then
      continue
    fi
    echo "Timestamp hygiene check FAILED: migration timestamp prefix ${prefix} is used by more than one migration." >&2
    echo "A new migration's timestamp must exceed every committed migration's (see docs/BLUE_GREEN_MIGRATION_POLICY.md)." >&2
    failures=1
  done <<<"$duplicate_prefixes"
fi

# ---------------------------------------------------------------------------
# 4. An expand and its own contract must not land in one deploy (#3002).
# ---------------------------------------------------------------------------
# The only check here that reads git, because "added on this branch" is a
# question only git can answer.

same_release_base_failure() {
  echo "Same-release expand/contract check FAILED: ${1}" >&2
  echo "  This check compares the migrations THIS BRANCH adds against a base ref, so it" >&2
  echo "  cannot run without one - and it fails rather than passing, because a gate that" >&2
  echo "  cannot read its comparison must not report a green it has not earned. That is" >&2
  echo "  the rule npm run pr:check and the file-size ratchet already follow." >&2
  echo "  Fix with:  ${2:-git fetch origin ${BASE_REF#origin/}}" >&2
  echo "             or pass --base <ref>, or set MIGRATION_SAFETY_BASE_REF=<ref>" >&2
  failures=1
}

# The work tree holding the migrations directory, or empty when there is none.
migrations_git_root=""
if ! migrations_git_root="$(cd "$MIGRATIONS_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"; then
  migrations_git_root=""
fi

if [ -z "$migrations_git_root" ]; then
  if [ "$MIGRATIONS_DIR_OVERRIDDEN" = "1" ]; then
    # A purpose-built fixture tree. It belongs to no branch, so there is nothing
    # for this check to be about, and saying so beats inventing an answer.
    echo "Same-release expand/contract check SKIPPED: MIGRATIONS_DIR (${MIGRATIONS_DIR}) is in no git work tree, so it has no branch to read 'added on this branch' from." >&2
  elif [ -n "${CI:-}" ]; then
    same_release_base_failure "prisma/migrations is in no git work tree that this shell's git can read." "run this from a git checkout, with a git the shell can use"
  else
    # Measured, and the reason this is a notice rather than a failure on a
    # developer machine: on Windows, `bash` is whatever PATH resolves, and on a
    # stock Windows 11 box that is C:\Windows\System32\bash.exe - the WSL
    # launcher. WSL's git cannot open a git WORKTREE on /mnt/c at all, because
    # the worktree's `.git` file holds a Windows-style `gitdir: C:/...` path that
    # WSL then resolves relative to the current directory:
    #   fatal: not a git repository: /mnt/c/.../wt-3002/C:/.../worktrees/wt-3002
    # Every lane in this repository works inside a worktree, so failing here
    # would red-light every Windows lane while CI stayed green - the exact
    # false-red class docs/agents/CODEX_WORKFLOW.md and AGENTS.md warn about.
    # CI is Linux and has a real work tree, so the check is live where it counts,
    # and it fails closed there (the branch above).
    echo "Same-release expand/contract check SKIPPED: this shell's git cannot read a work tree at ${MIGRATIONS_DIR}." >&2
    echo "  On Windows a WSL bash cannot open a git worktree on /mnt/c; CI runs this check for real." >&2
    echo "  To run it here, use a git-aware shell (Git Bash) rather than WSL bash." >&2
  fi
else
  # A shallow clone does NOT fail the resolution below. It resolves the ref and
  # hands back HEAD as the merge base, so the added-migration set comes back
  # empty and the check reports a pass over a tree that may hold the very pair it
  # exists to catch. ci.yml records the same trap for the file-size ratchet. A
  # truncated history is therefore refused outright.
  is_shallow="$(git -C "$migrations_git_root" rev-parse --is-shallow-repository 2>/dev/null || echo unknown)"
  base_tip=""
  base_sha=""
  if [ "$is_shallow" != "false" ]; then
    same_release_base_failure "this is a shallow clone (git rev-parse --is-shallow-repository = ${is_shallow}), and a truncated history narrows the diff silently instead of erroring." "git fetch --unshallow, or actions/checkout with fetch-depth: 0 in the workflow job"
  elif [ "$BASE_REF" = "0000000000000000000000000000000000000000" ]; then
    # How a push event says the ref did not exist before this push. There is no
    # "before" to measure against, so there is nothing to report a pass on.
    same_release_base_failure "the base is the all-zero object id, which is how a push event says the ref did not exist before the push." "re-run with --base naming a commit this history really contains"
  elif ! base_tip="$(git -C "$migrations_git_root" rev-parse --verify --quiet "${BASE_REF}^{commit}" 2>/dev/null)" || [ -z "$base_tip" ]; then
    same_release_base_failure "the base ref ${BASE_REF} does not resolve to a commit in this checkout."
  elif ! base_sha="$(git -C "$migrations_git_root" merge-base "$base_tip" HEAD 2>/dev/null)" || [ -z "$base_sha" ]; then
    same_release_base_failure "${BASE_REF} resolves to ${base_tip}, but this checkout shares no commit with it, so there is no point to measure 'before' from." "git fetch --unshallow origin, or git fetch origin ${BASE_REF#origin/}"
  else
    # The migrations directory as git names it, e.g. `prisma/migrations/`. Empty
    # when the migrations directory IS the top of the work tree.
    migrations_prefix="$(cd "$MIGRATIONS_DIR" && git rev-parse --show-prefix)"

    # A migration counts as added on this branch when its own migration.sql is
    # added: a pre-existing migration that merely gains a rollback.sql here is
    # not new, and must not read as new. --no-renames so a folder renamed into
    # existence on this branch reads as an addition (it lands in this deploy
    # either way) rather than as a rename git pairs off and reports as neither.
    # Untracked files are included so a local run catches the pair before the
    # commit that would carry it.
    added_paths="$(
      {
        if [ -n "$migrations_prefix" ]; then
          git -C "$migrations_git_root" diff --name-only --diff-filter=A --no-renames "$base_sha" -- "$migrations_prefix" 2>/dev/null || true
          git -C "$migrations_git_root" ls-files --others --exclude-standard -- "$migrations_prefix" 2>/dev/null || true
        else
          git -C "$migrations_git_root" diff --name-only --diff-filter=A --no-renames "$base_sha" 2>/dev/null || true
          git -C "$migrations_git_root" ls-files --others --exclude-standard 2>/dev/null || true
        fi
      } | sort -u
    )"

    added_migrations="$(
      printf '%s\n' "$added_paths" | awk -v prefix="$migrations_prefix" '
        $0 == "" { next }
        {
          rest = $0
          if (prefix != "") {
            if (index($0, prefix) != 1) { next }
            rest = substr($0, length(prefix) + 1)
          }
          slash = index(rest, "/")
          if (slash == 0) { next }
          if (substr(rest, slash + 1) != "migration.sql") { next }
          print substr(rest, 1, slash - 1)
        }
      ' | sort -u
    )"

    added_count="$(printf '%s\n' "$added_migrations" | grep -c '[^[:space:]]' || true)"

    if [ "$base_sha" = "$(git -C "$migrations_git_root" rev-parse HEAD)" ]; then
      # Not a failure: a branch with no commits of its own genuinely adds nothing.
      # It IS worth saying, because it is also what a `push` event looks like when
      # the base was left at its default, and there the empty answer is an
      # artefact rather than a fact.
      echo "Same-release expand/contract check: ${BASE_REF} and HEAD are the same commit, so this branch adds nothing to compare. On a push event pass --base <the pre-push SHA>." >&2
    fi

    # Contract rows only, first row per migration (matching the validator's
    # ledger_entry_for_migration, so the two gates can never read the ledger
    # differently), and only those naming a real previous release.
    contract_rows="$(
      awk -F'\t' '
        function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
        /^[[:space:]]*#/ { next }
        NF == 0 { next }
        {
          name = trim($1)
          if (name == "") { next }
          if (name in seen) { next }
          seen[name] = 1
          phase = trim($2)
          previous = trim($3)
          compatible = trim($4)
          plan = trim($5)
          if (phase != "contract") { next }
          if (previous == "" || previous == "n/a") { next }
          print name "\t" previous "\t" compatible "\t" plan
        }
      ' "$MIGRATION_SAFETY_LEDGER"
    )"

    is_added_on_this_branch() {
      list_contains_line "$1" "$added_migrations"
    }

    same_release_pairs=0
    same_release_acknowledged=0
    while IFS=$'\t' read -r contract_migration expand_migration old_code_compatible lock_impact_plan; do
      [ -n "${contract_migration:-}" ] || continue
      is_added_on_this_branch "$contract_migration" || continue
      is_added_on_this_branch "${expand_migration:-}" || continue

      reason=""
      case "${lock_impact_plan:-}" in
        *"$SAME_RELEASE_ACK_MARKER"*)
          reason="${lock_impact_plan#*"$SAME_RELEASE_ACK_MARKER"}"
          reason="${reason#"${reason%%[![:space:]]*}"}"
          ;;
      esac

      if [ "${#reason}" -ge "$SAME_RELEASE_ACK_MIN_REASON_CHARS" ]; then
        # An acknowledgement is only available to a `windowed` row, and that is
        # not bookkeeping. docs/BLUE_GREEN_MIGRATION_POLICY.md says an
        # acknowledged row "is `windowed` by definition, and the pre-existing
        # coverage check then still demands its `rollback.sql`" — TRUE ONLY IF
        # THE ROW REALLY SAYS `windowed`, because that is the single condition
        # the validator's reverse-script requirement fires on. Declared `yes`,
        # an acknowledged row was a one-release drop asserting the old colour
        # stays compatible (which the acknowledgement itself contradicts) and
        # shipping no reverse script at all. That is the exact shape this gate
        # exists to prevent, arriving through the gate's own escape hatch.
        if [ "${old_code_compatible:-}" != "windowed" ]; then
          same_release_pairs=$((same_release_pairs + 1))
          echo "Same-release expand/contract ACKNOWLEDGEMENT REFUSED: only a windowed row may be acknowledged." >&2
          echo "  contract migration : ${contract_migration}  (added on this branch)" >&2
          echo "  its named expand   : ${expand_migration}  (added on this branch too)" >&2
          echo "  old_code_compatible: ${old_code_compatible:-(empty)}  - must be exactly: windowed" >&2
          echo "  WHY: the acknowledgement says the owner chose a ONE-RELEASE DROP behind a" >&2
          echo "  maintenance window, and 'windowed' is precisely what that means - the previous" >&2
          echo "  colour WILL error between migrate and cutover. Declaring 'yes' asserts the" >&2
          echo "  opposite in the same row. It also disarms the reverse-script requirement in" >&2
          echo "  scripts/validate-blue-green-migrations.sh, which fires on 'windowed' and on" >&2
          echo "  nothing else - so 'yes' plus an acknowledgement ships a one-release drop with" >&2
          echo "  no declared window and no rollback.sql, and the coverage check above stays" >&2
          echo "  quiet about it." >&2
          echo "  WHAT TO DO: set old_code_compatible=windowed on ${contract_migration} and" >&2
          echo "  commit its rollback.sql (docs/BLUE_GREEN_MIGRATION_POLICY.md), or drop the" >&2
          echo "  acknowledgement and move the contract half to a release after this one." >&2
          failures=1
          continue
        fi
        same_release_acknowledged=$((same_release_acknowledged + 1))
        echo "Same-release expand/contract ACKNOWLEDGED for ${contract_migration} against ${expand_migration}: ${reason}" >&2
        continue
      fi

      same_release_pairs=$((same_release_pairs + 1))
      echo "Same-release expand/contract check FAILED: an expand and its own contract land in one deploy." >&2
      echo "  contract migration : ${contract_migration}  (added on this branch)" >&2
      echo "  its named expand   : ${expand_migration}  (added on this branch too)" >&2
      echo "  compared against   : ${BASE_REF} (merge base ${base_sha})" >&2
      echo "  THE RULE (docs/BLUE_GREEN_MIGRATION_POLICY.md -> \"An epic's migrations arrive" >&2
      echo "  together, and that constrains what a child may do\"): a contract release's whole" >&2
      echo "  definition is that the previous runtime no longer depends on what is being" >&2
      echo "  removed, and previous_expand_release has to name a migration that has ACTUALLY" >&2
      echo "  DRAINED. Both of these arrive in the same deploy, so nothing has drained and" >&2
      echo "  the colour draining at cutover still reads the thing being removed." >&2
      echo "  WHAT TO DO: keep the expand half here and move the contract half to a release" >&2
      echo "  AFTER this one. Since #3002 an epic reaches main as ONE merge, so every" >&2
      echo "  migration in an epic lands in a single deploy - which makes this a scheduling" >&2
      echo "  fact to plan for at the start of an epic, not a discovery to make at its end." >&2
      echo "  File the contract half as its own follow-up issue now and link it." >&2
      echo "  IF THE OWNER HAS INSTEAD CHOSEN a one-release drop behind a maintenance window" >&2
      echo "  (the shape recorded for 20260803010000 and 20260803030000), say so in the" >&2
      echo "  ledger rather than working around this gate: put" >&2
      echo "    ${SAME_RELEASE_ACK_MARKER} <why, and which window>" >&2
      echo "  in ${contract_migration}'s lock_impact_plan, with at least ${SAME_RELEASE_ACK_MIN_REASON_CHARS} characters of reason." >&2
      echo "  Such a row must ALSO declare old_code_compatible=windowed, which this check now" >&2
      echo "  requires of an acknowledgement, and a windowed row must ship a rollback.sql," >&2
      echo "  which the validator enforces off that same declaration." >&2
      failures=1
    done <<<"$contract_rows"

    if [ "$same_release_pairs" = "0" ]; then
      echo "Same-release expand/contract check passed for ${added_count} migration(s) added since ${BASE_REF} (${same_release_acknowledged} acknowledged)." >&2
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. previous_expand_release must name a migration that EXISTS (#3002).
# ---------------------------------------------------------------------------
# Check 4 decides whether an expand and its own contract land together by
# MATCHING THIS NAME against the migrations the branch adds, with `grep -Fxq`
# over directory basenames. Nothing validated the name itself:
# scripts/validate-blue-green-migrations.sh requires only that a destructive
# contract's value be non-empty and not `n/a`. So one dropped word in a 40-to-60
# character hand-typed name — `20260901000000_add_foo` where the directory is
# `20260901000000_expand_add_foo` — matches nothing, check 4 finds no pair, and
# the gate passes over exactly the case it exists to catch. Silently, and with a
# green tick.
#
# Deliberately OUTSIDE the git-dependent block above: existence is a filesystem
# question, so this still runs on a developer machine where check 4 skips.
# Applied to every row that names a previous release rather than only to
# contract rows — today those are the same 19 rows, and "if you name one, it has
# to exist" is the rule a reader can hold.
migration_dir_names="$(
  for migration_dir in "$MIGRATIONS_DIR"/*/; do
    [ -d "$migration_dir" ] || continue
    basename "$migration_dir"
  done
)"

previous_release_rows="$(
  awk -F'\t' '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    {
      name = trim($1)
      if (name == "") { next }
      if (name in seen) { next }
      seen[name] = 1
      previous = trim($3)
      if (previous == "" || previous == "n/a") { next }
      print name "\t" previous
    }
  ' "$MIGRATION_SAFETY_LEDGER"
)"

previous_release_checked=0
previous_release_missing=0
while IFS=$'\t' read -r ledger_row_migration named_previous; do
  [ -n "${ledger_row_migration:-}" ] || continue
  previous_release_checked=$((previous_release_checked + 1))
  if list_contains_line "${named_previous}" "$migration_dir_names"; then
    continue
  fi

  near_misses="$(printf '%s\n' "$migration_dir_names" | grep -F -- "${named_previous%%_*}" | tr '\n' ' ')"
  echo "previous_expand_release check FAILED: a ledger row names a release that does not exist." >&2
  echo "  ledger row              : ${ledger_row_migration}" >&2
  echo "  previous_expand_release : ${named_previous}" >&2
  echo "  no such directory       : ${MIGRATIONS_DIR}/${named_previous}" >&2
  if [ -n "${near_misses// /}" ]; then
    echo "  sharing that timestamp  : ${near_misses}" >&2
  fi
  echo "  WHY THIS IS A GATE: the same-release expand/contract check matches this NAME" >&2
  echo "  against the migrations this branch adds. A name that matches no migration cannot" >&2
  echo "  match the added expand either, so that check finds nothing to compare and reports" >&2
  echo "  a pass - over the very pair it exists to catch. One dropped word in a hand-typed" >&2
  echo "  40-to-60 character name is enough, and nothing else validates this field:" >&2
  echo "  scripts/validate-blue-green-migrations.sh only requires it to be non-empty and" >&2
  echo "  not n/a." >&2
  echo "  WHAT TO DO: copy the directory name from ${MIGRATIONS_DIR} verbatim, or use n/a" >&2
  echo "  if this row genuinely names no previous release." >&2
  previous_release_missing=$((previous_release_missing + 1))
  failures=1
done <<<"$previous_release_rows"

if [ "$previous_release_missing" = "0" ]; then
  echo "previous_expand_release check passed for ${previous_release_checked} row(s) naming a previous release." >&2
fi

if [ "$failures" = "0" ]; then
  echo "Migration safety coverage check passed." >&2
fi

exit "$failures"
