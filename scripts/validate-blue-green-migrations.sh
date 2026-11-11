#!/usr/bin/env bash
set -Eeuo pipefail

# Requires GNU sed: unsafe_breaking_lines and same_arg_nullif use the
# case-insensitive "I" s/// flag (a GNU extension, the only GNU-only construct
# here). CI runs GNU coreutils; BSD/macOS sed rejects the flag and errors out,
# so the script fails closed there rather than silently misclassifying.

ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="${ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS:-0}"
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="${BLUE_GREEN_MIGRATION_OVERRIDE_REASON:-}"
BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED="${BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED:-0}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"

# Whole-statement splitter, shared with scripts/check-data-migration-verification.sh
# (#2418) so the two gates can never disagree about what PostgreSQL will run.
# Resolved from this script's own location, not the caller's cwd, because the
# production deploy invokes it as ./scripts/validate-blue-green-migrations.sh
# from the repository root while the contract tests invoke it from elsewhere.
SQL_STATEMENT_SPLITTER="${SQL_STATEMENT_SPLITTER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/split-sql-statements.awk}"

if [ ! -f "$SQL_STATEMENT_SPLITTER" ]; then
  echo "validate-blue-green-migrations: SQL statement splitter not found at ${SQL_STATEMENT_SPLITTER}" >&2
  exit 1
fi

# Baseline for the session-clock DML gate below (#1656 / #1627): migrations whose
# timestamp-prefixed name sorts at or after this value are checked for
# CURRENT_TIMESTAMP/now() inside INSERT/UPDATE payloads; older migrations predate
# the gate and are exempt so committed history never retro-fails. The value sits
# above every migration on main at introduction time (latest was
# 20260708240000, and 20260708220000 legitimately used now() in an UPDATE). This
# is a hard, non-overridable block, mirroring the ledger-coverage baseline in
# check-migration-safety-coverage.sh (skip anything sorting before the baseline).
SESSION_CLOCK_DML_BASELINE="${SESSION_CLOCK_DML_BASELINE:-20260709000000}"

# Session-clock DML acknowledgements (#2038): migrations at or after the baseline
# whose INSERT/UPDATE payload trips the session-clock gate but has been reviewed
# and accepted as benign in context. This is a NARROW, per-migration, code-reviewed
# waiver — NOT the blanket ALLOW_BREAKING override (which still cannot rescue this
# gate). It mirrors the grandfathered-prefix allowlist in
# check-migration-safety-coverage.sh: each entry is the exact migration directory
# name and carries a comment justifying why the session clock is harmless there.
# Prefer FIXING a new migration to write timezone('UTC', statement_timestamp()) (or
# an explicit UTC literal) over adding a row here; only acknowledge when the write
# is cosmetic on a cold table with no createdAt-ordering invariant to skew.
SESSION_CLOCK_DML_ACKNOWLEDGED=(
  # 20260717180000_genericise_starter_lodge_copy: three UPDATEs on the cold
  # PageContent table set "updatedAt" = CURRENT_TIMESTAMP purely for content-edit
  # freshness. PageContent carries no createdAt/updatedAt ordering invariant (unlike
  # the #1627 default-lodge row whose relative createdAt decides the club default),
  # so the local-wall-clock skew this gate guards against is cosmetic here. The gate
  # historically missed it because the $cms$/$previous$-quoted HTML bodies contain
  # &mdash;/&ndash; HTML-entity semicolons that fragmented the statement before the
  # check (#2038); the dollar-quote-aware splitter now sees the whole UPDATE, so this
  # acknowledgement records the reviewed disposition instead.
  20260717180000_genericise_starter_lodge_copy
)

# True when the migration directory name is on the reviewed session-clock
# acknowledgement allowlist above.
session_clock_acknowledged() {
  local migration_name="$1" acked
  for acked in "${SESSION_CLOCK_DML_ACKNOWLEDGED[@]}"; do
    [ "$migration_name" = "$acked" ] && return 0
  done
  return 1
}

