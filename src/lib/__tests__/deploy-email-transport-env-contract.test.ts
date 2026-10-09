import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
  The production deploy's step-3 preflight requires the email transport's
  credentials PER PROVIDER (fork booking-fixes). Until this change it demanded
  the AWS SES keys and the SNS topic unconditionally, so a club relaying
  through its own SMTP provider — `USE_SMTP_RELAY=true`, SES keys legitimately
  blank, exactly as CONFIGURATION.md documents — could not deploy at all.

  The rule the script now applies is the app's own
  (`resolveEmailDeliveryConfigFromEnv`, src/lib/email-delivery.ts): exactly one
  of USE_AWS_SES / USE_SMTP_RELAY / USE_LOCAL_CAPTURE true; none NAMED at all
  falls back to AWS SES; a flag named but false with no other true is refused.
  These pins read the script's source, the way the sibling
  `deploy-environment-role-contract` suite does, because the script cannot be
  imported. The behaviour was exercised by hand against nine fixture .env files
  (relay with blank SES keys, relay missing a key, SES blank, SES complete, no
  flags, explicit false only, two flags, capture on production, capture on a
  copy) when the change was made.
*/

const script = readFileSync(
  join(process.cwd(), "scripts", "run-production-blue-green-deploy.sh"),
  "utf8",
);

function functionBody(name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(start, `${name} must be defined in the deploy script`).toBeGreaterThan(0);
  const end = script.indexOf("\n}\n", start);
  expect(end, `${name} must have a closing brace`).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("the deploy requires email transport keys per provider", () => {
  it("invokes the transport check exactly once, inside validate_env_contract", () => {
    const call = "\n  require_email_transport_env_keys\n";
    expect(script.split(call).length - 1).toBe(1);
    expect(functionBody("validate_env_contract")).toContain(call);
  });

  it("no longer demands the SES keys unconditionally", () => {
    const contract = functionBody("validate_env_contract");
    for (const key of [
      "AWS_SES_ACCESS_KEY_ID",
      "AWS_SES_SECRET_ACCESS_KEY",
      "SES_SNS_TOPIC_ARN",
      "SMTP_HOST",
      "SMTP_PORT",
    ]) {
      expect(contract, `${key} must be required only inside the transport check`).not.toContain(
        `require_non_placeholder_env_key ${key}`,
      );
    }
    // EMAIL_FROM is provider-independent and stays where it was.
    expect(contract).toContain("require_non_placeholder_env_key EMAIL_FROM");
  });

  it("lives in the engine section and calls nothing nested inside the wrapper", () => {
    // Everything above `run_internal_blue_green_deploy` is nested inside
    // `run_production_wrapper`, which the `--internal-blue-green-deploy`
    // re-entry never calls — so a helper defined there (the wrapper's
    // `env_flag_is_true`) is "command not found" at step 3. That is exactly
    // how the first cut of this check failed on a live host.
    const engineStart = script.indexOf("run_internal_blue_green_deploy() {");
    expect(engineStart).toBeGreaterThan(0);
    expect(script.indexOf("require_email_transport_env_keys() {")).toBeGreaterThan(engineStart);
    expect(script.indexOf("env_file_flag_is_true() {")).toBeGreaterThan(engineStart);
    const body = functionBody("require_email_transport_env_keys");
    expect(body).not.toMatch(/(^|[^_])env_flag_is_true/);
    expect(body).toContain("env_file_flag_is_true ");
  });

  it("reads the three provider flags and requires each provider's own keys", () => {
    const body = functionBody("require_email_transport_env_keys");
    for (const flag of ["USE_AWS_SES", "USE_SMTP_RELAY", "USE_LOCAL_CAPTURE"]) {
      expect(body).toContain(`get_env_file_value ${flag}`);
    }
    for (const key of [
      "AWS_SES_ACCESS_KEY_ID",
      "AWS_SES_SECRET_ACCESS_KEY",
      "SES_SNS_TOPIC_ARN",
      "EMAIL_SERVER_HOST",
      "EMAIL_SERVER_PORT",
      "EMAIL_SERVER_USER",
      "EMAIL_SERVER_PASSWORD",
    ]) {
      expect(body).toContain(`require_non_placeholder_env_key ${key}`);
    }
  });

  it("refuses the two states the app refuses, in the app's words", () => {
    const body = functionBody("require_email_transport_env_keys");
    expect(body).toContain(
      "Only one of USE_AWS_SES, USE_SMTP_RELAY and USE_LOCAL_CAPTURE may be true",
    );
    expect(body).toContain("Exactly one email provider flag must be true");
    // A capture mailbox on the live site: refused at step 3, not at the
    // health check.
    expect(body).toContain("APP_ENVIRONMENT_ROLE");
    expect(body).toContain("USE_LOCAL_CAPTURE=true is refused on the club's live site");
  });
});
