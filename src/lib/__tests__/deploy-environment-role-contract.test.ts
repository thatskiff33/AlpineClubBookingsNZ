import { describe, expect, it } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import {
  appServiceNames,
  BASE_COMPOSE,
  COMPOSE_FILENAME,
  composeFiles,
  composeServices,
  NON_APP_COMPOSE_SERVICES,
  readRepoFile,
} from "@/lib/__tests__/helpers/compose";

/**
 * The production-upgrade path for the environment declaration (ENV-SAFETY 1,
 * #3034; epic #2986; INV-CONFIG-003).
 *
 * THIS IS THE PART THE EPIC IS JUDGED ON. Before this release an installation
 * needed no declaration; after it, an installation without one resolves UNKNOWN
 * and fails closed. So the plain upgrade of an existing production install would,
 * left alone, succeed and then quietly stop sending mail to members — which
 * #2986 explicitly forbids shipping. The controlled path is that a production
 * deploy CANNOT COMPLETE without the declaration, so the failure is a loud
 * refusal BEFORE anything changes rather than a silent outage after.
 *
 * `scripts/run-production-blue-green-deploy.sh` cannot be executed here — it
 * needs a production host, Docker and a live release — so its CONTRACT is
 * asserted from the source, the convention
 * `deploy-warmup-gate-script-contract.test.ts` and
 * `deployment-image-contracts.test.ts` already use for deploy scripts.
 *
 * THE ORDER IS THE POINT, not the validator's mere existence. Measured on this
 * script:
 *
 *   step  3/20  validate_env_contract        <- the new declaration check
 *   step 12/20  schema vs committed migrations
 *   step 13/20  prisma migrate deploy        <- the table starts existing
 *   step 14/20  the target web service starts <- first new-code process boots
 *   step 15/20  cron leader recreated
 *   step 17/20  Caddy cutover                <- traffic moves
 *
 * That gives the chain in both directions. An undeclared production upgrade
 * aborts at step 3 with the old colour still serving, nothing migrated and
 * nothing switched. And no new-code process can boot against a database lacking
 * `EnvironmentSafetySettings`, because the migration is ten steps before the
 * first start. Move the env check after step 13 and an abort leaves the schema
 * already changed; move it after step 14 and the "silently suppresses live
 * service" outcome the epic forbids comes straight back. Hence the offsets below.
 *
 * `test:related` cannot select this file: it reads shell and YAML from disk, so
 * it has no import edge to any of them (`docs/TESTING.md`).
 *
 * The Compose discovery and parsing this file uses live in
 * `helpers/compose.ts`, shared with `env-delivery-census.test.ts` — every hard
 * lesson in that parser was learned by a probe defeating it, and a second copy
 * would be the copy that drifts.
 */

const script = readRepoFile("scripts/run-production-blue-green-deploy.sh");
const compose = readRepoFile(BASE_COMPOSE);
const stagingCompose = readRepoFile("docker-compose.staging.yml");
const envExample = readRepoFile(".env.example");
const stagingEnvExample = readRepoFile(".env.staging.example");
const instrumentation = readRepoFile("src/instrumentation.node.ts");

/**
 * A shell function's bounds in the script, from its opening brace to the next
 * top-level `}`.
 *
 * BOUNDING IS THE WHOLE POINT, and getting it wrong cost this file a real
 * assertion (#3034 review). The ordering case below used to search for the
 * validator's CALL from `validate_env_contract`'s opening brace **to the end of
 * the file**, so a mutant that deleted the call from step 3 and inserted it into
 * `verify_prisma_migration_status()` — which runs at step 13, AFTER
 * `prisma migrate deploy` — still satisfied it. Measured: all four ordering
 * assertions passed against that mutant. A docblock saying THE ORDER IS THE
 * POINT does not make a test discriminate order.
 */
function functionBounds(name: string): { start: number; end: number } {
  const start = script.indexOf(`${name}() {`);
  expect(start, `${name} must be defined in the deploy script`).toBeGreaterThan(0);
  const end = script.indexOf("\n}\n", start);
  expect(end, `${name} must have a closing brace`).toBeGreaterThan(start);
  return { start, end };
}

/** {@link functionBounds}, as the text between them. */
function functionBody(name: string): string {
  const { start, end } = functionBounds(name);
  return script.slice(start, end);
}

/** The role validator's own body — five cases below read it. */
function validatorBody(): string {
  return functionBody("require_environment_role_env_key");
}

/**
 * Where the validator is CALLED, and nowhere else.
 *
 * Two spaces of indentation and nothing else on the line, which is a call rather
 * than the definition (column 0) or a mention in a comment (`#`). Asserted to be
 * unique, so the check cannot be added to a second, later function while the
 * step-3 one is quietly deleted.
 */
function soleValidatorInvocation(): number {
  const call = "\n  require_environment_role_env_key\n";
  const occurrences = script.split(call).length - 1;
  expect(
    occurrences,
    "require_environment_role_env_key must be invoked exactly once, in validate_env_contract",
  ).toBe(1);
  return script.indexOf(call) + 1;
}