HOT_TABLE_SQL_REGEX='(ALTER TABLE|UPDATE|DELETE FROM|TRUNCATE|CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX|DROP INDEX|CREATE[[:space:]]+(CONSTRAINT[[:space:]]+)?TRIGGER|DROP TRIGGER|ADD CONSTRAINT|DROP CONSTRAINT|REFERENCES)[^;]*"(Member|MemberSubscription|MemberApplication|MemberCredit|FamilyGroup|FamilyGroupMember|FamilyGroupJoinRequest|Booking|BookingGuest|BookingModification|Payment|PaymentTransaction|PaymentRefund|RefundRequest|PasswordResetToken|EmailVerificationToken|EmailChangeToken|GuestChoreToken|NominationToken|FinanceXeroToken)"'
# Breaking for a blue/green cutover: the draining old colour still speaks the old
# shape, so any of these can make its reads/writes error between migrate and
# cutover.
#
# "RENAME VALUE" (#2288) is an enum-value rename, ALTER TYPE ... RENAME VALUE. It
# is genuinely breaking — the old colour keeps sending the old label and Postgres
# answers "invalid input value for enum" — but nothing in this list saw it before:
# it is not an ALTER TABLE, not a DROP TYPE, not an ALTER COLUMN. A migration that
# ONLY renamed enum values therefore sailed through the gate as harmless. The real
# 20260525010000_align_booking_change_request_with_review_queues tripped the gate
# only because it renamed columns as well.
#
# It is matched BARE, exactly like the sibling "RENAME COLUMN" alternative, rather
# than as "ALTER TYPE .* RENAME VALUE": this scan is line-oriented, so a statement
# split as
#     ALTER TYPE "BookingChangeRequestStatus"
#       RENAME VALUE 'PENDING' TO 'REQUESTED';
# would otherwise slip past (that exact split is how 20260525010000 writes its
# ALTER INDEX statements).
#
# A bare phrase still cannot survive a wrap INSIDE itself — "RENAME" ending one
# line and "VALUE"/"COLUMN" starting the next reads as neither. "RENAME COLUMN"
# has always had a backstop for exactly that: the separate "ALTER TABLE .* RENAME"
# alternative matches the first line on its own. "ALTER TYPE .* RENAME" (#2288) is
# the matching backstop for "RENAME VALUE", so the two enum/column rename patterns
# finally have the same two-pattern coverage. It closes a second hole in the same
# edit: a standalone type rename, ALTER TYPE "X" RENAME TO "Y" — a spelling this
# repo actually writes (20260411203000) — was matched by nothing in this list.
#
# The backstop costs nothing on the committed tree: exactly two migrations match
# it (20260411203000 and 20260525010000), both of which already trip DROP TYPE /
# ALTER COLUMN ... TYPE / RENAME COLUMN, and ALTER TYPE ... ADD VALUE contains no
# RENAME so the additive enum migrations stay unmatched. Like its
# "ALTER TABLE .* RENAME" sibling the ".*" is greedy across the line, so an
# ADD VALUE whose new label literally contained the substring RENAME would match;
# no committed migration does, and failing closed is the safe direction.
#
# False positives: a "--" comment on its own line is dropped by sql_lines before
# the scan, so quoting the phrase there costs nothing. A TRAILING comment or a
# string literal containing it does match — identically to the pre-existing
# "DROP COLUMN" alternative, which is pre-existing accepted behaviour and again
# fails closed.
#
# Deliberately NOT matched:
#   * ALTER TYPE ... ADD VALUE — additive. The old colour never sends the new
#     label, and every value it does send still exists. 29 committed migrations
#     add enum values (44 ADD VALUE statements); matching them would make the
#     gate noise.
#   * ALTER INDEX ... RENAME TO — genuinely old-code compatible, because no
#     application code references an index by name. Matching it would generate
#     false positives forever and train operators to reach for the override.
BREAKING_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|ALTER TABLE .* RENAME|ALTER TYPE .* RENAME|RENAME COLUMN|RENAME VALUE|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)'
# Destructive removals additionally have to be sequenced: phase=contract naming
# the previous expand release. An enum-value rename is deliberately NOT on this
# list (#2288 scope) — it is breaking, and must therefore be acknowledged as
# yes/windowed and cleared by the override, but it is not required to carry the
# expand/contract paperwork on its own. In practice an enum rename that matters
# travels with the column renames/drops that already put the migration here.
DESTRUCTIVE_REMOVAL_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|ALTER TABLE .* RENAME|RENAME COLUMN)'
# A "SET DEFAULT <value>" whose value is semantically NULL fills nothing, so it
# cannot waive a paired SET NOT NULL (see unsafe_breaking_lines). This matches the
# common Postgres/Prisma NULL-default spellings: a bare NULL, a parenthesised
# (NULL), and CAST(NULL AS <type>) — each with an optional ::cast tail and
# tolerant whitespace/semicolon. Expression forms such as NULLIF(...) are
# deliberately NOT matched (they classify as a non-NULL default): SQL expression
# analysis is out of scope for this gate. A parenthesised NULL whose inner cast
# type itself contains parentheses, e.g. "(NULL::numeric(10,2))", is likewise not
# recognised, but plain "(NULL)" and "CAST(NULL AS varchar(10))" are.
NULL_DEFAULT_VALUE_SQL_REGEX='SET DEFAULT[[:space:]]+(NULL|\([[:space:]]*NULL[[:space:]]*(::[^)]*)?[[:space:]]*\)|CAST[[:space:]]*\([[:space:]]*NULL[[:space:]]+AS[[:space:]]+.+\))[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$'
# NULLIF(x, x) with identical single-quoted literals evaluates to NULL, so it
# fills nothing and cannot waive a paired SET NOT NULL (#1602 gap 3 lists it as
# a common spelling). Implemented as two sed extractions + a bash string compare
# rather than an ERE backreference: backrefs in grep -E are non-POSIX and some
# grep implementations (e.g. ugrep) reject them, which would silently classify
# the default as non-NULL and fail OPEN. Only the SAME-argument single-quoted
# form matches; NULLIF with differing arguments — and every other SQL
# expression — still classifies as a non-NULL default: expression analysis
# stays out of scope for this gate.
same_arg_nullif() {
  local line="$1" first second
  first="$(printf '%s' "$line" |
    sed -nE "s/.*SET DEFAULT[[:space:]]+NULLIF[[:space:]]*\([[:space:]]*('[^']*')[[:space:]]*,.*/\1/pI")"
  [ -n "$first" ] || return 1
  second="$(printf '%s' "$line" |
    sed -nE "s/.*SET DEFAULT[[:space:]]+NULLIF[[:space:]]*\([[:space:]]*'[^']*'[[:space:]]*,[[:space:]]*('[^']*')[[:space:]]*\).*/\1/pI")"
  [ -n "$second" ] && [ "$first" = "$second" ]
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove a trailing "-- ..." SQL line comment so it cannot defeat the end-anchored
# NULL-default check (e.g. "SET DEFAULT NULL; -- reset"). A "--" inside a single-
# or double-quoted string is preserved: the scan tracks quote parity (including
# doubled "''"/'""' escapes) and only cuts at a "--" seen outside any quote.
# Limitation: dollar-quoted string bodies ($tag$...$tag$) and C-style /* */
# comments are not modelled, so a "--" inside those is treated as a comment.
strip_sql_comment() {
  awk -v sq="'" -v dq='"' '
    {
      in_s = 0; in_d = 0; out = $0
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == sq && !in_d) { in_s = !in_s; continue }
        if (c == dq && !in_s) { in_d = !in_d; continue }
        if (!in_s && !in_d && c == "-" && substr($0, i + 1, 1) == "-") {
          out = substr($0, 1, i - 1)
          break
        }
      }
      print out
    }
  ' <<<"$1"
}

