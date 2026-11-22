// The mail transport's own timeouts (#5407 item 34): their one definition,
// read by the delivery parser in `email-delivery.ts`. A pure leaf module.

type EnvMap = Record<string, string | undefined>;

/**
 * How long one mail transport waits, in milliseconds (#5407 item 34), under
 * the names nodemailer reads. Every transport here is SMTP (AWS SES through
 * its SMTP endpoint, a relay, or a capture mailbox), so all three apply to
 * each of them.
 *
 * How the installed nodemailer (10.x, `smtp-connection`) applies them:
 * `connectionTimeout` is ONE deadline for the whole connection setup (the DNS
 * lookup, every address tried, the greeting and a STARTTLS upgrade together),
 * and the greeting and the upgrade each get the SMALLER of `greetingTimeout`
 * and what is left of that deadline. So the greeting value is a cap inside
 * the setup budget: it only matters when it is lower, and raising it above the
 * connection value changes nothing (the parser warns). `socketTimeout` is the
 * inactivity allowed on the open connection while waiting for the server.
 *
 * nodemailer's own defaults are a 2-minute setup budget, a 30-second greeting
 * cap and 10 minutes of inactivity. The bump-notice recovery assumes a send
 * finishes well inside an hour, so these are set here: 30 seconds for the
 * whole setup, 15 seconds for the greeting inside it, and 2 minutes of
 * inactivity, which a healthy server never meets.
 */
export interface EmailTransportTimeouts {
  /** The whole connection setup: DNS, connect, greeting and STARTTLS together. */
  connectionTimeout: number;
  /** A cap on the greeting (and on STARTTLS) inside the setup budget. */
  greetingTimeout: number;
  /** Inactivity allowed on the open connection, per wait. */
  socketTimeout: number;
}

/**
 * Each timeout's setting, default and accepted range: the one definition the
 * parser, `CONFIGURATION.md` and `.env.example` describe.
 */
export const EMAIL_TRANSPORT_TIMEOUT_SETTINGS = {
  connectionTimeout: { env: "EMAIL_SMTP_CONNECTION_TIMEOUT_MS", defaultMs: 30_000 },
  greetingTimeout: { env: "EMAIL_SMTP_GREETING_TIMEOUT_MS", defaultMs: 15_000 },
  socketTimeout: { env: "EMAIL_SMTP_SOCKET_TIMEOUT_MS", defaultMs: 120_000 },
} as const satisfies Record<keyof EmailTransportTimeouts, { env: string; defaultMs: number }>;

/** The accepted range for each timeout setting, in milliseconds. */
export const EMAIL_TRANSPORT_TIMEOUT_RANGE_MS = { min: 1_000, max: 600_000 } as const;

/**
 * The timeout options, in one order, for a caller that lists them (the
 * transport cache key).
 */
export const EMAIL_TRANSPORT_TIMEOUT_OPTIONS = Object.keys(
  EMAIL_TRANSPORT_TIMEOUT_SETTINGS,
) as (keyof EmailTransportTimeouts)[];

/**
 * Read the three timeouts. A value that is not a whole number of milliseconds
 * inside the accepted range falls back to its default with a warning, rather
 * than an issue: a mistyped timeout must not stop the club's mail. A greeting
 * cap above the setup budget is kept but warned about, because it can never
 * take effect.
 */
export function readTransportTimeouts(env: EnvMap, warnings: string[]): EmailTransportTimeouts {
  const read = (option: keyof EmailTransportTimeouts): number => {
    const { env: name, defaultMs } = EMAIL_TRANSPORT_TIMEOUT_SETTINGS[option];
    const raw = env[name]?.trim();
    if (!raw) return defaultMs;
    const { min, max } = EMAIL_TRANSPORT_TIMEOUT_RANGE_MS;
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) return parsed;
    warnings.push(
      `${name} must be a whole number of milliseconds from ${min} to ${max}; using the default ${defaultMs}`,
    );
    return defaultMs;
  };
  const timeouts = Object.fromEntries(
    EMAIL_TRANSPORT_TIMEOUT_OPTIONS.map((option) => [option, read(option)]),
  ) as unknown as EmailTransportTimeouts;
  if (timeouts.greetingTimeout > timeouts.connectionTimeout) {
    const { connectionTimeout, greetingTimeout } = EMAIL_TRANSPORT_TIMEOUT_SETTINGS;
    warnings.push(
      `${greetingTimeout.env} (${timeouts.greetingTimeout}) is above ${connectionTimeout.env} (${timeouts.connectionTimeout}), which already covers the greeting, so it has no effect; set it lower or raise ${connectionTimeout.env}`,
    );
  }
  return timeouts;
}
