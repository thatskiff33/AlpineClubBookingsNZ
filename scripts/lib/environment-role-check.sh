# shellcheck shell=bash
#
# The live-site environment-role check (ENV-SAFETY 1, #3034; INV-CONFIG-003),
# shared by every documented way of standing up the club's live site (#4980).
#
# SOURCED, NEVER RUN, after scripts/lib/compose-env-file.sh, whose readers it
# uses. Two callers, one definition:
#
# - scripts/run-production-blue-green-deploy.sh calls
#   `require_environment_role_env_key` at step 3 of 20, inside
#   `validate_env_contract`, before the migration and the cutover;
# - scripts/check-environment-role.sh calls it before First Bootstrap's first
#   `docker compose up`.
#
# Before #4980 it lived only in the deploy script, so First Bootstrap, which
# never runs that script, brought a live site up from `.env.example`'s
# `non-production` without anything saying no. `deploy-environment-role-contract`
# pins that this file is the only definition and that both callers reach it.
#
# Both callers run it with `.env` in the working directory.

# The #3034 check's pattern for one key: the shared grammar in compose-env-file.sh, for exactly
# that key. Deliberately scoped to the role check rather than by changing
# `get_env_file_value`, which every other `require_*_env_key` shares and which is
# not this issue to change.
environment_role_env_pattern() {
  env_assignment_pattern "$1"
}

# How many lines in .env assign this key.
#
# `grep -c` prints 0 and EXITS 1 when nothing matches, which under `set -e` would
# abort inside the assignment, so the status is discarded and the count kept.
count_environment_role_env_assignments() {
  local key="$1"
  local pattern

  # Built first and checked, so a refused key aborts rather than handing `grep`
  # an empty pattern, which matches every line.
  pattern="$(environment_role_env_pattern "$key")" || return 1
  grep -cE "$pattern" .env || true
}

# The #3034 role check's reader: the shared one in compose-env-file.sh, kept under the name the
# role check and its contract test use.
environment_role_env_value() {
  compose_env_file_value "$1"
}