sql_lines() {
  local file="$1"

  awk '
    /^[[:space:]]*--/ { next }
    /^[[:space:]]*$/ { next }
    { printf "%d:%s\n", NR, $0 }
  ' "$file"
}

# Reconstruct whole SQL statements from a migration file and emit any INSERT or
# UPDATE statement whose payload references the database session clock
# (CURRENT_TIMESTAMP or now()). Session time written into a naive timestamp
# column renders local wall-clock on a non-UTC database, skewing ordering (the
# #1627 default-lodge inversion); DML must write an explicit UTC value instead.
# A DDL "DEFAULT CURRENT_TIMESTAMP" lives in a CREATE/ALTER statement, never in
# an INSERT/UPDATE, so it is deliberately NOT matched.
#
# Statement-level detection is required: an INSERT's CURRENT_TIMESTAMP commonly
# sits many lines below its INSERT keyword, so a per-line scan cannot tell the
# two apart. Splitting is delegated to scripts/lib/split-sql-statements.awk,
# which is shared with the #2418 data-rewrite classifier and documents its own
# quote/dollar-quote handling and limitations.
#
# Limitations that matter here: a WITH ... INSERT/UPDATE CTE is not anchored
# (its leading keyword is WITH), and dollar-quoted bodies stay inside their
# enclosing statement, so an INSERT/UPDATE nested in a DO-block or function body
# is NOT surfaced (the enclosing statement starts with DO/CREATE) — a deliberate
# trade that avoids false positives from PL/pgSQL bodies. This repo writes such
# payloads with explicit UTC (timezone('UTC', statement_timestamp())), so a
# future DO-block using now()/CURRENT_TIMESTAMP in a payload is a known uncaught
# vector; the primary #1627 vector — a top-level INSERT/UPDATE ...
# CURRENT_TIMESTAMP, like the lodge seed — is caught. Full PL/pgSQL body coverage
# would need a parser and is out of scope for this line-oriented gate.
#
# Returns 2 (with no usable output) when the file has an unterminated
# dollar-quote; the caller must treat that as a hard failure.
session_clock_dml_violations() {
  local file="$1" statements

  statements="$(awk -v tool="validate-blue-green-migrations" \
    -f "$SQL_STATEMENT_SPLITTER" "$file")" || return 2

  printf '%s\n' "$statements" |
    grep -Ei '^[[:space:]]*(INSERT|UPDATE)([[:space:]]|$)' |
    grep -Ei 'CURRENT_TIMESTAMP|(^|[^A-Za-z_])now[[:space:]]*\(' ||
    true
}