/** The offset of a `step "N/20" "…"` line, or -1. */
function stepOffset(number: number): number {
  const match = script.indexOf(`step "${number}/20"`);
  return match;
}

describe("the deploy refuses an undeclared production release", () => {
  it("invokes the check INSIDE validate_env_contract, not merely after it", () => {
    // Defined AND invoked. A helper nothing calls is a comment — and a helper
    // invoked from some LATER function is worse than a comment, because it reads
    // as protection while running after the migration.
    const definition = functionBounds("require_environment_role_env_key");
    const contract = functionBounds("validate_env_contract");
    const invocation = soleValidatorInvocation();

    expect(contract.start).toBeGreaterThan(definition.start);
    // The bound that does the work: strictly inside the contract validator's
    // body. This is what the previous unbounded search let through.
    expect(invocation).toBeGreaterThan(contract.start);
    expect(invocation).toBeLessThan(contract.end);
  });

  it("requires exactly `production`, because this script only ever deploys the live site", () => {
    /*
      THE NARROWEST AND MOST IMPORTANT ASSERTION IN THIS FILE (#3034 review).
      The application parser accepts `production` OR `non-production`; this
      script must accept only the first. It has no staging mode, no `--env`
      switch and no alternate path — a non-production stack goes through
      `docker-compose.staging.yml` and `scripts/e2e-stack.sh` — so a declaration
      saying "this is a copy" is the one value it can prove is wrong.

      And it is the likeliest operator error, not a theoretical one.
      `.env.example` ships `non-production` (correct there: a template shipping
      `production` would have a laptop declaring itself live), and `.env.example`
      is also the file an operator diffs against their real `.env` when
      upgrading. Copying the value across would pass a gate that accepted both,
      migrate, boot, resolve NON_PRODUCTION — and then suppress every real
      member's email AND rewrite the email addresses on the club's real Xero
      contacts (INV-CONFIG-005). The safe-LOOKING value is the unsafe outcome
      here, and only here.
    */
    const body = validatorBody();

    // Case-folded after trimming, the same rule `readEnvironmentRoleDeclaration`
    // applies, so the gate and the app cannot disagree about what counts as set.
    expect(body).toContain("tr '[:upper:]' '[:lower:]'");

    // The condition is a SINGLE comparison against `production`. Not an
    // alternation that also admits `non-production` — that WAS the first draft,
    // and it is the hole this case exists to keep closed.
    expect(body).toContain('if [ "$normalised" != "production" ]; then');
    expect(body).not.toContain('!= "non-production"');

    /*
      `non-production` may appear only inside the refusal, explaining itself —
      never in the condition that decides whether to refuse.

      Asserted over the guard LINES rather than over "everything before the first
      `; then`" (#3034 review). That earlier form silently stopped meaning what it
      said the moment the function grew an earlier `if` — the duplicate-key and
      shell-export refusals below — because the slice then ended at THEIR `; then`
      and the case still passed while asserting nothing about the deciding
      comparison. Collecting every line that both tests `$normalised` and opens a
      block, and pinning the FIRST of them exactly, cannot drift that way: it
      fails if a second value is admitted by an alternation, and it fails if the
      explanatory `= "non-production"` branch is ever reordered above the refusal.
    */
    const normalisedGuards = body
      .split("\n")
      .filter((line) => /^\s*if \[ "\$normalised" (!=|=) /.test(line));
    expect(normalisedGuards[0]).toBe(
      '  if [ "$normalised" != "production" ]; then',
    );
    expect(normalisedGuards[0]).not.toContain("non-production");

    // It FAILS rather than warns.
    expect(body).toContain("return 1");
    // And it names the trap: the other variable that looks like it answers this.
    expect(body).toContain("APP_RUNTIME_ROLE");
  });

  it("tells an operator who declared non-production what it would have done", () => {
    // A refusal that only says "must be production" invites the operator to
    // wonder whether the gate is being fussy. Naming the consequence — real
    // members' email suppressed, real Xero contact addresses rewritten — is what
    // makes it obvious the value is wrong rather than the check.
    const body = validatorBody();
    expect(body).toContain('if [ "$normalised" = "non-production" ]; then');

    const branch = body.slice(body.indexOf('= "non-production"'));
    expect(branch).toContain("COPY");
    expect(branch.toLowerCase()).toContain("real members");
    expect(branch.toLowerCase()).toContain("xero");
    // And it explains where the wrong value most likely came from.
    expect(branch).toContain(".env.example");
    expect(body).toContain("docs/guides/environment-role.md");
  });

  it("keeps the undeclared case explained differently from the wrong-value case", () => {
    // Two quite different mistakes reach this refusal and they need different
    // instructions: "you have not set it" versus "you set it to the value that
    // says this is a copy".
    const body = validatorBody();
    expect(body).toContain("resolves UNKNOWN");
    expect(body).toContain("Set APP_ENVIRONMENT_ROLE=production");
    // The absent case is caught by its own `occurrences -eq 0` branch, which
    // fails before the value comparison — so an absent AND a wrong value both
    // abort. It used to lean on the shared `require_env_key`, which reported a
    // key present-but-indented as "missing" (#3034 second review).
    expect(body).toContain('if [ "$occurrences" -eq 0 ]; then');
  });

  it("points a non-production operator at the stack that is actually for them", () => {
    expect(validatorBody()).toContain("docker-compose.staging.yml");
  });

  it("names the variable the application actually reads", () => {
    // A gate demanding a variable nothing reads passes every deploy and protects
    // nothing, so the name comes from the module that parses it.
    expect(ENVIRONMENT_ROLE_ENV_VAR).toBe("APP_ENVIRONMENT_ROLE");
    const body = validatorBody();
    expect(body).toContain(`local key="${ENVIRONMENT_ROLE_ENV_VAR}"`);
  });

  it("runs the check at step 3, BEFORE the migration, the first boot and the cutover", () => {
    const envContract = stepOffset(3);
    const schemaCheck = stepOffset(12);
    const migrate = stepOffset(13);
    const targetStart = stepOffset(14);
    const cutover = stepOffset(17);

    for (const offset of [
      envContract,
      schemaCheck,
      migrate,
      targetStart,
      cutover,
    ]) {
      expect(offset).toBeGreaterThan(0);
    }

    /*
      `validate_env_contract` is CALLED in step 3's own block — between the
      `step "3/20"` line and the `step "4/20"` line, not merely somewhere in the
      forty lines that follow step 3. The old form sliced from step 3 all the way
      to step 12, which the string `validate_env_contract` satisfied even when the
      role check had been moved out of that function entirely (#3034 review).
    */
    const stepThreeBlock = script.slice(envContract, stepOffset(4));
    expect(stepThreeBlock).toContain("validate_env_contract");

    /*
      And the role check itself is textually above the step-12/13 blocks. A weak
      backstop rather than the load-bearing assertion — the case above is what
      pins the check inside `validate_env_contract` — but it is what would notice
      the whole validator being relocated below the migration steps.
    */
    expect(soleValidatorInvocation()).toBeLessThan(schemaCheck);
    expect(soleValidatorInvocation()).toBeLessThan(migrate);

    expect(envContract).toBeLessThan(schemaCheck);
    expect(schemaCheck).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(targetStart);
    expect(targetStart).toBeLessThan(cutover);
  });

  it("refuses a DUPLICATED key, which the file reader and Compose disagree about", () => {
    /*
      `get_env_file_value` awk-`exit`s on the FIRST match; Compose's dotenv
      parsing is LAST-WINS. So a .env holding `APP_ENVIRONMENT_ROLE=production`
      and, further down, `APP_ENVIRONMENT_ROLE=non-production` passed this gate
      and handed the containers the second value (#3034 review, measured against
      real `docker compose`). Refused outright rather than resolved last-wins: a
      duplicate is always an operator mistake, and silently agreeing with Compose
      would bless a file that says two different things about the most
      consequential setting in it.
    */
    const body = validatorBody();
    expect(body).toContain('count_environment_role_env_assignments "$key"');
    expect(body).toContain('if [ "$occurrences" -gt 1 ]; then');
    expect(body).toContain("return 1");
    // Scoped to this key. `get_env_file_value` is shared by every other
    // `require_*_env_key` and is deliberately not changed.
    expect(script).toContain("count_environment_role_env_assignments() {");
  });

  it("counts EVERY assignment shape Compose honours, not just an exact field", () => {
    /*
      The second review finding. The first version counted with `awk -F=` and
      `$1 == key`, which needs the key to be the whole first `=`-field — so an
      INDENTED line, an `export `-prefixed line and spaces around the `=` all
      slipped past, measured against real `docker compose`. Each of those as a
      SECOND line in a .env whose first line is correct passed the duplicate check
      and handed every container `non-production`.

      Behaviour is proved in the lane report by running the extracted helpers over
      nineteen .env fixtures against both the previous and the current script;
      what this case pins is the pattern, so the grammar cannot quietly narrow
      again.
    */
    const pattern = functionBody("environment_role_env_pattern");
    expect(pattern).toContain("^[[:space:]]*");
    expect(pattern).toContain("(export[[:space:]]+)?");
    expect(pattern).toContain("[[:space:]]*=");
    // Built from the key it is given, so there is one spelling of the name.
    expect(pattern).toContain("%s");
    expect(functionBody("count_environment_role_env_assignments")).toContain(
      "grep -cE",
    );
  });

  it("reads the value Compose would resolve, last-wins and unquoted", () => {
    /*
      The third finding, all of it fail-closed but misleading: `export ` and
      spaces around the `=` were reported as a MISSING .env entry for a key
      plainly present, and a quoted value was refused, while Compose resolved all
      three to `production`. "Missing" for a visible key is what gets an operator
      editing the wrong line under deploy pressure.
    */
    const reader = functionBody("environment_role_env_value");
    // Last-wins, matching Compose rather than the first-match reader every other
    // key uses.
    expect(reader).toContain("tail -n 1");
    // An inline comment, the same rule get_env_file_value applies elsewhere.
    expect(reader).toContain("[[:space:]]+#.*$");
    // One layer of matching surrounding quotes.
    expect(reader).toContain(`[ "$first" = "$last" ]`);

    // And the validator uses it instead of the shared first-match reader, which
    // is what makes the three shapes above stop aborting.
    const body = validatorBody();
    expect(body).toContain('environment_role_env_value "$key"');
    expect(body).not.toContain('get_env_file_value "$key"');
    expect(body).not.toContain('require_env_key "$key"');
    // An absent entry still aborts, with its own message rather than the shared
    // "Missing required .env entry" for a key that is genuinely absent.
    expect(body).toContain('if [ "$occurrences" -eq 0 ]; then');
    expect(body).toContain("Missing required .env entry");
    // A present-but-empty entry is its own case, because Compose would hand the
    // containers an empty value.
    expect(body).toContain('if [ -z "$value" ]; then');
  });

  it("refuses a shell-exported value that disagrees with .env", () => {
    /*
      Compose prefers a value exported in the invoking shell over the env file, so
      a stale `export APP_ENVIRONMENT_ROLE=non-production` in a shell, a systemd
      unit or a restore-rehearsal script overrode a correct .env and this gate
      never saw it. Not hypothetical for this script: it already exports
      GIT_COMMIT_SHA / KNOWLEDGE_BUNDLE_OBSERVED_AT / RELEASE_ID for compose to
      forward and does not sanitise the caller's environment.
    */
    const body = validatorBody();
    expect(body).toContain('if [ -n "${APP_ENVIRONMENT_ROLE+x}" ]; then');
    expect(body).toContain('if [ "$exported_normalised" != "$normalised" ]; then');
    // Both values are NAMED. "They disagree" is not something an operator can act
    // on without being told which said what.
    expect(body).toContain("exported in this shell:");
    expect(body).toContain("in .env:");
    // And once they agree, the file becomes the only source Compose can read.
    expect(body).toContain("unset APP_ENVIRONMENT_ROLE");
  });

  it("sanitizes the refused value before echoing it at a terminal", () => {
    /*
      The application reduces this same operator-supplied string to printable
      ASCII before it reaches a log line or a page
      (`sanitizeEnvironmentRoleRawValue`), because a value holding a newline or an
      escape sequence must not be able to write a second line into — or repaint —
      the terminal of the person reading the refusal. A shell echoing the raw
      value reopens that hole one layer out.
    */
    expect(script).toContain("printable_deploy_value() {");
    const sanitizer = functionBody("printable_deploy_value");
    // Control characters become `?` rather than being deleted, so the operator
    // can SEE something is in there, and the result is capped like the app's.
    expect(sanitizer).toContain("tr -c");
    expect(sanitizer).toContain("64");
    // Every echo of the value goes through it.
    const body = validatorBody();
    expect(body).toContain('printable_deploy_value "$value"');
    expect(body).not.toContain("(got: $value)");
  });

  it("applies the migration before the first new-code process starts", () => {
    // The other half of the chain: the table exists before anything reads it, so
    // the fail-closed "override unreadable" path cannot be reached by a correct
    // deploy of this release.
    const migrateStep = script.slice(stepOffset(13), stepOffset(14));
    expect(migrateStep).toContain('run --rm "$MIGRATE_SERVICE"');
    expect(migrateStep).toContain("verify_prisma_migration_status");
  });
});

describe("the deploy re-reads the declaration from the container itself", () => {
  /*
    WHY A SECOND CHECK AT ALL, when step 3 already validates `.env` (#3034
    review). The preflight validates the FILE; the containers receive whatever
    Compose RESOLVED, and those are different questions — Compose prefers a value
    exported in the invoking shell over the env file, and takes the LAST duplicate
    line rather than the first. Both of those are now refused explicitly in the
    preflight, but a gate that is only right while it models Compose's precedence
    correctly is one Compose release away from being wrong. So the value is read
    back from the process that actually got it.

    IT ASSERTS THE DECLARATION KIND, NOT THE EFFECTIVE ROLE. A correctly declared
    production installation whose administrator has switched the safer override on
    legitimately resolves NON_PRODUCTION; asserting the resolved role there would
    refuse a legitimate deploy.
  */
  it("expects exactly `production` from every container that runs app code", () => {
    expect(script).toContain(
      `EXPECTED_ENVIRONMENT_ROLE_DECLARATION="production"`,
    );
  });

  it("gets the answer from the APPLICATION, not from a second parser in shell", () => {
    /*
      THE FIX FOR THE FINDING THAT REPLACED THIS CASE, and the reason this file no
      longer greps a shell parser at all.

      This function used to parse APP_ENVIRONMENT_ROLE in shell, mirroring
      `readEnvironmentRoleDeclaration`, and the assertions here checked that
      mirror by searching its source text. A second review lens built six mutants
      of that snippet and FIVE survived these assertions — four of them making a
      container that declares `non-production` report `production`, so the deploy
      proceeded. Measured under busybox ash: widening `production)` to
      `*production*)`, defaulting the read to `:-production}`, sending the
      catch-all to `=production`, or adding `|staging` to the accepted branch.

      A duplicated parser pinned by greps drifts, and pre-cutover this was the
      SOLE witness — the application`s own parse was only asserted after the
      cutover, by `verify_external_health`. So the duplicate is gone: the
      pre-cutover witness is now the same endpoint the post-cutover check uses,
      whose `environmentRole` comes from `readEnvironmentRoleDeclaration` itself.
      There is nothing left to drift, which is why this case asserts an ABSENCE.
    */
    const payload = functionBody("get_service_runtime_payload");

    // It asks the application, on the container`s own loopback address.
    expect(payload).toContain("$DEPLOY_RUNTIME_STATUS_PATH");
    expect(payload).toContain("http://127.0.0.1:3000");
    expect(payload).toContain("x-cron-secret");

    // The secret comes from the CONTAINER`s environment, so it never appears in
    // the host`s process table the way an interpolated `docker compose exec`
    // argument would. `verify_external_health` takes the same care by feeding
    // curl its header on stdin.
    expect(payload).toContain("${CRON_SECRET:-}");
    expect(payload).not.toContain("get_env_file_value CRON_SECRET");
  });

  it("leaves NO shell-side mapping of a declaration to a kind, anywhere", () => {
    /*
      The guard that makes the class non-recurring: reintroducing a shell parser
      fails here, wherever in the script it is put. Only the four KIND names are
      searched for as assignments — `local expected_environment_role=` is a
      variable declaration, not a mapping, and must stay allowed.
    */
    for (const kind of ["production", "non-production", "absent", "invalid"]) {
      expect(
        script,
        `the deploy script must not map a declaration to "${kind}" itself; ` +
          `it asks /api/deploy/runtime-status, whose answer comes from ` +
          `readEnvironmentRoleDeclaration`,
      ).not.toContain(`environment_role=${kind}`);
    }
    // And no case-folding of the declaration in shell either, which is the other
    // half of a parser.
    expect(functionBody("get_service_runtime_payload")).not.toContain(
      `tr "[:upper:]" "[:lower:]"`,
    );
  });

  it("fails the deploy when a container reports anything else", () => {
    const assertion = functionBody("assert_runtime_identity");
    expect(assertion).toContain('local expected_environment_role="${5:-}"');
    expect(assertion).toContain('if [ -n "$expected_environment_role" ]');
    expect(assertion).toContain("environmentRole");
    expect(assertion).toContain("return 1");
  });

  it("checks it at step 14 — new colour up, old colour still serving", () => {
    /*
      THE ORDER IS THE POINT HERE TOO. Step 14 starts the target web service and
      step 17 switches Caddy, so a container that came up with the wrong
      declaration aborts the deploy while the previous release is still taking
      every request. Both verifiers pass the expectation; the INTERNAL one is the
      pre-cutover check, and its call sits inside step 14's block.
    */
    for (const verifier of ["verify_internal_health", "verify_external_health"]) {
      expect(functionBody(verifier)).toContain(
        '"$EXPECTED_ENVIRONMENT_ROLE_DECLARATION"',
      );
    }

    const targetStart = stepOffset(14);
    const cronRefresh = stepOffset(15);
    const cutover = stepOffset(17);
    expect(targetStart).toBeGreaterThan(0);
    expect(script.slice(targetStart, cronRefresh)).toContain(
      "verify_internal_health",
    );
    expect(targetStart).toBeLessThan(cutover);
  });
});

describe("every service that runs the app is given the declaration", () => {
  it("passes it through the shared app-environment anchor", () => {
    expect(compose).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${${ENVIRONMENT_ROLE_ENV_VAR}}`,
    );
  });

  it("gives it NO default, because a default is the inference this epic removes", () => {
    /*
      `${APP_ENVIRONMENT_ROLE:-production}` would be wrong for every fork and
      every restored copy, in the direction that emails the club's real members
      from a test system. `:-non-production` would be wrong for the live site, in
      the direction that silently stops its mail. There is no defensible default,
      which is why the variable is required instead.
    */
    expect(compose).not.toContain(`\${${ENVIRONMENT_ROLE_ENV_VAR}:-`);
    expect(compose).not.toContain(`\${${ENVIRONMENT_ROLE_ENV_VAR}:?`);
  });

  it("reaches the cron leader and both web slots through that anchor", () => {
    // Each app service merges `<<: *app-environment`; only `migrate` does not,
    // and it runs `prisma migrate deploy` with no application code.
    const anchorUsers = [...compose.matchAll(/<<: \*app-environment/g)].length;
    expect(anchorUsers).toBe(3);
    for (const slot of ["cron-leader", "web-blue", "web-green"]) {
      expect(compose).toContain(`APP_RUNTIME_ROLE: ${slot}`);
    }
  });

  it("leaves the migrate service without it, and says why", () => {
    const migrateBlock = compose.slice(compose.indexOf("\n  migrate:"));
    expect(migrateBlock).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${${ENVIRONMENT_ROLE_ENV_VAR}}`,
    );
    // Absent on purpose is only distinguishable from forgotten if it says so.
    expect(migrateBlock).toContain("deliberately ABSENT");
  });
});

describe("EVERY compose file that runs the app declares the role", () => {
  it("finds the compose files by scanning, not from a list in this test", () => {
    // The three that exist today. A new one appears here automatically, which is
    // the point: it then has to satisfy the cases below or fail.
    expect(composeFiles).toEqual([
      "docker-compose.staging.yml",
      "docker-compose.yml",
      "measurement/stack/docker-compose.measure.yml",
    ]);
  });

  it("scans Compose's own modern default filenames too", () => {
    /*
      `compose.yaml` and `compose.yml` are what `docker compose` looks for by
      default, and the first version of this census could not see them at all —
      the one fully SILENT defeat, because the assertion above still passed while
      a fourth file went unscanned. Asserted on the matcher rather than by
      planting a file, so nothing has to be written into the repository.
    */
    const matcher = COMPOSE_FILENAME;
    for (const name of [
      "compose.yaml",
      "compose.yml",
      "compose-e2e.yml",
      "compose.override.yaml",
      "docker-compose.yml",
      "docker-compose.staging.yml",
    ]) {
      expect(matcher.test(name), `${name} must be scanned`).toBe(true);
    }
    for (const name of ["decompose.yml", "compose.json", "notes-compose.md"]) {
      expect(matcher.test(name), `${name} must not be scanned`).toBe(false);
    }
  });

  it("parses a non-empty service set out of every file it scans", () => {
    /*
      The assertion that stops this census passing VACUOUSLY. A trailing comment
      on `services:`, an indentation other than two spaces, or a YAML anchor on a
      service key each made the parser return zero services — and zero services
      means zero things to check, silently. Now an unparsed file fails here.
    */
    for (const file of composeFiles) {
      expect(
        [...composeServices(file).keys()],
        `${file} parsed to no services at all, so nothing in it was checked`,
      ).not.toEqual([]);
    }
  });

  it("tolerates the YAML shapes that used to defeat the parser", () => {
    // Exercised on the real files rather than on synthetic text: the base file
    // has a column-0 anchor block above `services:` and a `migrate` service with
    // a profile, and the measure file carries trailing comments throughout.
    const base = composeServices(BASE_COMPOSE);
    expect([...base.keys()].sort()).toEqual([
      "app",
      "app_blue",
      "app_green",
      "caddy",
      "migrate",
      "postgres",
    ]);
    // Anchors and trailing comments on a key are accepted as keys.
    for (const line of ["  app: &app", "  app: # the cron leader", "    app:"]) {
      expect(
        line
          .trim()
          .match(/^([A-Za-z0-9_.-]+):\s*(&[A-Za-z0-9_.-]+)?\s*(#.*)?$/)?.[1],
      ).toBe("app");
    }
  });

  it("derives the app services from the base file's own anchor", () => {
    expect(appServiceNames()).toEqual(["app", "app_blue", "app_green"]);
  });

  it("names exactly four services as not running app code", () => {
    // Widening this set excuses a service from declaring, so it is pinned. Every
    // name in it must be a real service in the base file.
    expect([...NON_APP_COMPOSE_SERVICES].sort()).toEqual([
      "caddy",
      "mailpit",
      "migrate",
      "postgres",
    ]);
    const base = composeServices(BASE_COMPOSE);
    for (const name of NON_APP_COMPOSE_SERVICES) {
      if (name === "mailpit") continue; // staging/measure only
      expect(base.has(name), `${name} must be a real service`).toBe(true);
    }
  });

  it("makes every override file declare it LITERALLY on every app service", () => {
    /*
      The base file interpolates `${APP_ENVIRONMENT_ROLE}` with no default,
      because it is the file the club's live deployment uses and only the
      deployment can know. Every OTHER compose file exists to stand up something
      that is by construction NOT the live site — a staging stack, an E2E stack, a
      measurement harness — so each must hard-code `non-production` on every
      service it touches that runs app code. Interpolated is not good enough
      there: a stray value in whatever env file that stack is given must not be
      able to make it claim to be the club's live site.

      UNKNOWN SERVICES MUST DECLARE. The check is over everything that is not
      recognised infrastructure, not over a known list of app names, because a
      renamed service (`app_e2e:`) was silently excused by the name-list version.
    */
    const missing: string[] = [];

    for (const file of composeFiles) {
      if (file === BASE_COMPOSE) continue;
      const services = composeServices(file);
      expect([...services.keys()], `${file} parsed to no services`).not.toEqual(
        [],
      );
      for (const [name, body] of services) {
        if (NON_APP_COMPOSE_SERVICES.has(name)) continue;
        if (!body.includes(`${ENVIRONMENT_ROLE_ENV_VAR}: non-production`)) {
          missing.push(`${file} -> ${name}`);
        }
      }
    }

    expect(
      missing,
      `A compose service that is not recognised infrastructure does not declare ` +
        `${ENVIRONMENT_ROLE_ENV_VAR}. It inherits the base file's ` +
        `\${${ENVIRONMENT_ROLE_ENV_VAR}} with no default, so it resolves UNKNOWN ` +
        `and holds back member email and Xero writes. Add ` +
        `"${ENVIRONMENT_ROLE_ENV_VAR}: non-production" to each service listed, the ` +
        `way docker-compose.staging.yml does — or, if it genuinely runs no ` +
        `application code, add it to NON_APP_COMPOSE_SERVICES with a reason.`,
    ).toEqual([]);
  });

  it("never lets an override file interpolate the value", () => {
    for (const file of composeFiles) {
      if (file === BASE_COMPOSE) continue;
      expect(
        readRepoFile(file),
        `${file} must hard-code the role, not read it from an env file`,
      ).not.toContain(`${ENVIRONMENT_ROLE_ENV_VAR}: \${`);
    }
  });
});

describe("non-production targets declare themselves", () => {
  it("hard-codes non-production on the staging app service", () => {
    expect(stagingCompose).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: non-production`,
    );
    // Hard-coded, NOT interpolated from the env file: a stray value there must
    // not be able to make the staging/E2E stack claim to be the live site.
    expect(stagingCompose).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}: \${`,
    );
  });

  it("declares it in the staging env template and in CI's generated env file", () => {
    /*
      NOT what keeps the suite off the UNKNOWN path — that is
      `docker-compose.staging.yml`, which hard-codes the value on the `app`
      service and overrides anything an env file says. This case used to CLAIM
      otherwise in its own name ("so the suite never meets UNKNOWN"), which was
      false and would have sent the next reader to repair the wrong file (#3034
      review).

      What it actually pins is the absence of noise. The BASE compose file passes
      `${APP_ENVIRONMENT_ROLE}` through with no default, so an env file that omits
      the key makes Compose emit four "variable is not set" warnings on every
      invocation — measured on `docker compose -f docker-compose.yml -f
      docker-compose.staging.yml config` with the variable unset. A CI log full of
      warnings that mean nothing is how a warning that means something gets
      missed.
    */
    expect(stagingEnvExample).toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR}=non-production`,
    );

    /*
      CI does not use `.env.staging.example`: both e2e jobs WRITE `.env.staging`
      inline with a heredoc, so the template being right says nothing about them.
      Asserted per heredoc rather than once for the file, because the multi-lodge
      job's copy has drifted from the single-lodge job's before.
    */
    const workflow = readRepoFile(".github/workflows/e2e.yml");
    const heredocs = workflow.split("cat > .env.staging <<EOF").slice(1);
    expect(heredocs.length).toBe(2);
    for (const heredoc of heredocs) {
      const body = heredoc.slice(0, heredoc.indexOf("\nEOF"));
      expect(body).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=non-production`);
    }
  });

  it("ships the safe value in the local-development template", () => {
    expect(envExample).toContain(`${ENVIRONMENT_ROLE_ENV_VAR}=non-production`);
  });

  it("tells a production operator, in the template, that they must change it", () => {
    const start = envExample.indexOf("# Is this installation");
    expect(start).toBeGreaterThan(-1);
    const block = envExample.slice(start, envExample.indexOf("\n\n", start));
    expect(block).toContain("REQUIRED");
    expect(block).toContain("production | non-production");
    // The two things an operator gets wrong: assuming a default, and repairing
    // the neighbouring variable.
    expect(block).toContain("MUST set");
    expect(block).toContain("APP_RUNTIME_ROLE");
    expect(block).toContain("docs/guides/environment-role.md");
  });
});

