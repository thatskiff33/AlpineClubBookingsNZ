type EnvMap = Record<string, string | undefined>;

/**
 * The three transports, and why the third one exists (#3035).
 *
 * `local-capture` is an SMTP relay that an operator has DECLARED to be a capture
 * mailbox — mailpit in the E2E stack, MailHog, a developer's local sink. It reads
 * exactly the same `EMAIL_SERVER_*` settings as `smtp-relay`; the only difference
 * is the declaration, and the declaration is the whole point. A capture cannot
 * deliver onward, so a non-production installation may genuinely transmit into it
 * (see `environment-delivery-policy.ts`), which is what keeps the browser suite's
 * email specs working while nothing can reach a real member.
 *
 * IT IS NEVER INFERRED. "The host is called mailpit" is exactly the kind of
 * convention `INV-CONFIG-003` forbids one layer up, and it would be no safer one
 * layer down: a relay pointed at a host that happens to be named that way can
 * still deliver. `smtp-relay` therefore stays classified as a LIVE provider
 * however it is configured.
 */
type EmailDeliveryMode = "aws-ses" | "smtp-relay" | "local-capture";

/**
 * What a transport can DO, which is the only thing the delivery policy needs.
 *
 * `unresolved` is a third state rather than a default to `live-provider`, because
 * an unusable configuration is not evidence of anything and the policy must not
 * read it as an exemption.
 */
export type EmailTransportKind =
  | "live-provider"
  | "local-capture"
  | "unresolved";

/**
 * How the delivery mode was chosen (ENV-SAFETY 2, #3035).
 *
 * `implicit-legacy-default` is the one that matters: with NONE of `USE_AWS_SES`,
 * `USE_SMTP_RELAY` or `USE_LOCAL_CAPTURE` set, this parser resolves live AWS SES for backward
 * compatibility. That is a real hazard on anything that is not the club's live
 * site — a copy would connect to the club's live mail provider with the club's
 * live credentials — so the delivery boundary refuses it outside confirmed
 * production. It is reported as a FIELD rather than inferred from the warning
 * text, because a safety rule keyed on a string somebody may reword is a rule
 * that stops holding the day somebody rewords it.
 *
 * This module deliberately does NOT resolve the environment role itself. It is a
 * pure parser over an injected environment; the role belongs to
 * `resolveEnvironmentRole()` (INV-CONFIG-003), and a second reader of that
 * answer is what INV-CONFIG-003 forbids. The rule is applied by
 * {@link refuseAmbiguousImplicitSesDefault}, whose caller holds the role.
 */
export type EmailDeliveryModeSource =
  | "explicit-flag"
  | "implicit-legacy-default"
  | "unresolved";

/** Whether the legacy implicit AWS SES default may be used at all. */
export type ImplicitSesDefault = "permitted" | "refused";

/**
 * The label a resolved CAPTURE transport carries.
 *
 * Exported so `sendEmail` can recognise a capture send and say so at a level an
 * operator sees (#3035 review), rather than comparing against a copy of the
 * string. Two copies of a label used as a CONDITION is one rename away from a
 * silent behaviour change.
 */
export const CAPTURE_TRANSPORT_MODE_LABEL = "Local capture mailbox";

interface EmailTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface ResolvedEmailDeliveryConfig {
  ok: boolean;
  mode: EmailDeliveryMode | "invalid";
  modeSource: EmailDeliveryModeSource;
  modeLabel: string;
  issues: string[];
  warnings: string[];
  transportOptions: EmailTransportOptions | null;
}