migration_name_for_file() {
  local file="$1"
  basename "$(dirname "$file")"
}

# Breaking SQL lines that are genuinely unsafe for a blue/green cutover. This is
# every BREAKING_SQL_REGEX match EXCEPT an "ALTER COLUMN ... SET NOT NULL" whose
# same table+column also gets a NON-NULL "SET DEFAULT" in the SAME migration: an
# old colour that omits the column on INSERT receives that default, so no null is
# ever written and the NOT NULL holds throughout the cutover (old-code-compatible,
# no outage). Such a NOT NULL still needs a documented ledger entry, but not the
# ALLOW_BREAKING override.
#
# The waiver only holds when the column's EFFECTIVE final default is a real,
# non-NULL constant. Both SET DEFAULT and DROP DEFAULT for the column are read in
# file order and only the LAST one is judged (last-wins):
#   * a "SET DEFAULT NULL" in any spelling — bare, cast "NULL::text", parenthesised
#     "(NULL)", or "CAST(NULL AS <type>)" — fills nothing; and
#   * a trailing DROP DEFAULT after the last SET DEFAULT clears the default;
# either way an old colour's omitted-column INSERT still lands a null and the
# NOT NULL would abort — the pairing is vacuous and stays unsafe. A trailing
# "-- comment" on that final statement is stripped before the NULL check so it
# cannot hide a NULL default behind the end anchor. Expression defaults such as
# NULLIF(...) count as non-NULL (expression analysis is out of scope). Keyword
# matching is case-insensitive so lowercase DDL follows the same rules; quoted
# identifiers keep their original case. Drops, renames, type changes, and an
# unmatched SET NOT NULL remain unsafe.
unsafe_breaking_lines() {
  local file="$1" breaking line stmt table col default_lines last_default
  breaking="$(sql_lines "$file" | grep -Ei "$BREAKING_SQL_REGEX" || true)"
  [ -n "$breaking" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # strip the leading "NR:" line-number prefix sql_lines adds
    stmt="${line#*:}"
    if printf '%s' "$stmt" | grep -Eiq 'ALTER COLUMN .* SET NOT NULL'; then
      # Case-insensitive keyword match (GNU sed s///I) so lowercase DDL reaches
      # the waiver logic instead of always blocking; the captured identifiers keep
      # their original case ("[^"]+" is unaffected by the I modifier) because
      # quoted Postgres identifiers are case-significant.
      #
      # Extract from a comment-stripped copy of the statement: the greedy ".*"
      # prefix would otherwise let a trailing '-- ALTER COLUMN "other"' comment
      # retarget the capture and waive an UNPAIRED NOT NULL (#1602 review
      # finding). The raw $line still flows to the output/keyword paths, so
      # stripping here can only prevent a comment-induced false waive.
      stmt_no_comment="$(strip_sql_comment "$stmt")"
      table="$(printf '%s' "$stmt_no_comment" | sed -nE 's/.*ALTER TABLE "([^"]+)".*/\1/pI')"
      col="$(printf '%s' "$stmt_no_comment" | sed -nE 's/.*ALTER COLUMN "([^"]+)".*/\1/pI')"
      if [ -n "$table" ] && [ -n "$col" ]; then
        # Collect both SET DEFAULT and DROP DEFAULT for this column so the
        # effective final default is judged across both statement kinds.
        default_lines="$(sql_lines "$file" |
          grep -Ei "ALTER TABLE \"${table}\" ALTER COLUMN \"${col}\" (SET|DROP) DEFAULT" || true)"
        # Last-wins: only the FINAL SET/DROP DEFAULT is the effective default, so
        # judge only that last line. It waives the NOT NULL iff it is a SET DEFAULT
        # (not a DROP DEFAULT, which clears the default) whose value is non-NULL. A
        # NULL default in any recognised spelling fills nothing, so the pairing is
        # vacuous and the NOT NULL stays unsafe. A trailing "-- comment" is stripped
        # first so it cannot hide a NULL default behind the end anchor.
        if [ -n "$default_lines" ]; then
          last_default="$(strip_sql_comment "$(printf '%s\n' "$default_lines" | tail -n1)")"
          if printf '%s\n' "$last_default" | grep -Eiq 'SET DEFAULT' &&
            ! printf '%s\n' "$last_default" | grep -Eiq "$NULL_DEFAULT_VALUE_SQL_REGEX" &&
            ! same_arg_nullif "$last_default"; then
            continue
          fi
        fi
      fi
    fi
    printf '%s\n' "$line"
  done <<<"$breaking"
}

ledger_entry_for_migration() {
  local migration_name="$1"

  if [ ! -f "$MIGRATION_SAFETY_LEDGER" ]; then
    return 1
  fi

  awk -F'\t' -v migration_name="$migration_name" '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    $1 == migration_name {
      print
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$MIGRATION_SAFETY_LEDGER"
}

ledger_field() {
  local entry="$1"
  local field_number="$2"

  awk -F'\t' -v field_number="$field_number" '{ print $field_number }' <<<"$entry"
}

# ONE pass over the whole ledger, run BEFORE the migration loop (#2288). It emits
# two kinds of tab-tagged record so a single awk invocation serves both jobs:
#
#   windowed<TAB><migration_name>   the row declares old_code_compatible=windowed
#   error<TAB><message>             the row is malformed; the gate must fail
#
# Read once, up front, because the windowed check below has to run for every
# migration — including ones whose SQL matches no pattern at all — and a
# per-migration awk over the ledger would add a process spawn per migration to the
# PR-time coverage sweep over the whole tree.
#
# WHY THE VOCABULARY LINT LIVES HERE and not in validate_ledger_entry: that
# function only ever sees the rows of migrations that survive the
# hot-table/breaking skip in the loop below, plus the ones this scan has already
# recognised as EXACTLY "windowed". 73 of the 174 committed rows are for
# migrations whose SQL matches no pattern at all, so their fourth column was
# validated by nothing: a near-miss spelling ("Windowed", "WINDOWED", "maybe",
# empty) was simultaneously not recognised as windowed AND never checked, and the
# gate printed "safety check passed" and exited 0 — on exactly the data-only shape
# the windowed value exists for (the #1440 AgeTier backfill, whose UPDATE flipped
# rows to a label the draining colour's client could not deserialize). A
# capitalisation would have silently disarmed the declaration the operator wrote
# to prevent that outage.
#
# Linting the WHOLE ledger rather than only the pending rows is deliberate: the
# file is committed and PR-gated, so a malformed row anywhere is a defect that
# should never reach a deploy, and failing closed on it costs a correct ledger
# nothing (all 174 committed rows are well-formed 5-field yes/no rows).
#
# Duplicate migration names are an error rather than silent first-row-wins.
# ledger_entry_for_migration and this scan both take the first row, so a second
# row appended by a concurrent lane is discarded without a diagnostic — and a
# `windowed` declaration is precisely the thing a silent discard must not be
# allowed to delete. The ledger is append-only hand-edited TSV, so two lanes
# appending rows for the same migration merges cleanly and produces no conflict.
#
# FIELD COUNT is checked too, and that is the #2818 addition. The file had been
# corrupted in exactly the way an append-only hand-edited TSV invites: the
# previous last line carried no trailing newline, so the next lane's `>>` glued
# its row onto the end of the last one and THREE rows became one 9-field physical
# line. Every gate stayed green. `$1` was still a real migration name and `$4`
# was still "yes", so this scan passed the fused line; the rows swallowed into
# columns 6-9 were simply invisible, which meant a migration with no ledger row
# at all read as documented — the precise failure the coverage gate exists to
# prevent, on a file an operator is told to consult before every deploy.
#
# The expected width is read from the HEADER rather than hard-coded, so adding a
# column is a one-line edit to the header and not a hunt through this script. If
# the header cannot be read as a multi-column row the scan fails closed rather
# than skipping the check: a width of zero compared against every row would
# otherwise turn this into a silent no-op, which is the same class of defect it
# was written to catch.
scan_ledger() {
  [ -f "$MIGRATION_SAFETY_LEDGER" ] || return 0

  awk -F'\t' -v ledger="$MIGRATION_SAFETY_LEDGER" '
    NR == 1 {
      expected_fields = NF
      if (expected_fields < 2) {
        printf "error\t%s line 1: safety ledger header must be a tab-separated column list; read %d field(s). Without it the per-row field-count check cannot run, and a fused row would pass unnoticed (#2818).\n", ledger, expected_fields
        broken_header = 1
      }
    }
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    {
      if (broken_header) next

      if (NF != expected_fields) {
        printf "error\t%s line %d: safety ledger row has %d field(s), expected %d. Almost always two or more rows fused onto one physical line because the previous line had no trailing newline — split them and make sure the file ends with a newline. A fused row hides every migration after the first, so a migration with no row at all reads as documented (#2818).\n", ledger, NR, NF, expected_fields
        next
      }

      name = $1
      value = $4
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)

      if (name == "") {
        printf "error\t%s line %d: safety ledger data row has no migration name in column 1.\n", ledger, NR
        next
      }

      if (seen[name]++) {
        printf "error\t%s line %d: duplicate safety ledger row for %s (first declared on line %d). Only the first row is ever read, so a second row silently shadows it — merge the two into one row.\n", ledger, NR, name, seen_line[name]
        next
      }
      seen_line[name] = NR

      if (value != "yes" && value != "no" && value != "windowed") {
        printf "error\t%s line %d: %s: safety ledger old_code_compatible must be yes, no, or windowed (found \"%s\").\n", ledger, NR, name, value
        next
      }

      if (value == "windowed") printf "windowed\t%s\n", name
    }
  ' "$MIGRATION_SAFETY_LEDGER"
}

# Membership test against that set, in pure bash so it costs no process.
ledger_declares_windowed() {
  local migration_name="$1"

  [ -n "$WINDOWED_LEDGER_MIGRATIONS" ] || return 1
  case $'\n'"${WINDOWED_LEDGER_MIGRATIONS}"$'\n' in
    *$'\n'"${migration_name}"$'\n'*) return 0 ;;
  esac
  return 1
}

validate_ledger_entry() {
  local migration_name="$1"
  local requires_hot_table_plan="$2"
  local requires_breaking_ack="$3"
  local requires_contract_split="$4"
  local entry="$5"
  local phase
  local previous_release
  local old_code_compatible
  local lock_impact_plan
  local failed=0

  phase="$(trim_whitespace "$(ledger_field "$entry" 2)")"
  previous_release="$(trim_whitespace "$(ledger_field "$entry" 3)")"
  old_code_compatible="$(trim_whitespace "$(ledger_field "$entry" 4)")"
  lock_impact_plan="$(trim_whitespace "$(ledger_field "$entry" 5)")"

  if [[ ! "$phase" =~ ^(expand|contract|metadata-only)$ ]]; then
    echo "${migration_name}: safety ledger phase must be expand, contract, or metadata-only." >&2
    failed=1
  fi

  if [ "$requires_contract_split" = "1" ] && [ "$phase" != "contract" ]; then
    echo "${migration_name}: destructive schema removals must be recorded as phase=contract." >&2
    failed=1
  fi

  if [ "$requires_contract_split" = "1" ] && { [ -z "$previous_release" ] || [ "$previous_release" = "n/a" ]; }; then
    echo "${migration_name}: destructive contract migrations must name the previous expand release." >&2
    failed=1
  fi

  # old_code_compatible is a closed vocabulary (#2288). It was previously
  # unvalidated, so a typo ("Yes", "true", "n/a") silently read as "not yes" and
  # only ever surfaced on a breaking migration.
  #
  #   yes      - genuinely old-code compatible, because the migration carries a
  #              compensating pattern (e.g. SET NOT NULL paired with a same-column
  #              non-NULL SET DEFAULT, so an old colour's omitted-column INSERT
  #              still succeeds).
  #   windowed - NOT old-code compatible. The previous colour WILL error between
  #              migrate and cutover. Needs a maintenance window and the
  #              ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS override.
  #   no       - non-breaking migration; nothing to acknowledge.
  if [[ ! "$old_code_compatible" =~ ^(yes|no|windowed)$ ]]; then
    echo "${migration_name}: safety ledger old_code_compatible must be yes, no, or windowed." >&2
    failed=1
  fi

  # Before `windowed` existed the gate hard-required `yes`, so every breaking
  # migration asserted it whether or not it was true and the field carried no
  # information for exactly the migrations that most need scrutiny. The policy
  # already anticipated the case (BLUE_GREEN_MIGRATION_POLICY.md: "If that cannot
  # be true, the migration ... needs a separate maintenance/bootstrap plan"); this
  # is how that plan gets declared instead of being asserted falsely.
  if [ "$requires_breaking_ack" = "1" ] &&
    [ "$old_code_compatible" != "yes" ] &&
    [ "$old_code_compatible" != "windowed" ]; then
    echo "${migration_name}: breaking migrations must declare old_code_compatible=yes (genuinely compatible via a compensating pattern) or windowed (not compatible; needs a maintenance window and the ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS override) in the safety ledger." >&2
    failed=1
  fi

  # `windowed` asserts that an outage is planned, so it must be justified in
  # writing rather than becoming a quieter way to say `yes`.
  if [ "$old_code_compatible" = "windowed" ] && [ -z "$lock_impact_plan" ]; then
    echo "${migration_name}: windowed migrations must document the incompatibility and the maintenance-window plan in the safety ledger's lock impact plan column." >&2
    failed=1
  fi

  if [ "$requires_hot_table_plan" = "1" ] && [ -z "$lock_impact_plan" ]; then
    echo "${migration_name}: hot-table migrations must include a lock impact plan in the safety ledger." >&2
    failed=1
  fi

  return "$failed"
}

found_breaking=0
found_failure=0
# Opt-in protocol for the deploy engine. Diagnostics stay on stderr; emit the
# canonical classification only after every validation gate succeeds.
report_windowed=0
if [ "${1:-}" = "--report-windowed" ]; then
  report_windowed=1
  shift
fi

found_windowed=0
pending_count=0

# Split the single ledger pass into its two outputs. awk (not grep) so a scan with
# no matching records still exits 0 under `set -e`.
LEDGER_SCAN="$(scan_ledger)"
WINDOWED_LEDGER_MIGRATIONS="$(
  printf '%s\n' "$LEDGER_SCAN" | awk -F'\t' '$1 == "windowed" { print $2 }'
)"
ledger_scan_errors="$(
  printf '%s\n' "$LEDGER_SCAN" | awk '/^error\t/ { sub(/^error\t/, ""); print }'
)"
if [ -n "$ledger_scan_errors" ]; then
  printf '%s\n' "$ledger_scan_errors" >&2
  found_failure=1