# The deployment's declaration of what this installation IS (ENV-SAFETY 1, #3034;
# epic #2986; INV-CONFIG-003).
#
# EVERY CALLER STANDS UP THE CLUB'S LIVE SITE AND NOTHING ELSE, so it requires
# exactly `production`. That is narrower than the application parser, which
# accepts `production` OR `non-production`, and the difference is the whole point.
# There is no staging mode here, no `--env` switch and no alternate path: a
# non-production stack goes through `docker-compose.staging.yml` and
# `scripts/e2e-stack.sh`, which declare `non-production` themselves. A script
# whose only job is the live site accepting a declaration that says "this is a
# copy" would be accepting the one value it can prove is wrong.
#
# THAT IS NOT A THEORETICAL HOLE, it is the likeliest operator error. `.env.example`
# ships `APP_ENVIRONMENT_ROLE=non-production` — correct there, because it is a
# local-development template and a template that shipped `production` would have a
# developer's laptop declaring itself live. But `.env.example` is ALSO the file an
# operator diffs against their real `.env` when upgrading, and "a new key appeared
# in the template, copy it across" is the normal upgrade move. Following that
# through: the deploy passes, the migration runs, the new colour boots and resolves
# NON_PRODUCTION, and then every confirmation, payment notice, waitlist offer and
# renewal reminder for the club's REAL members is safety-suppressed — and every
# application-managed contact on the club's REAL Xero organisation has its email
# address rewritten to a non-deliverable one (INV-CONFIG-005). Destructive edits to
# live accounting, made confidently, by the very mechanism this epic added to keep
# members safe.
#
# So the safe-looking value is the unsafe outcome HERE, and only here. The correct
# pairing is `non-production` in the template (safe by default on a laptop) and
# `production` required at the one place that knows it is deploying production.
#
# WHY IT IS A HARD REFUSAL AND WHY IT RUNS IN THE PREFLIGHT. From this release on,
# an installation that has not declared itself resolves UNKNOWN, and UNKNOWN fails
# closed: nothing whose safety depends on knowing whether these are the club's real
# members goes out. An existing production install upgrading into this release has
# no declaration, so without this check the upgrade would succeed and then quietly
# stop sending mail — the outcome epic #2986 explicitly forbids shipping. Refusing
# at step 3 of 20 means the old colour is still serving, the migration has not run
# (step 13) and nothing has been switched (step 17): the operator fixes one line in
# .env and re-runs. `deploy-environment-role-contract.test.ts` pins that ORDER, not
# merely this function's existence, because moving the check after step 13 or step
# 14 brings the forbidden outcome straight back.
#
# The comparison is case-folded after trimming, exactly as
# `src/lib/environment-role-declaration.ts` folds it, so the deploy gate and the
# application cannot disagree about what counts as declared. A near miss is
# refused rather than guessed at: `prod`, `staging`, `true` and APP_RUNTIME_ROLE's
# own values are all rejected, because guessing is how a typo becomes "production".
require_environment_role_env_key() {
  local key="APP_ENVIRONMENT_ROLE"
  local value
  local normalised
  local occurrences
  local exported_normalised

  # NOT `require_env_key` and NOT `get_env_file_value`, which is the fix for a
  # second review finding rather than a refactor. Those read the first line whose
  # whole first `=`-field is the key, so an indented or `export `-prefixed entry
  # was reported as a MISSING .env entry for a key plainly present in the file —
  # and a quoted value was refused as unrecognised — while Compose resolved all
  # three to `production`. All three were fail-closed, but "missing" for a visible
  # key is what gets an operator editing the wrong line under deploy pressure.
  occurrences="$(count_environment_role_env_assignments "$key")"
  if [ "$occurrences" -eq 0 ]; then
    echo "Missing required .env entry: $key" >&2
    echo "It declares whether this installation is the club's live site or a copy," >&2
    echo "and nothing infers it: an undeclared installation resolves UNKNOWN and" >&2
    echo "holds back member email and Xero writes until it is declared." >&2
    echo "Add APP_ENVIRONMENT_ROLE=production to this deployment's .env, then re-run." >&2
    echo "See docs/guides/environment-role.md." >&2
    echo "This is NOT APP_RUNTIME_ROLE, which names the container slot (web-blue, cron-leader)." >&2
    return 1
  fi

  # A DUPLICATED KEY IS REFUSED, because Compose and any first-match reader would
  # take different lines: Compose's dotenv parsing is LAST-WINS. A duplicate is
  # always an operator mistake, so it is refused outright rather than silently
  # resolved in either direction — taking last-wins here would agree with Compose
  # but would also quietly bless a file that says two different things about the
  # most consequential setting in it. The count above sees every shape Compose
  # accepts, including the indented and `export `-prefixed ones a `-F=` field
  # comparison missed.
  if [ "$occurrences" -gt 1 ]; then
    echo ".env entry $key appears $occurrences times. Leave exactly one." >&2
    echo "Docker Compose resolves the LAST one, so a file that says production" >&2
    echo "on one line and non-production on another hands every container the" >&2
    echo "value — which is how a live site would come up believing it is a copy." >&2
    return 1
  fi

  value="$(environment_role_env_value "$key")"
  if [ -z "$value" ]; then
    echo ".env entry $key is present but empty, so Compose would hand the" >&2
    echo "containers an empty value and the app would resolve UNKNOWN." >&2
    echo "Set APP_ENVIRONMENT_ROLE=production in this deployment's .env, then re-run." >&2
    return 1
  fi
  normalised="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  # A SHELL-EXPORTED VALUE BEATS THE FILE IN COMPOSE'S OWN PRECEDENCE, so a stale
  # `export APP_ENVIRONMENT_ROLE=non-production` left in the invoking shell, a
  # systemd unit or a restore-rehearsal script would override a correct .env and
  # this gate would never see it. That is not hypothetical for the deploy script: it
  # already exports GIT_COMMIT_SHA / KNOWLEDGE_BUNDLE_OBSERVED_AT / RELEASE_ID
  # for compose to forward, and it does not sanitise the caller's environment.
  #
  # Compared case-folded and trimmed, the same fold the file value gets, so a
  # harmless `PRODUCTION` in the shell is not reported as a disagreement. Both
  # values are named in the refusal, because "they disagree" without saying which
  # said what is not something an operator can act on.
  if [ -n "${APP_ENVIRONMENT_ROLE+x}" ]; then
    exported_normalised="$(
      printf '%s' "$(trim_whitespace "${APP_ENVIRONMENT_ROLE:-}")" |
        tr '[:upper:]' '[:lower:]'
    )"
    if [ "$exported_normalised" != "$normalised" ]; then
      echo "$key disagrees between this shell and .env, and Docker Compose would" >&2
      echo "take the SHELL value. Refusing rather than deploying the one you did" >&2
      echo "not edit." >&2
      echo "  exported in this shell: $(printable_deploy_value "${APP_ENVIRONMENT_ROLE:-}")" >&2
      echo "  in .env:                $(printable_deploy_value "$value")" >&2
      echo "Run 'unset $key' in this shell (and remove it from whatever exported" >&2
      echo "it — a systemd unit, a wrapper script, a restore rehearsal), then" >&2
      echo "re-run so the .env is the only source." >&2
      return 1
    fi
  fi

  if [ "$normalised" != "production" ]; then
    echo ".env entry $key must be exactly production for this script (got: $(printable_deploy_value "$value"))" >&2
    echo "This script deploys the club's LIVE site. There is no staging mode here." >&2
    if [ "$normalised" = "non-production" ]; then
      echo "The value says this installation is a COPY. Deploying it would suppress" >&2
      echo "real members' email and, once Xero containment lands, rewrite the email" >&2
      echo "addresses on the club's real accounting contacts. Refusing." >&2
      echo "If you copied this line from .env.example, that template is for a local" >&2
      echo "checkout: production deployments set production here." >&2
    else
      echo "It declares whether this installation is the club's live site or a copy," >&2
      echo "and nothing infers it: an undeclared installation resolves UNKNOWN and" >&2
      echo "holds back member email and Xero writes until it is declared." >&2
    fi
    echo "Set APP_ENVIRONMENT_ROLE=production in this deployment's .env, then re-run." >&2
    echo "Non-production stacks use docker-compose.staging.yml, which declares" >&2
    echo "non-production itself. See docs/guides/environment-role.md." >&2
    echo "This is NOT APP_RUNTIME_ROLE, which names the container slot (web-blue, cron-leader)." >&2
    return 1
  fi

  # The canonical, validated answer, for the step-3 checks that depend on it
  # (the email transport's capture refusal) — so none re-reads or re-folds it.
  VALIDATED_ENVIRONMENT_ROLE="$normalised"

  # Belt and braces now that the two agree: drop the variable from this shell so
  # the .env is the ONLY source Compose can read it from. Nothing else in the
  # deploy script reads it, and the value is re-verified from each container's own
  # self-report at step 14 (`assert_runtime_identity`), before the cutover.
  unset APP_ENVIRONMENT_ROLE
}
