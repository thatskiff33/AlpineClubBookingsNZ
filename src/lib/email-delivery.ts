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
 *
 * THE HOST NAME CAN STILL REFUSE THE DECLARATION, AND THAT IS NOT THE SAME RULE
 * (#3071 review, hoppers99). Granting capture mode on the strength of a host name
 * is the inference forbidden above; REFUSING it because the host is plainly a
 * public mail server is a validation of a declaration the operator has already
 * made, and it only ever moves the answer to the safer side. The asymmetry is the
 * whole point: no host name can turn a live relay into a capture, and no
 * declaration can turn `smtp.sendgrid.net` into one either.
 *
 * The hazard it closes was found on the one real staging deployment and no
 * fixture here reproduces it, because it needs an EXISTING relay configuration to
 * upgrade from. An installation already running `USE_SMTP_RELAY=true` against a
 * real relay, told by our own repair strings to "set `USE_LOCAL_CAPTURE=true`",
 * flips one flag and keeps `EMAIL_SERVER_HOST` pointed at the live relay. Before
 * this check the policy answered `allow` with grounds `non-production-capture`,
 * real mail went to real members, and the log recorded that the message had
 * reached nobody — a copy sending real mail while asserting it had not, which is
 * the exact defect class this epic exists to remove. See
 * {@link classifyCaptureHost}.
 */
type EmailDeliveryMode = "aws-ses" | "smtp-relay" | "local-capture";

/**
 * What a transport can DO, which is the only thing the delivery policy needs.
 *
 * `unresolved` is a third state rather than a default to `live-provider`, because
 * an unusable configuration is not evidence of anything and the policy must not
 * read it as an exemption.
 *
 * `capture-public-host` is a FOURTH state rather than folding into either
 * neighbour, and the reason is the same reason the delivery outcomes stay apart:
 * it is not `unresolved` (that means "nobody configured a transport", and this
 * deployment configured one very deliberately) and it is not `local-capture`
 * (that is the exemption this state exists to refuse). It carries its own
 * operator remedy — fix `EMAIL_SERVER_HOST`, or declare the host really is a sink
 * — and a state with its own remedy needs its own name.
 */
export type EmailTransportKind =
  | "live-provider"
  | "local-capture"
  | "capture-public-host"
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

/**
 * The name of the one escape hatch, so the refusal message and the tests spell it
 * once.
 */
export const CAPTURE_ALLOW_PUBLIC_HOST_FLAG = "EMAIL_CAPTURE_ALLOW_PUBLIC_HOST";

/**
 * Whether a declared capture host could be CHECKED to be a private address.
 *
 * `operator-declared-public` is kept apart from `private-address` because the two
 * carry different amounts of evidence and an operator surface that showed them as
 * one would be overstating the second. One was verified from the address itself;
 * the other is a person's word.
 */
export type CaptureHostVerdict =
  | "private-address"
  | "operator-declared-public"
  | "public-address"
  /**
   * `USE_LOCAL_CAPTURE=true` with no `EMAIL_SERVER_HOST` at all. Its own state,
   * because "there is nothing to check" and "what I checked is a public mail
   * host" carry different repairs, and reporting the second for the first would
   * be a false claim of exactly the kind this check was added to remove.
   */
  | "missing-host"
  | "not-applicable";

/**
 * Suffixes that cannot resolve to a host on the public internet, because the
 * relevant RFCs reserve them: RFC 6761 (`.localhost`, `.test`, `.invalid`,
 * `.example`, `.local`), RFC 8375 (`.home.arpa`).
 *
 * A closed list of RESERVED names, deliberately not a list of names that look
 * local. `.lan` and `.intranet` are conventions rather than reservations, so they
 * are absent — a convention is exactly what this module refuses to read, and an
 * operator using one has the escape hatch.
 */
const RESERVED_PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
];