fi

if [ "$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" = "1" ] &&
  [ -z "$(trim_whitespace "$BLUE_GREEN_MIGRATION_OVERRIDE_REASON")" ]; then
  echo "BLUE_GREEN_MIGRATION_OVERRIDE_REASON is required when ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1." >&2
  exit 1
fi

for migration_sql in "$@"; do
  [ -n "$migration_sql" ] || continue
  pending_count=$((pending_count + 1))

  if [ ! -f "$migration_sql" ]; then
    echo "Migration SQL file not found: ${migration_sql}" >&2
    found_failure=1
    continue
  fi

  migration_name="$(migration_name_for_file "$migration_sql")"

  # Session-clock DML gate (#1656 / #1627): CURRENT_TIMESTAMP/now() inside an
  # INSERT/UPDATE payload is a hard, non-overridable block for migrations at or
  # after the baseline (older ones predate the gate and are exempt so committed
  # history never retro-fails). Runs before the hot/breaking skip below because
  # a plain INSERT matches neither of those regexes. Non-overridable on purpose:
  # it flows through found_failure (not found_breaking), so the PR-time
  # ledger-coverage gate — which sets ALLOW_BREAKING=1 — still enforces it.
  migration_prefix="${migration_name%%_*}"
  if [[ ! "$migration_prefix" < "$SESSION_CLOCK_DML_BASELINE" ]]; then
    if ! session_clock_matches="$(session_clock_dml_violations "$migration_sql")"; then
      # Unterminated dollar-quote (or other unparsable state): fail loudly rather
      # than let a file the splitter cannot tokenise pass the gate unchecked.
      printf 'Unterminated dollar-quoted string in migration SQL — cannot verify session-clock safety: %s\n' "$migration_sql" >&2
      found_failure=1
    elif [ -n "$session_clock_matches" ]; then
      if session_clock_acknowledged "$migration_name"; then
        # Reviewed benign (see SESSION_CLOCK_DML_ACKNOWLEDGED): surface the match
        # as a note so the waiver stays visible, but do not fail the gate.
        printf 'Acknowledged benign session-clock DML (reviewed cold-table cosmetic write; see SESSION_CLOCK_DML_ACKNOWLEDGED): %s\n' "$migration_sql" >&2
        printf '%s\n\n' "$session_clock_matches" >&2
      else
        printf 'Session-clock CURRENT_TIMESTAMP/now() in an INSERT/UPDATE payload (write an explicit UTC value instead): %s\n' "$migration_sql" >&2
        printf '%s\n\n' "$session_clock_matches" >&2
        found_failure=1
      fi
    fi
  fi

  hot_table_matches="$(sql_lines "$migration_sql" | grep -Ei "$HOT_TABLE_SQL_REGEX" || true)"
  breaking_matches="$(sql_lines "$migration_sql" | grep -Ei "$BREAKING_SQL_REGEX" || true)"
  destructive_removal_matches="$(sql_lines "$migration_sql" | grep -Ei "$DESTRUCTIVE_REMOVAL_SQL_REGEX" || true)"

  # #2288: consult the declaration BEFORE the skip below. A migration whose SQL
  # matches nothing — a plain data UPDATE on a cold table, say — would otherwise
  # never have its ledger row read at all, and a windowed declaration on exactly
  # that shape of migration (the #1440 AgeTier backfill flipped rows to a value
  # the previous colour's client could not deserialize) is the case the value
  # exists for.
  ledger_declared_windowed=0
  if ledger_declares_windowed "$migration_name"; then
    ledger_declared_windowed=1
  fi

  if [ -z "$hot_table_matches" ] && [ -z "$breaking_matches" ] &&
    [ "$ledger_declared_windowed" = "0" ]; then
    continue
  fi

  ledger_entry="$(ledger_entry_for_migration "$migration_name" || true)"
  if [ -z "$ledger_entry" ]; then
    echo "${migration_name}: missing ${MIGRATION_SAFETY_LEDGER} entry for blue/green migration safety review." >&2
    found_failure=1
  else
    requires_hot_table_plan=0
    requires_breaking_ack=0
    requires_contract_split=0
    [ -n "$hot_table_matches" ] && requires_hot_table_plan=1
    [ -n "$breaking_matches" ] && requires_breaking_ack=1
    [ -n "$destructive_removal_matches" ] && requires_contract_split=1

    if ! validate_ledger_entry \
      "$migration_name" \
      "$requires_hot_table_plan" \
      "$requires_breaking_ack" \
      "$requires_contract_split" \
      "$ledger_entry"; then
      found_failure=1
    fi
  fi

  if [ -n "$hot_table_matches" ]; then
    printf 'Hot-table migration review required: %s\n' "$migration_sql" >&2
    printf '%s\n\n' "$hot_table_matches" >&2
  fi

  if [ -n "$breaking_matches" ]; then
    unsafe_matches="$(unsafe_breaking_lines "$migration_sql" || true)"
    if [ -n "$unsafe_matches" ]; then
      found_breaking=1
      printf 'Potentially blue/green-incompatible migration detected: %s\n' "$migration_sql" >&2
      printf '%s\n\n' "$unsafe_matches" >&2
    else
      printf 'Reviewed no-outage NOT NULL (SET NOT NULL paired with a same-column SET DEFAULT): %s\n' "$migration_sql" >&2
    fi
  fi

  # A windowed declaration (#2288) is the ledger saying, in writing, that the
  # draining old colour WILL error between migrate and cutover. Require the
  # operator override for it even when no SQL pattern matched — a data-only
  # migration (an UPDATE flipping rows to a value the old Prisma client cannot
  # deserialize, say) breaks the old colour with no breaking DDL at all, and the
  # ledger row is the only place that knows. It also overrides the
  # reviewed-no-outage waiver above: if the row says the outage is real, the gate
  # believes the row.
  if [ "$ledger_declared_windowed" = "1" ]; then
    found_windowed=1
    found_breaking=1
    printf 'Ledger declares this migration windowed (old colour NOT kept compatible; deploy-window only): %s\n' "$migration_sql" >&2

    # A windowed migration moves the rollback boundary back to the migrate step:
    # once it commits, aborting the deploy no longer restores service, so the
    # reverse script the policy mandates beside the migration is one of only three
    # recovery paths (forward to cutover, rollback.sql, restore from backup) and
    # the only one an operator can reach in seconds. The policy stated it as a MUST
    # and the runbook offers it as a recovery path, but nothing checked it — an
    # unenforced MUST in this gate is the same defect class as the previously
    # unvalidated old_code_compatible column. It is a documentation failure
    # (found_failure), so the ALLOW_BREAKING override cannot rescue it and the
    # PR-time coverage gate — which sets that override — still enforces it.
    rollback_sql="$(dirname "$migration_sql")/rollback.sql"
    if [ ! -f "$rollback_sql" ]; then
      echo "${migration_name}: windowed migrations must ship a reverse script beside the migration at ${rollback_sql} (see docs/BLUE_GREEN_MIGRATION_POLICY.md). If the change genuinely cannot be reversed, commit a rollback.sql that says so and names the recovery path instead of omitting the file." >&2
      found_failure=1
    fi
  fi