/**
 * The boot advisory's own try-block, and nothing after it.
 *
 * Bounded at its `} catch {` because `register()` holds another `logger.info(`
 * further down — the cron-disabled line — and an unbounded slice silently reads
 * THAT one when the branch under test is deleted, turning a clear failure into a
 * confusing one. Measured while mutation-checking the case below.
 */
function bootAdvisoryBlock(): string {
  const start = instrumentation.indexOf(
    'const { resolveEnvironmentRole } = await import("./lib/environment-role")',
  );
  expect(start).toBeGreaterThan(0);
  const end = instrumentation.indexOf("\n    } catch {", start);
  expect(end).toBeGreaterThan(start);
  return instrumentation.slice(start, end);
}

describe("the boot advisory reaches the containers that serve traffic", () => {
  it("sits in the Node block that runs regardless of cron configuration", () => {
    /*
      The SECOND `NEXT_RUNTIME === "nodejs"` block returns early when
      CRON_ENABLED is false — which is exactly what app_blue and app_green set —
      so an advisory appended at the end of `register()` would never run on the
      web containers. Measured, not assumed: the offsets below are what pin it.
    */
    const advisory = instrumentation.indexOf(
      'const { resolveEnvironmentRole } = await import("./lib/environment-role")',
    );
    const cronBlock = instrumentation.indexOf("const cronEnabled =");
    const earlyReturn = instrumentation.indexOf(
      "Cron scheduling disabled for this app instance",
    );

    expect(advisory).toBeGreaterThan(0);
    expect(cronBlock).toBeGreaterThan(0);
    expect(earlyReturn).toBeGreaterThan(cronBlock);
    expect(advisory).toBeLessThan(cronBlock);
  });

  it("says so at INFO when the role is a confirmed copy, and names the source", () => {
    /*
      The one hole the deploy cannot close (owner decision, 23 Aug 2026): a site
      brought up by hand with `docker compose up` runs none of the deploy's checks,
      so a LIVE club installation wrongly declared a copy comes up and holds back
      mail its members are waiting for. Nothing about the DATA can tell that case
      from a legitimate copy — a copy is restored FROM production and contains the
      same real members — so the signal has to be somebody reading this line and
      knowing it is wrong. Which means it has to name WHICH source decided it, or
      the reader does not know whether to look at the `.env` or at
      /admin/environment.
    */
    const block = bootAdvisoryBlock();
    expect(block).toContain('resolution.role === "NON_PRODUCTION"');

    const nonProduction = block.slice(
      block.indexOf('resolution.role === "NON_PRODUCTION"'),
    );
    const call = nonProduction.slice(nonProduction.indexOf("logger."));
    const args = call.slice(0, call.indexOf("\n        );"));
    expect(call.startsWith("logger.info(")).toBe(true);
    expect(args).toContain("decidedBy");
    expect(args).toContain("database-safer-override");
    expect(args).toContain("APP_ENVIRONMENT_ROLE=production");
    expect(args).toContain("/admin/environment");
    // The refused value is operator text and never goes in a log line.
    expect(args).not.toContain("declaration.raw");
  });

  it("keeps that line at a level the log-noise measurement does not count", () => {
    /*
      MEASURED, not preferred (owner instruction). MC-09 in
      `measurement/current-main-refresh/run-log-noise.sh` fails any
      warning-or-error signature that repeats three times across the producer
      logs, and eight of that harness's eleven producers `--force-recreate app`
      INSIDE their own `docker logs --since` window — so a once-per-boot line is
      once per producer. Running `bin/analyse-log-noise.mjs` over eleven producer
      logs each holding this exact line: at level 40 it reports `count: 11` and
      throws `sustained/fatal log noise detected`; at level 30 it passes with zero
      classified lines.

      The analyser ALSO text-classifies a line by its WORDS, whatever its level,
      so the sentence itself has to avoid them — which is why it says "held back".

      THE THREE REGEXES BELOW ARE COPIED FROM THE ANALYSER, not paraphrased. A
      third review lens found the first version listed only
      error/failed/warning/exception/fatal and so missed `panic`, `uncaught`,
      `unhandled` and a BARE `warn`: measured, rewording the sentence to contain
      "unhandled" or "warn" trips MC-09 while that guard stayed green. Copying the
      patterns means the guard cannot drift from the thing it is protecting
      against, and a substring list cannot silently omit an alternative again.
    */
    const block = bootAdvisoryBlock();
    const nonProduction = block.slice(
      block.indexOf('resolution.role === "NON_PRODUCTION"'),
    );
    const call = nonProduction.slice(nonProduction.indexOf("logger."));
    const args = call.slice(0, call.indexOf("\n        );"));

    expect(call.startsWith("logger.info(")).toBe(true);

    // Verbatim from measurement/current-main-refresh/bin/analyse-log-noise.mjs.
    const ANALYSER_CLASSIFIERS: [string, RegExp][] = [
      ["fatal", /\b(fatal|panic|uncaught|unhandled)\b/],
      ["error", /\b(error|exception|failed)\b/],
      ["warning", /\bwarn(?:ing)?\b/],
    ];
    for (const [level, pattern] of ANALYSER_CLASSIFIERS) {
      const hit = args.toLowerCase().match(pattern);
      expect(
        hit?.[0] ?? null,
        `the copy-at-boot line contains a word analyse-log-noise.mjs classifies ` +
          `as ${level}, whatever the log level — so MC-09 would count it eleven ` +
          `times and fail. Reword it (say "held back", not "failed").`,
      ).toBeNull();
    }
  });

  it("logs at error level only for UNKNOWN, and never blocks startup", () => {
    const advisory = instrumentation.indexOf(
      'const { resolveEnvironmentRole } = await import("./lib/environment-role")',
    );
    const block = instrumentation.slice(advisory - 400, advisory + 6000);
    expect(block).toContain('resolution.role === "UNKNOWN"');
    expect(block).toContain("logger.error");
    // Its own try/catch — a configuration advisory that stops the site coming up
    // would be a worse fault than the one it reports.
    expect(block).toContain("} catch {");
    /*
      And it does NOT hard-code an instruction to set the variable. That reads
      like a missing assertion and is the fix: an UNKNOWN caused by an unreadable
      override has a perfectly correct APP_ENVIRONMENT_ROLE, and telling that
      operator to set it sends them to repair the one thing that is already
      right. The per-case instruction comes from `resolution.notes`, asserted in
      the case above; the notes' own content is asserted in
      environment-role-precedence.test.ts.
    */
    /*
      BOUNDED TO THE UNKNOWN BRANCH. This used to slice from `logger.error` to the
      end of the window, which stopped meaning anything the moment a second branch
      was added below it: the confirmed-copy line DOES say
      "set APP_ENVIRONMENT_ROLE=production", correctly, because there the variable
      IS the thing to change.
    */
    const unknownBranch = block.slice(
      block.indexOf("logger.error"),
      block.indexOf('resolution.role === "NON_PRODUCTION"'),
    );
    expect(unknownBranch.length).toBeGreaterThan(200);
    expect(unknownBranch).not.toContain(`Set ${ENVIRONMENT_ROLE_ENV_VAR}`);
    expect(unknownBranch).not.toContain(
      `${ENVIRONMENT_ROLE_ENV_VAR} does not say`,
    );
  });
});
