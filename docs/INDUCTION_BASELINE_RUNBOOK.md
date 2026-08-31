# Trusted legacy induction baseline

Audience: Operator

## What this runbook does

Use this one-off maintenance command when the club has trustworthy historical
evidence that its existing members completed a new-member induction before the
digital induction register was introduced. The command records that baseline
without fabricating signers, sign-offs, or hut-leader eligibility.

The command is dry-run-first. A run without `--apply` only reports what it
would do. An apply needs the exact plan digest from the reviewed dry run plus
exact club and database confirmations, runs in one database transaction, and
either creates every planned row or creates none. It does not call Stripe,
Xero, SES, Sentry, or another external provider.

This is not a general induction import. Do not use it when the historical
source cannot support one common New Zealand date and one provenance note, or
when individual members need different induction facts.

## Before you start

Arrange a maintenance window and confirm all of the following:

- The committee has approved the historical source, the common induction date,
  and the wording of the provenance note.
- A current, tested database backup is available. Rehearse the procedure on a
  non-production copy before an authorised live run.
- The deployed application and generated Prisma client match the database
  schema.
- The actor member ID belongs to an active, login-enabled, non-archived,
  non-cancelled Full Admin.
- Age-tier settings form a complete, non-overlapping Infant / Child / Youth /
  Adult partition. The command does not use fallback tiers when this config is
  missing or invalid.
- Exactly one active New Member induction template exists, and it contains at
  least one valid section and checklist item.
- Every open Draft or In Progress induction reported by the dry run has been
  resolved through the normal Induction Register workflow.