done

# An override is only permission to run a reviewed window; it is not evidence
# that the window actually exists. In particular, 20260806010000 is additive SQL
# but an old hosting worker ignores the newly added claimant tokens and can steal
# or complete work leased by the new protocol. Refuse an override-backed windowed
# deploy until the operator separately attests that the old web colour and every
# old worker/scheduler/queue consumer have stopped. The PR-time coverage sweep sets
# this explicitly for its non-deploy fixture run.
if [ "$found_windowed" = "1" ] &&
  [ "$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" = "1" ] &&
  [ "$BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED" != "1" ]; then
  echo "Pending windowed migrations cannot run until the old app and every old worker are stopped. Set BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 only after removing traffic, stopping the old web colour and all workers/schedulers/queue consumers, and verifying no old connection remains." >&2
  found_failure=1
fi

if [ "$found_failure" = "1" ]; then
  echo "Pending migrations are missing required blue/green safety documentation." >&2
  exit 1
fi

if [ "$found_breaking" = "1" ] && [ "$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" != "1" ]; then
  echo "Pending migrations contain potentially breaking SQL for blue/green rollout, or a ledger row declaring a windowed migration." >&2
  echo "Set ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 and BLUE_GREEN_MIGRATION_OVERRIDE_REASON only after the safety ledger proves old-code compatibility (old_code_compatible=yes), or the maintenance window for a declared windowed migration (old_code_compatible=windowed) is in place." >&2
  exit 1
fi

if [ "$found_breaking" = "1" ]; then
  echo "WARNING: Allowing reviewed breaking migration SQL because ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1." >&2
  echo "WARNING: Override reason: ${BLUE_GREEN_MIGRATION_OVERRIDE_REASON}" >&2
elif [ "$pending_count" -gt 0 ]; then
  echo "Blue/green migration safety check passed for ${pending_count} pending migration(s)." >&2
fi

if [ "$report_windowed" = "1" ]; then
  printf '%s\n' "$found_windowed"
fi