/**
 * Whether every dot-separated label is a legal hostname label (RFC 1123: letters,
 * digits and inner hyphens, 1-63 characters).
 *
 * Checked because the "no dot means it cannot be a public FQDN" rule below is
 * only sound for something that IS a hostname. Without this, `EMAIL_SERVER_HOST`
 * set to a stray sentence would have no dot in it and would therefore have been
 * accepted as a private capture — harmless in practice, since it resolves
 * nowhere, but the check would have been reasoning about a string it had not
 * established was a host name at all. Unrecognised input is refused instead.
 */
function isHostnameShaped(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  return labels.every((label) =>
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

/** The four octets of a dotted-quad, or `null` when it is not one. */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 127) return true; // loopback, RFC 1122
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, RFC 3927
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space, RFC 6598
  return false;
}

/**
 * Whether a declared capture host is an address that cannot be a public mail
 * server, checked from the string alone.
 *
 * WHAT THIS PROVES, STATED HONESTLY, because overclaiming it would reintroduce
 * the very defect it fixes. It proves the host is not a public mail provider. It
 * does NOT prove the host forwards nothing onward: a Postfix on `127.0.0.1` or a
 * relay on `10.0.0.5` can happily deliver to the internet, and no string check
 * can see that. So this is a NECESSARY condition for a capture declaration and
 * never a sufficient one, every operator sentence about it says so, and the
 * declaration remains the thing that carries the guarantee.
 *
 * WHY A BARE SINGLE-LABEL NAME COUNTS AS PRIVATE. `mailpit` is what every capture
 * stack in this repository actually uses — the browser suite, the staging stack,
 * `.env.staging.example` and the measurement stack all set
 * `EMAIL_SERVER_HOST=mailpit` — because a Compose service name is how one
 * container reaches another. A name with no dot in it cannot be a public FQDN, so
 * accepting it costs nothing that a public relay could exploit. The stated limit
 * is a resolver search domain (`smtp` plus a search suffix of `sendgrid.net`),
 * which needs the host's own resolver configuration to collude and which no
 * string check could catch anyway.
 *
 * FAIL CLOSED ON ANYTHING UNRECOGNISED. An empty host, a malformed address, an
 * IPv6 form this does not parse — all `public-address`, because "I could not tell"
 * must never come out as "it is safe".
 */