**Copy the commands below exactly, including `--conditions=react-server`.** The
baseline command loads the database module, which carries `import "server-only"`
so the production build can never ship it to a member's browser
(`INV-OPS-013`, #2850). That marker throws the instant it is loaded under plain
Node, before the command prints anything, with a message about React Server
Components that names nothing you did. The flag resolves it to an empty module
and the command runs normally. Outside a container, `npm run induction:baseline`
passes the flag for you; inside the Compose `migrate` service the runbook calls
the `tsx` binary directly, so the flag is written out.

The population is limited at the database query to active, non-archived,
non-cancelled real-member records whose member role is `USER` or `ADMIN`.
Login is deliberately not required for this population, so non-login
dependants remain included. Lodge-device (`LODGE`), non-member contact
(`NON_MEMBER`), and school contact (`SCHOOL`) rows are excluded. Within the
real-member population, every configured person age tier participates,
including Infant, Child, Youth, and Adult; `N/A` records are reported
separately and are not changed. A member with any completed induction kind is
preserved and classified as `ALREADY_COMPLETED`; the command does not add
another completion.

### Freeze related writers before the final dry run

The table lock covers direct insert, update, and delete statements against
`MemberInduction`; it does not freeze the member population or every earlier
step of a larger workflow. Arrange an operator freeze from the start of the
**final** dry run until the post-apply verification dry run finishes. This is a
freeze on every route, import, and background job that can change who is
eligible, whether the chosen actor remains an authorised Full Admin, which tier
members occupy, the required sign-off count, or the template the baseline will
use. Pause:

- individual member edits and bulk member updates that can change `role`,
  `active`, date of birth, or `ageTier`;
- membership-application approvals, admin-created members, and members created
  through family requests;
- group-booking join acceptance and token-claim flows, which can create an
  active `USER` without creating a `MemberInduction`;
- CSV and other member imports, including Xero member imports;
- membership-assignment saves and roll-forward jobs that can update
  `ageTier`;
- changes to the chosen actor's `canLogin`, access-role assignments,
  active/archive/cancel state, account deletion, or merge;
- archive, cancel, reactivate, delete, merge, and every other member lifecycle
  operation;
- induction creation, signer assignment or reassignment, sign-off, admin
  completion or override, void, and delete; and
- changes to club identity, age-tier settings, nomination settings, or
  induction-template content and activation.

Do not assume the `MemberInduction` table lock covers any of the member,
actor, eligibility, or configuration writers above. They are paused by the
operator procedure, not by a database lock. If the dry run finds a blocker, end
the final-run attempt, resolve it, then start a new freeze and generate a fresh
final dry run. Do not review one plan while those writers continue and later
apply it as though the actor, population, and configuration were unchanged.

### Prepare literal-safe values

Treat every club name and provenance note as data, never as shell syntax. A
value can contain spaces, quotes, dollar signs, backticks, semicolons, or other
shell metacharacters without becoming executable when it is read from a file
and passed as one quoted argument. Do not paste a database-backed value inside
quotes in a command.

Create a private input directory and use a trusted text editor to put each
value in its own file. Every file must contain exactly one non-empty line,
ending with one newline. Embedded newlines are forbidden for this operation.

```bash
set -euo pipefail
umask 077
INDUCTION_INPUT_DIR="$(mktemp -d)"

vi -- "$INDUCTION_INPUT_DIR/actor-member-id"
vi -- "$INDUCTION_INPUT_DIR/baseline-date"
vi -- "$INDUCTION_INPUT_DIR/provenance-note"
```

Validate the file shape before reading the values. `IFS= read -r` preserves the
literal text; the variables remain unexported and are passed only to the one
command that needs them.

```bash
for INPUT_FILE in \
  "$INDUCTION_INPUT_DIR/actor-member-id" \
  "$INDUCTION_INPUT_DIR/baseline-date" \
  "$INDUCTION_INPUT_DIR/provenance-note"
do
  if [ ! -f "$INPUT_FILE" ] || [ "$(wc -l < "$INPUT_FILE")" -ne 1 ]; then
    printf 'Expected exactly one newline-terminated line in %s\n' "$INPUT_FILE" >&2
    exit 1
  fi
done

IFS= read -r ACTOR_MEMBER_ID < "$INDUCTION_INPUT_DIR/actor-member-id"
IFS= read -r BASELINE_DATE < "$INDUCTION_INPUT_DIR/baseline-date"
IFS= read -r PROVENANCE_NOTE < "$INDUCTION_INPUT_DIR/provenance-note"

if [ -z "$ACTOR_MEMBER_ID" ] || [ -z "$BASELINE_DATE" ] || [ -z "$PROVENANCE_NOTE" ]; then
  printf 'Induction baseline input files must not be empty.\n' >&2
  exit 1
fi

BASELINE_ARGS=(
  --actor-member-id "$ACTOR_MEMBER_ID"
  --baseline-date "$BASELINE_DATE"
  --provenance-note "$PROVENANCE_NOTE"
)
```

Use a separate protected directory and synthetic values for rehearsal. Never
copy a production database URL, credential, actor ID, or club text into the
rehearsal shell.

### Pin and verify the live Compose context

The production deploy wrapper does not promise to leave `MIGRATE_IMAGE` or
`COMPOSE_PROJECT_NAME` exported in a later operator shell. Load them explicitly
for this maintenance window. In the same protected directory, create four more
one-line files using a trusted editor:

- `compose-project-name`: the exact live Compose project name from the
  deployment record;
- `compose-env-file`: the absolute path to that deployment's production
  `.env`;
- `compose-file`: the absolute path to the reviewed `docker-compose.yml` in
  the deployed workspace, not whichever checkout happens to be current; and
- `migrate-image`: the owner-approved migration image as
  `repository@sha256:<64 hexadecimal characters>`, for the same reviewed commit
  as the deployed app. A mutable tag is not sufficient.

Read and validate them without exporting them:

```bash
for INPUT_FILE in \
  "$INDUCTION_INPUT_DIR/compose-project-name" \
  "$INDUCTION_INPUT_DIR/compose-env-file" \
  "$INDUCTION_INPUT_DIR/compose-file" \
  "$INDUCTION_INPUT_DIR/migrate-image"
do
  if [ ! -f "$INPUT_FILE" ] || [ "$(wc -l < "$INPUT_FILE")" -ne 1 ]; then
    printf 'Expected exactly one newline-terminated line in %s\n' "$INPUT_FILE" >&2
    exit 1
  fi
done

IFS= read -r PRODUCTION_COMPOSE_PROJECT_NAME < "$INDUCTION_INPUT_DIR/compose-project-name"
IFS= read -r PRODUCTION_ENV_FILE < "$INDUCTION_INPUT_DIR/compose-env-file"
IFS= read -r PRODUCTION_COMPOSE_FILE < "$INDUCTION_INPUT_DIR/compose-file"
IFS= read -r APPROVED_MIGRATE_IMAGE < "$INDUCTION_INPUT_DIR/migrate-image"

if [[ ! "$PRODUCTION_COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  printf 'The production Compose project name is missing or invalid.\n' >&2
  exit 1
fi
if [ ! -f "$PRODUCTION_ENV_FILE" ] || [ ! -f "$PRODUCTION_COMPOSE_FILE" ]; then
  printf 'The exact production env file and Compose file must both exist.\n' >&2
  exit 1
fi
case "$PRODUCTION_ENV_FILE" in
  /*) ;;
  *)
    printf 'The production env-file path must be absolute.\n' >&2
    exit 1
    ;;
esac
case "$PRODUCTION_COMPOSE_FILE" in
  /*) ;;
  *)
    printf 'The production Compose-file path must be absolute.\n' >&2
    exit 1
    ;;
esac
if [[ ! "$APPROVED_MIGRATE_IMAGE" =~ ^[^[:space:]]+@sha256:[[:xdigit:]]{64}$ ]]; then
  printf 'MIGRATE_IMAGE must be an approved digest-pinned reference.\n' >&2
  exit 1
fi

PRODUCTION_COMPOSE=(
  env
  "COMPOSE_PROJECT_NAME=$PRODUCTION_COMPOSE_PROJECT_NAME"
  "MIGRATE_IMAGE=$APPROVED_MIGRATE_IMAGE"
  docker compose
  --project-name "$PRODUCTION_COMPOSE_PROJECT_NAME"
  --env-file "$PRODUCTION_ENV_FILE"
  -f "$PRODUCTION_COMPOSE_FILE"
  --profile migrate
)
```

`PRODUCTION_COMPOSE` is a Bash array, not a string to evaluate. Every invocation
below expands it as literal arguments and explicitly supplies the approved
digest, project name, environment file, and Compose file; no ambient export or
shell re-parsing is involved.

Pull and inspect that immutable image, then ask Compose to resolve the exact
production context. Fail unless `config --images` contains the approved digest
exactly once and never resolves the local fallback:

```bash
docker pull "$APPROVED_MIGRATE_IMAGE"
docker image inspect "$APPROVED_MIGRATE_IMAGE" \
  --format '{{range .RepoDigests}}{{println .}}{{end}}' |
  grep -Fqx -- "$APPROVED_MIGRATE_IMAGE"

COMPOSE_IMAGES="$("${PRODUCTION_COMPOSE[@]}" config --images)"

MIGRATE_MATCHES=0
LOCAL_FALLBACK_FOUND=false
while IFS= read -r CONFIGURED_IMAGE; do
  if [ "$CONFIGURED_IMAGE" = "$APPROVED_MIGRATE_IMAGE" ]; then
    MIGRATE_MATCHES=$((MIGRATE_MATCHES + 1))
  fi
  if [ "$CONFIGURED_IMAGE" = "${PRODUCTION_COMPOSE_PROJECT_NAME}-migrate:local" ]; then
    LOCAL_FALLBACK_FOUND=true
  fi
done <<< "$COMPOSE_IMAGES"

if [ "$MIGRATE_MATCHES" -ne 1 ] || [ "$LOCAL_FALLBACK_FOUND" = true ]; then
  printf 'Compose did not resolve the one approved migration image; stop.\n' >&2
  exit 1
fi
```

Run this verification again if the shell, deploy workspace, project name,
Compose file, environment file, or approved digest changes. Never continue by
building or accepting `${project}-migrate:local`.

### Complete a disposable non-production rehearsal

Rehearse the whole sequence against a synthetic or already-sanitised
non-production dump. Never restore unsanitised production data into this
project. First validate that the dump really restores by following the
[Quarterly Backup Restore Drill](MAINTENANCE.md#quarterly-backup-restore-drill),
then record the completed rehearsal using the
[staging rehearsal record](PRODUCTION_UPGRADE_RUNBOOK.md#7-staging-rehearsal-record).

Create a dedicated staging environment from `.env.staging.example`. Give it a
unique database password and loopback port, keep every provider disabled or
pointed at the repository's non-production captures, and set a strong
rehearsal-only auth secret. From the repository root:

```bash
cp .env.staging.example .env.induction-rehearsal
vi -- .env.induction-rehearsal

REHEARSAL_PROJECT_NAME="induction-baseline-rehearsal"
REHEARSAL_ENV_FILE="$PWD/.env.induction-rehearsal"
REHEARSAL_BASE_COMPOSE="$PWD/docker-compose.yml"
REHEARSAL_OVERRIDE_COMPOSE="$PWD/docker-compose.staging.yml"
REHEARSAL_INPUT_DIR="$(mktemp -d)"
REHEARSAL_COMPOSE=(
  env
  "COMPOSE_PROJECT_NAME=$REHEARSAL_PROJECT_NAME"
  "MIGRATE_IMAGE=$APPROVED_MIGRATE_IMAGE"
  docker compose
  --project-name "$REHEARSAL_PROJECT_NAME"
  --env-file "$REHEARSAL_ENV_FILE"
  -f "$REHEARSAL_BASE_COMPOSE"
  -f "$REHEARSAL_OVERRIDE_COMPOSE"
  --profile migrate
)

REHEARSAL_TEARDOWN_COMPLETE=false
cleanup_induction_rehearsal() {
  local original_status=$?
  local cleanup_status=0

  # Prevent EXIT recursion and a signal arriving during cleanup from starting a
  # second teardown. Preserve an existing failure even if teardown also fails.
  trap - EXIT INT TERM
  if [ "$REHEARSAL_TEARDOWN_COMPLETE" != true ]; then
    "${REHEARSAL_COMPOSE[@]}" down -v --remove-orphans ||
      cleanup_status=$?
    if [ "$cleanup_status" -ne 0 ]; then
      printf 'Rehearsal teardown also failed with status %s; inspect only the dedicated %s Compose project.\n' \
        "$cleanup_status" "$REHEARSAL_PROJECT_NAME" >&2
    fi
  fi

  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup_induction_rehearsal EXIT

vi -- "$REHEARSAL_INPUT_DIR/rehearsal-dump-path"
if [ "$(wc -l < "$REHEARSAL_INPUT_DIR/rehearsal-dump-path")" -ne 1 ]; then
  printf 'The rehearsal dump path file must contain exactly one line.\n' >&2
  exit 1
fi
IFS= read -r REHEARSAL_DUMP < "$REHEARSAL_INPUT_DIR/rehearsal-dump-path"
if [ ! -f "$REHEARSAL_DUMP" ]; then
  printf 'The synthetic or sanitised rehearsal dump does not exist.\n' >&2
  exit 1
fi

bash scripts/backup-restore-drill.sh --from-dump "$REHEARSAL_DUMP"

# This fixed project name is rehearsal-only. Remove any interrupted old copy
# before restoring so no stale row or audit can satisfy the checks below.
"${REHEARSAL_COMPOSE[@]}" down -v --remove-orphans
"${REHEARSAL_COMPOSE[@]}" up -d --wait postgres

gzip -dc -- "$REHEARSAL_DUMP" |
  "${REHEARSAL_COMPOSE[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U tac -d tacbookings

"${REHEARSAL_COMPOSE[@]}" run --rm migrate
```

Prepare separate protected one-line files for the rehearsal actor, baseline
date, and provenance note. The restored data must include at least one eligible
synthetic member with no completed induction, so the dry run has a nonzero
`CREATE` count and exercises the write path. Create a protected evidence
directory and run the complete sequence:

```bash
vi -- "$REHEARSAL_INPUT_DIR/actor-member-id"
vi -- "$REHEARSAL_INPUT_DIR/baseline-date"
vi -- "$REHEARSAL_INPUT_DIR/provenance-note"

for INPUT_FILE in \
  "$REHEARSAL_INPUT_DIR/actor-member-id" \
  "$REHEARSAL_INPUT_DIR/baseline-date" \
  "$REHEARSAL_INPUT_DIR/provenance-note"
do
  if [ ! -f "$INPUT_FILE" ] || [ "$(wc -l < "$INPUT_FILE")" -ne 1 ]; then
    printf 'Expected exactly one newline-terminated line in %s\n' "$INPUT_FILE" >&2
    exit 1
  fi
done

IFS= read -r REHEARSAL_ACTOR_MEMBER_ID < "$REHEARSAL_INPUT_DIR/actor-member-id"
IFS= read -r REHEARSAL_BASELINE_DATE < "$REHEARSAL_INPUT_DIR/baseline-date"
IFS= read -r REHEARSAL_PROVENANCE_NOTE < "$REHEARSAL_INPUT_DIR/provenance-note"
if [ -z "$REHEARSAL_ACTOR_MEMBER_ID" ] ||
   [ -z "$REHEARSAL_BASELINE_DATE" ] ||
   [ -z "$REHEARSAL_PROVENANCE_NOTE" ]; then
  printf 'Rehearsal baseline input files must not be empty.\n' >&2
  exit 1
fi

REHEARSAL_BASELINE_ARGS=(
  --actor-member-id "$REHEARSAL_ACTOR_MEMBER_ID"
  --baseline-date "$REHEARSAL_BASELINE_DATE"
  --provenance-note "$REHEARSAL_PROVENANCE_NOTE"
)
REHEARSAL_EVIDENCE_DIR="$(mktemp -d)"

"${REHEARSAL_COMPOSE[@]}" run --rm migrate \
  ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
  "${REHEARSAL_BASELINE_ARGS[@]}" \
  --json | tee "$REHEARSAL_EVIDENCE_DIR/dry-run.txt"

grep -Eq '^  CREATE: [1-9][0-9]*$' "$REHEARSAL_EVIDENCE_DIR/dry-run.txt"
```

Confirm the dry-run output contains one well-formed digest:

```bash
grep -Eq '^PLAN DIGEST: sha256:[a-f0-9]{64}$' \
  "$REHEARSAL_EVIDENCE_DIR/dry-run.txt"
```

Copy the exact club name, parsed database host, database name, and `PLAN
DIGEST` value from that report into four new protected one-line files; do not
paste their contents into the shell. Confirm the rehearsal starts with no
prior baseline audit, apply, then rerun the dry run:

```bash
vi -- "$REHEARSAL_INPUT_DIR/confirm-club-name"
vi -- "$REHEARSAL_INPUT_DIR/confirm-db-host"
vi -- "$REHEARSAL_INPUT_DIR/confirm-db-name"
vi -- "$REHEARSAL_INPUT_DIR/confirm-plan-digest"

for INPUT_FILE in \
  "$REHEARSAL_INPUT_DIR/confirm-club-name" \
  "$REHEARSAL_INPUT_DIR/confirm-db-host" \
  "$REHEARSAL_INPUT_DIR/confirm-db-name" \
  "$REHEARSAL_INPUT_DIR/confirm-plan-digest"
do
  if [ ! -f "$INPUT_FILE" ] || [ "$(wc -l < "$INPUT_FILE")" -ne 1 ]; then
    printf 'Expected exactly one newline-terminated line in %s\n' "$INPUT_FILE" >&2
    exit 1
  fi
done

IFS= read -r REHEARSAL_CLUB_NAME < "$REHEARSAL_INPUT_DIR/confirm-club-name"
IFS= read -r REHEARSAL_DB_HOST < "$REHEARSAL_INPUT_DIR/confirm-db-host"
IFS= read -r REHEARSAL_DB_NAME < "$REHEARSAL_INPUT_DIR/confirm-db-name"
IFS= read -r REHEARSAL_PLAN_DIGEST < "$REHEARSAL_INPUT_DIR/confirm-plan-digest"
if [ -z "$REHEARSAL_CLUB_NAME" ] ||
   [ -z "$REHEARSAL_DB_HOST" ] ||
   [ -z "$REHEARSAL_DB_NAME" ] ||
   [ -z "$REHEARSAL_PLAN_DIGEST" ]; then
  printf 'Rehearsal confirmation files must not be empty.\n' >&2
  exit 1
fi

REHEARSAL_AUDITS_BEFORE="$(
  "${REHEARSAL_COMPOSE[@]}" exec -T postgres \
    psql -U tac -d tacbookings -Atqc \
    "SELECT count(*) FROM \"AuditLog\" WHERE action = 'MEMBER_INDUCTION_LEGACY_BASELINE_APPLIED';"
)"
[ "$REHEARSAL_AUDITS_BEFORE" = "0" ]

"${REHEARSAL_COMPOSE[@]}" run --rm migrate \
  ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
  --apply \
  "${REHEARSAL_BASELINE_ARGS[@]}" \
  --confirm-club-name "$REHEARSAL_CLUB_NAME" \
  --confirm-db-host "$REHEARSAL_DB_HOST" \
  --confirm-db-name "$REHEARSAL_DB_NAME" \
  --confirm-plan-digest "$REHEARSAL_PLAN_DIGEST" \
  --json | tee "$REHEARSAL_EVIDENCE_DIR/apply.txt"

grep -Eq '^Applied [1-9][0-9]* completed baseline row\(s\)\.$' \
  "$REHEARSAL_EVIDENCE_DIR/apply.txt"

"${REHEARSAL_COMPOSE[@]}" run --rm migrate \
  ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
  "${REHEARSAL_BASELINE_ARGS[@]}" \
  --json | tee "$REHEARSAL_EVIDENCE_DIR/verify-rerun.txt"

grep -Fqx '  CREATE: 0' "$REHEARSAL_EVIDENCE_DIR/verify-rerun.txt"
```

Query the audit again and require exactly one event. Retain the three safe
reports plus this count with the rehearsal record:

```bash
REHEARSAL_AUDITS_AFTER="$(
  "${REHEARSAL_COMPOSE[@]}" exec -T postgres \
    psql -U tac -d tacbookings -Atqc \
    "SELECT count(*) FROM \"AuditLog\" WHERE action = 'MEMBER_INDUCTION_LEGACY_BASELINE_APPLIED';"
)"
[ "$REHEARSAL_AUDITS_AFTER" = "1" ]
printf 'Trusted-baseline audit count after rehearsal: %s\n' "$REHEARSAL_AUDITS_AFTER" \
  > "$REHEARSAL_EVIDENCE_DIR/audit-count.txt"
```

The cleanup trap removes only containers, networks, and volumes selected by the
exact `REHEARSAL_COMPOSE` project/context above. It deliberately does not delete
the dump, environment file, protected inputs, or evidence: an interrupted run
may need those files for diagnosis, and evidence must be copied to the
rehearsal record before local deletion.

After copying the evidence to the rehearsal record, explicitly discard the
restored database and its volume, verify that the dedicated project has no
container or volume left, then disarm the fallback trap:

```bash
"${REHEARSAL_COMPOSE[@]}" down -v --remove-orphans

REHEARSAL_CONTAINERS_REMAINING="$("${REHEARSAL_COMPOSE[@]}" ps -aq)"
REHEARSAL_VOLUMES_REMAINING="$(
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$REHEARSAL_PROJECT_NAME"
)"
if [ -n "$REHEARSAL_CONTAINERS_REMAINING" ] ||
   [ -n "$REHEARSAL_VOLUMES_REMAINING" ]; then
  printf 'The dedicated rehearsal project still has containers or volumes; stop.\n' >&2
  exit 1
fi

REHEARSAL_TEARDOWN_COMPLETE=true
trap - EXIT INT TERM
```

Only after the evidence has been retained, the explicit teardown has been
verified, and the trap has been disarmed should the operator securely delete
the local rehearsal dump, rehearsal `.env`, and rehearsal input files. Delete
the local evidence directory only after its contents are confirmed in the
rehearsal record. A rehearsal is incomplete unless dry run, nonzero apply,
`CREATE: 0` rerun, one audit, evidence retention, and teardown all succeeded.

## 1. Run and retain the dry-run report

On a supported Compose deployment, use the verified variables above and repeat
the exact project, environment file, Compose file, and digest on the live
command. This uses the Compose-internal `postgres` hostname and does not publish
a new database port or require Node/npm on the host:

```bash
"${PRODUCTION_COMPOSE[@]}" run --rm migrate \
  ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
  "${BASELINE_ARGS[@]}" \
  --json
```

Do not substitute an unreviewed local image. Compose supplies `DATABASE_URL`
inside the container; do not override it on the command line or enable shell
tracing.

The date is a New Zealand date-only lodge date and cannot be later than the
current New Zealand date. The note is stored with the stable prefix
`Trusted legacy induction baseline:` on every new row, so choose wording that
remains meaningful as a permanent audit record.

The report displays only the parsed database host (including an explicit port)
and database name. It never displays the database URL, username, or password.
Do not paste a database URL or credentials into the note, a ticket, or the
retained report.

The prominent `PLAN DIGEST` is a versioned `sha256:<64 hex characters>` digest
of the complete plan, not of the formatted report. It binds the safe database
host and name; club, actor, date, and full stored provenance; active template
identity, name, version, and ordered section/item content; complete validated
age-tier settings; required sign-off count; and all four ordered member
categories, including existing induction IDs, kinds, statuses, and `N/A`
member IDs. Report mode and applied count are deliberately excluded, so an
unchanged dry run and its apply produce the same digest.

Review the digest, all four deterministic categories, and the per-age-tier
counts:

| Category | Meaning | Apply behaviour |
| --- | --- | --- |
| `CREATE` | Eligible member has no completed or open induction | Create one completed New Member baseline row |
| `ALREADY_COMPLETED` | Member has at least one completed induction of any kind | Preserve and skip |
| `OPEN_WORKFLOW` | Eligible member has a Draft or In Progress induction | Block the entire apply |
| `NOT_APPLICABLE` | In-scope `USER`/`ADMIN` member has the `N/A` age tier | Report only |

A member with both a completed row and an open row is reported as
`OPEN_WORKFLOW`; the open workflow must be resolved before apply. Voided rows
are preserved but do not make a member completed.

For each opaque member ID under `OPEN_WORKFLOW`, sign in to the admin site and
open `/admin/members/<member-id>` directly. That authenticated page lets you
verify whose ID it is without adding identity data to the CLI output. Then open
`/admin/induction`, search using the identity shown on the member page, and
complete or void the open workflow according to the evidence. Never append a
member's name or email to the retained CLI report; it intentionally contains
IDs only. After resolving blockers, restart the writer freeze and run a fresh
final dry run.

Stop if the club, database host, database name, population, template, date, or
provenance is not exactly what you expected. Resolve the discrepancy and
generate a fresh dry run. Do not edit a saved report and treat it as current.

## 2. Apply with exact confirmations

Use the exact effective club name, parsed host, database name, and plan digest
printed by the reviewed dry run. Put each value into a new protected one-line
file with the trusted editor; do not paste report content into executable shell
text.

```bash
vi -- "$INDUCTION_INPUT_DIR/confirm-club-name"
vi -- "$INDUCTION_INPUT_DIR/confirm-db-host"
vi -- "$INDUCTION_INPUT_DIR/confirm-db-name"
vi -- "$INDUCTION_INPUT_DIR/confirm-plan-digest"

for INPUT_FILE in \
  "$INDUCTION_INPUT_DIR/confirm-club-name" \
  "$INDUCTION_INPUT_DIR/confirm-db-host" \
  "$INDUCTION_INPUT_DIR/confirm-db-name" \
  "$INDUCTION_INPUT_DIR/confirm-plan-digest"
do
  if [ ! -f "$INPUT_FILE" ] || [ "$(wc -l < "$INPUT_FILE")" -ne 1 ]; then
    printf 'Expected exactly one newline-terminated line in %s\n' "$INPUT_FILE" >&2
    exit 1
  fi
done

IFS= read -r CONFIRM_CLUB_NAME < "$INDUCTION_INPUT_DIR/confirm-club-name"
IFS= read -r CONFIRM_DB_HOST < "$INDUCTION_INPUT_DIR/confirm-db-host"
IFS= read -r CONFIRM_DB_NAME < "$INDUCTION_INPUT_DIR/confirm-db-name"
IFS= read -r CONFIRM_PLAN_DIGEST < "$INDUCTION_INPUT_DIR/confirm-plan-digest"
if [ -z "$CONFIRM_CLUB_NAME" ] ||
   [ -z "$CONFIRM_DB_HOST" ] ||
   [ -z "$CONFIRM_DB_NAME" ] ||
   [ -z "$CONFIRM_PLAN_DIGEST" ]; then
  printf 'Apply confirmation files must not be empty.\n' >&2
  exit 1
fi
```

On the supported live deployment path, repeat the same verified digest and
exact Compose context on the apply itself:

```bash
"${PRODUCTION_COMPOSE[@]}" run --rm migrate \
  ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
  --apply \
  "${BASELINE_ARGS[@]}" \
  --confirm-club-name "$CONFIRM_CLUB_NAME" \
  --confirm-db-host "$CONFIRM_DB_HOST" \
  --confirm-db-name "$CONFIRM_DB_NAME" \
  --confirm-plan-digest "$CONFIRM_PLAN_DIGEST" \
  --json
```

All confirmations are case-sensitive, untrimmed, and exact. Apply takes the
`MemberInduction` table lock as its first database statement, then validates
and rebuilds the whole plan under that lock. Before checking the open-workflow
or no-op branches, and before any write, it requires the rebuilt digest to
equal `--confirm-plan-digest`. Direct DML already in progress finishes before
the locked read; direct DML that reaches the table later waits until apply
commits. The lock does **not** serialize earlier member creation, import,
approval, lifecycle, or configuration steps, which is why the operator freeze
is required. A timeout, lock error, changed club or database target, invalid
configuration, changed digest, or open workflow visible under the lock fails
the whole transaction.

Supply each mode and value flag exactly once. If apply is blocked or the plan
digest is stale and `--json` was requested, the command prints the refreshed
human report and safe JSON between the marker lines once, then exits nonzero.
It prints no credentials and writes nothing. Treat that as a failed apply,
review the change, and start again with a fresh dry run; do not feed a digest
from a failed apply directly into another apply.

Each created row is:

- kind `NEW_MEMBER`;
- status `COMPLETED`;
- completion source `ADMIN_OVERRIDE`;
- dated with the same supplied value for `inductionDate` and `completedAt`;
- attributed to the supplied Full Admin actor; and
- linked to the active New Member template version.

The command creates no assigned signers, sign-offs, emails, provider jobs, or
hut-leader side effects. Existing induction rows are never updated or deleted.
An audit entry containing the successful plan digest and all baseline rows
commit together.

## 3. Verify

Keep the writer freeze in place through this verification:

1. Retain the successful apply report with the committee authorisation record.
2. Open **Admin → Members → Induction** and spot-check members from every
   configured age tier.
3. Confirm the rows show New Member, Completed, the baseline date, and no
   signers or sign-offs.
4. Re-run the dry run with the same protected actor, date, and note. Repeat the
   verified digest and exact live Compose context:

   ```bash
   "${PRODUCTION_COMPOSE[@]}" run --rm migrate \
     ./node_modules/.bin/tsx --conditions=react-server scripts/induction-baseline.ts \
     "${BASELINE_ARGS[@]}" \
     --json
   ```

   It should report `CREATE: 0`; the applied members should now be
   `ALREADY_COMPLETED`. Its plan digest must differ from the pre-apply digest
   because the member categories changed.

Only after the verification dry run succeeds may the paused actor, member,
group-booking join, induction, and configuration writers resume.

The pre-apply digest is now stale and deliberately fails if reused. If an
authorised operator deliberately needs to prove the idempotent apply path, use
the exact digest from this fresh `CREATE: 0` verification dry run. That apply
is a no-op: it creates no induction row and no additional audit entry.

## Recovery and rollback

- Before commit, every failure rolls back the full apply. Correct the cause and
  start again with a fresh dry run.
- After commit, do not bulk-delete or edit induction history by hand. If one
  person was included on incorrect evidence, use the normal admin workflow and
  preserve an explanation in the audit trail. If the whole baseline was
  unauthorised or materially wrong, stop membership operations and agree a
  reviewed data-recovery plan with the repository owner; restoring the tested
  pre-run backup may be safer than inventing a reverse script.
- If apply reports `OPEN_WORKFLOW`, resolve those named records in the
  Induction Register rather than changing their database rows directly.
- If apply reports a plan-digest mismatch, retain the refreshed safe report,
  identify what changed, and start again with a fresh dry run. Never bypass the
  digest comparison or reuse the stale value.
- If config or template validation fails, fix it through the relevant admin
  settings page, then run dry-run again. Never weaken the guard to force an
  apply.
- If a database lock or transaction timeout occurs, confirm no induction
  maintenance is still running and retry from a fresh dry run. PostgreSQL
  rolls the failed transaction back.

## Related links

- Back to the [documentation hub](README.md).
- Operator guide: [Induction](guides/induction.md).
- Reference: [Lodge Induction Lifecycle](STATE_MACHINES.md#lodge-induction-lifecycle),
  [membership lifecycle invariants](invariants/membership-lifecycle.md),
  and [concurrency and locking](CONCURRENCY_AND_LOCKING.md).