function readEnv(env: EnvMap, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBooleanFlag(
  env: EnvMap,
  name: string,
  issues: string[],
): boolean | undefined {
  const raw = readEnv(env, name);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  issues.push(`${name} must be true or false`);
  return undefined;
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

export function resolveEmailDeliveryConfigFromEnv(
  env: EnvMap,
): ResolvedEmailDeliveryConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const useAwsSes = parseBooleanFlag(env, "USE_AWS_SES", issues);
  const useSmtpRelay = parseBooleanFlag(env, "USE_SMTP_RELAY", issues);
  const useLocalCapture = parseBooleanFlag(env, "USE_LOCAL_CAPTURE", issues);

  const selectedModes =
    Number(useAwsSes === true) +
    Number(useSmtpRelay === true) +
    Number(useLocalCapture === true);

  let mode: EmailDeliveryMode | "invalid" = "invalid";
  let modeSource: EmailDeliveryModeSource = "unresolved";
  if (selectedModes === 1) {
    mode =
      useAwsSes === true
        ? "aws-ses"
        : useSmtpRelay === true
          ? "smtp-relay"
          : "local-capture";
    modeSource = "explicit-flag";
  } else if (selectedModes === 0) {
    // Backward compatibility: if every flag is omitted, use legacy SES mode.
    if (
      useAwsSes === undefined &&
      useSmtpRelay === undefined &&
      useLocalCapture === undefined
    ) {
      mode = "aws-ses";
      modeSource = "implicit-legacy-default";
      warnings.push(
        "USE_AWS_SES/USE_SMTP_RELAY/USE_LOCAL_CAPTURE are not set. The club's live site still defaults to AWS SES for backward compatibility, but any other installation now refuses to open a mail transport at all — including the health check and the setup wizard's provider test — because a copy must never connect to the club's live mail provider by default. Set exactly one of them explicitly.",
      );
    } else {
      issues.push(
        "Exactly one email provider flag must be true (USE_AWS_SES, USE_SMTP_RELAY or USE_LOCAL_CAPTURE)",
      );
    }
  } else {
    issues.push(
      "Only one of USE_AWS_SES, USE_SMTP_RELAY and USE_LOCAL_CAPTURE may be true",
    );
  }

  const emailFrom = readEnv(env, "EMAIL_FROM");
  if (!emailFrom) {
    issues.push("EMAIL_FROM is missing");
  }

  if (mode === "aws-ses") {
    const host =
      readEnv(env, "SMTP_HOST") ?? "email-smtp.ap-southeast-2.amazonaws.com";
    const portRaw = readEnv(env, "SMTP_PORT");
    const port = parsePort(portRaw) ?? 587;
    const user = readEnv(env, "AWS_SES_ACCESS_KEY_ID");
    const pass = readEnv(env, "AWS_SES_SECRET_ACCESS_KEY");

    if (!user) issues.push("AWS_SES_ACCESS_KEY_ID is missing");
    if (!pass) issues.push("AWS_SES_SECRET_ACCESS_KEY is missing");
    if (portRaw && parsePort(portRaw) === null) {
      issues.push("SMTP_PORT must be a valid port number");
    }
    if (!readEnv(env, "SES_SNS_TOPIC_ARN")) {
      warnings.push(
        "SES_SNS_TOPIC_ARN is not set; SES bounce/complaint topic allowlisting is disabled",
      );
    }

    return {
      ok: issues.length === 0,
      mode,
      modeSource,
      modeLabel: "AWS SES",
      issues,
      warnings,
      transportOptions:
        user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  if (mode === "smtp-relay" || mode === "local-capture") {
    // The capture mode reads the SAME four settings: a capture mailbox IS an SMTP
    // relay, and duplicating four variables to say so would only invite them to
    // drift apart.
    const host = readEnv(env, "EMAIL_SERVER_HOST");
    const portRaw = readEnv(env, "EMAIL_SERVER_PORT");
    const port = parsePort(portRaw);
    const user = readEnv(env, "EMAIL_SERVER_USER");
    const pass = readEnv(env, "EMAIL_SERVER_PASSWORD");

    if (!host) issues.push("EMAIL_SERVER_HOST is missing");
    if (!portRaw) {
      issues.push("EMAIL_SERVER_PORT is missing");
    } else if (port === null) {
      issues.push("EMAIL_SERVER_PORT must be a valid port number");
    }
    if (!user) issues.push("EMAIL_SERVER_USER is missing");
    if (!pass) issues.push("EMAIL_SERVER_PASSWORD is missing");

    return {
      ok: issues.length === 0,
      mode,
      modeSource,
      modeLabel:
        mode === "local-capture" ? CAPTURE_TRANSPORT_MODE_LABEL : "SMTP Relay",
      issues,
      warnings,
      transportOptions:
        host && port !== null && user && pass
          ? {
              host,
              port,
              secure: false,
              auth: { user, pass },
            }
          : null,
    };
  }

  return {
    ok: false,
    mode,
    modeSource,
    modeLabel: "Not configured",
    issues,
    warnings,
    transportOptions: null,
  };
}

/**
 * The one issue the ambiguous-configuration hole in #3035 names: with neither
 * provider flag set this parser resolves LIVE AWS SES, so an installation that
 * is not the club's live site would open a transport to the club's own mail
 * provider using the club's own credentials.
 *
 * Confirmed production keeps the legacy default, because "production stays
 * behaviourally equivalent" is one of this issue's acceptance criteria and every
 * existing deployment relies on it. Everything else — a declared copy, and an
 * installation whose role nobody has declared — is refused, and the refusal
 * names the two flags so the repair is one line of deployment configuration.
 *
 * WHERE THIS ACTUALLY BITES, stated plainly rather than overclaimed. On the SEND
 * path the delivery policy has already suppressed or blocked before any transport
 * is asked for, so this refusal is defence in depth there — it is what stops a
 * future sender that somehow reached the transport. On the VERIFY path
 * (`verifyEmailTransport`, used by the health check and the setup wizard's
 * provider test) it is the operative rule: a `verify()` is a real connection to a
 * real provider with real credentials, and that is exactly what a copy must not
 * make by default.
 */
export function refuseAmbiguousImplicitSesDefault(
  config: ResolvedEmailDeliveryConfig,
  implicitSesDefault: ImplicitSesDefault,
): ResolvedEmailDeliveryConfig {
  if (
    implicitSesDefault === "permitted" ||
    config.modeSource !== "implicit-legacy-default"
  ) {
    return config;
  }
  return {
    ok: false,
    mode: "invalid",
    modeSource: config.modeSource,
    modeLabel: "Not configured",
    issues: [
      /*
        THE ADVICE HERE HAS TO BE ADVICE THAT WORKS (#3035 review). The first
        version said "Set exactly one of USE_AWS_SES or USE_SMTP_RELAY (a copy
        usually wants USE_SMTP_RELAY pointed at a local capture mailbox)". Follow
        that on a copy and the transport resolves `live-provider`, so the delivery
        policy suppresses every send — the operator has done exactly as told and
        nothing goes anywhere. It also named two of the three flags, and
        contradicted `describeDeliveryDecision` twenty lines away, which tells the
        same operator to declare `USE_LOCAL_CAPTURE`.

        This string matters more than most: on the VERIFY path it is the only
        thing an operator sees — the health check and the setup wizard's SMTP test
        both surface it verbatim.
      */
      "No email provider flag is set (USE_AWS_SES, USE_SMTP_RELAY, USE_LOCAL_CAPTURE). This installation is not confirmed to be the club's live site, so it will not fall back to live AWS SES. Set exactly ONE of them: USE_AWS_SES or USE_SMTP_RELAY for a site that really sends, or USE_LOCAL_CAPTURE=true for a copy relaying into a capture mailbox that forwards mail nowhere — a copy pointed at an ordinary SMTP relay still counts as a live provider and has every send held back. If this IS the club's live installation, declare APP_ENVIRONMENT_ROLE=production instead.",
      ...config.issues,
    ],
    warnings: config.warnings,
    transportOptions: null,
  };
}

/**
 * What the configured transport can DO, for the delivery policy.
 *
 * A pure classification of an already-resolved configuration, so the policy
 * consumes one canonical parser for the transport exactly as it consumes one
 * canonical resolver for the environment role, and neither reads an environment
 * variable of its own.
 */
export function emailTransportKindOf(
  config: ResolvedEmailDeliveryConfig,
): EmailTransportKind {
  if (config.mode === "local-capture") return "local-capture";
  if (config.mode === "invalid") return "unresolved";
  return "live-provider";
}

/**
 * {@link emailTransportKindOf} over the live environment.
 *
 * Deliberately NOT filtered through {@link refuseAmbiguousImplicitSesDefault}: the
 * question here is "what has this deployment declared its transport to be", and
 * the answer must not depend on the role, or the policy that decides the role
 * would be asking a question whose answer already assumed one.
 */
export function resolveEmailTransportKind(
  env: EnvMap = process.env,
): EmailTransportKind {
  return emailTransportKindOf(resolveEmailDeliveryConfigFromEnv(env));
}

export function resolveEmailDeliveryConfig(
  implicitSesDefault: ImplicitSesDefault,
): ResolvedEmailDeliveryConfig {
  return refuseAmbiguousImplicitSesDefault(
    resolveEmailDeliveryConfigFromEnv(process.env),
    implicitSesDefault,
  );
}