export function classifyCaptureHost(
  rawHost: string,
): "private-address" | "public-address" {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return "public-address";

  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (literal.includes(":")) {
    // An IPv6 literal. Loopback, unique-local (fc00::/7) and link-local
    // (fe80::/10); anything else this does not recognise is refused.
    if (literal === "::1") return "private-address";
    if (/^f[cd]/.test(literal)) return "private-address";
    if (/^fe[89ab]/.test(literal)) return "private-address";
    return "public-address";
  }

  const ipv4 = parseIpv4(literal);
  if (ipv4) return isPrivateIpv4(ipv4) ? "private-address" : "public-address";

  // Everything below reasons about a HOST NAME, so establish that it is one.
  if (!isHostnameShaped(host)) return "public-address";

  if (host === "localhost") return "private-address";
  // No dot at all: a container/service name or a hosts-file entry, never a
  // public FQDN. See the docblock on why this is the load-bearing case.
  if (!host.includes(".")) return "private-address";
  if (RESERVED_PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "private-address";
  }
  return "public-address";
}

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
  /**
   * What the capture-host check found, `not-applicable` for every mode that is
   * not a declared capture.
   *
   * A FIELD RATHER THAN A STRING MATCH ON `issues`, for the same reason
   * `modeSource` is a field: a safety rule keyed on wording somebody may reword
   * is a rule that stops holding the day somebody rewords it.
   */
  captureHost: CaptureHostVerdict;
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
      captureHost: "not-applicable",
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

    /*
      THE CAPTURE HOST CHECK (#3071 review, hoppers99). Only for a DECLARED
      capture: `smtp-relay` is a live provider by classification, so its host is
      none of this module's business, and checking it would be the inference the
      module docblock forbids.

      It gates the whole configuration rather than only the send path, and that
      is deliberate. The VERIFY path — the health check and the setup wizard's
      SMTP test — reads `ok` and `issues`, so without this an operator would be
      told the connection is fine while every send was blocked, which is the
      claim-versus-reality gap this epic exists to close. Reporting one honest
      refusal in both places is the point.
    */
    let captureHost: CaptureHostVerdict = "not-applicable";
    if (mode === "local-capture") {
      const allowPublicHost = parseBooleanFlag(
        env,
        CAPTURE_ALLOW_PUBLIC_HOST_FLAG,
        issues,
      );
      if (!host) {
        /*
          NO HOST AT ALL IS NOT A PUBLIC HOST, and saying so would be the very
          thing this change exists to stop. "EMAIL_SERVER_HOST is missing" is
          already reported above, and it is the accurate repair; classifying this
          as `public-address` would additionally tell the operator their host
          "names a host on the public internet" when it names nothing, and would
          send them to the wrong remedy. The kind therefore stays an ordinary
          capture, exactly as it was before this check existed — the
          configuration is already `ok: false` with no transport options, so
          nothing can be sent either way.
        */
        captureHost = "missing-host";
      } else if (classifyCaptureHost(host) === "private-address") {
        captureHost = "private-address";
      } else if (allowPublicHost === true) {
        captureHost = "operator-declared-public";
      } else {
        captureHost = "public-address";
        issues.push(
          `USE_LOCAL_CAPTURE=true declares that EMAIL_SERVER_HOST is a capture mailbox that forwards mail nowhere, but it is set to a host on the public internet. Refused: a copy pointed at a real relay would email the club's real members while every log line said the message reached nobody. Point EMAIL_SERVER_HOST at the capture itself (a container name such as mailpit, localhost, or a private address), or set USE_SMTP_RELAY=true instead if this host really does deliver mail. If that host genuinely is a sink that forwards nothing and simply has a public name, declare ${CAPTURE_ALLOW_PUBLIC_HOST_FLAG}=true — only do that if you have checked it cannot deliver onward, because nothing else can check it for you.`,
        );
      }
    }

    return {
      ok: issues.length === 0,
      mode,
      modeSource,
      modeLabel:
        mode === "local-capture" ? CAPTURE_TRANSPORT_MODE_LABEL : "SMTP Relay",
      captureHost,
      issues,
      warnings,
      transportOptions:
        host &&
        port !== null &&
        user &&
        pass &&
        captureHost !== "public-address"
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
    captureHost: "not-applicable",
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
    captureHost: config.captureHost,
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

        IT NOW NAMES `EMAIL_SERVER_HOST` (#3071 review, hoppers99). The previous
        wording said "declare USE_LOCAL_CAPTURE=true" and stopped there, which
        reads as one flag flip to an operator who ALREADY has a working relay
        configured — and flipping it alone leaves `EMAIL_SERVER_HOST` pointed at
        that live relay. Advice that has to work has to name the setting the
        reader must also change.
      */
      "No email provider flag is set (USE_AWS_SES, USE_SMTP_RELAY, USE_LOCAL_CAPTURE). This installation is not confirmed to be the club's live site, so it will not fall back to live AWS SES. Set exactly ONE of them: USE_AWS_SES or USE_SMTP_RELAY for a site that really sends, or USE_LOCAL_CAPTURE=true for a copy relaying into a capture mailbox that forwards mail nowhere — and if you set that one, point EMAIL_SERVER_HOST at the capture itself, because setting the flag while EMAIL_SERVER_HOST still names a real relay is refused rather than obeyed. A copy pointed at an ordinary SMTP relay still counts as a live provider and has every send held back. If this IS the club's live installation, declare APP_ENVIRONMENT_ROLE=production instead.",
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
  if (config.mode === "local-capture") {
    // A capture declared against a public host is NOT a capture. It reports its
    // own kind so the policy can refuse it with its own remedy instead of
    // borrowing `unresolved`'s, which would tell an operator who configured a
    // transport very deliberately that they had configured none.
    return config.captureHost === "public-address"
      ? "capture-public-host"
      : "local-capture";
  }
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
