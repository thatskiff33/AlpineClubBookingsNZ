/**
 * The MiroTalk configuration vocabulary shared by the server resolver and the
 * admin screen (#2940).
 *
 * WHY IT IS SPLIT OUT, and it is the same reason `analytics-settings-shared`
 * exists beside `analytics-settings`: `mirotalk-config.ts` is `server-only`,
 * and importing a VALUE from it in a client component fails `npm run build`
 * with "'server-only' cannot be imported from a Client Component module". The
 * setup screen needs the key names, the status shapes and the validation rules;
 * it must never need the resolver, the Prisma client or the credential store.
 *
 * WHAT CATCHES IT IF SOMEBODY TRIES ANYWAY, corrected. This paragraph used to
 * end "which lint, typecheck, knip and vitest all miss", which is false in the
 * direction that matters: it tells the next reader no automated guard exists,
 * so the split looks like a convention held up by care. It is not.
 * `client-server-boundary-census.test.ts` walks the real import graph from every
 * `"use client"` module and fails this exact path — measured, it reports
 * `video-meetings-setup.tsx -> mirotalk-config.ts -> server-only` — and it runs
 * inside the REQUIRED `verify` check, which is also where the build itself
 * runs. (Semgrep's `acb-client-server-boundary` rule catches the DIRECT shape
 * only for the modules named in its fixed alternation, which does not include
 * this one, so here it is the census that holds.) The split is still right; the
 * reason given for it was wrong, and it is repeated in two client components,
 * which is itself the point.
 *
 * THE STATUS SHAPES ARE THE EXPOSURE CONTRACT, not a convenience. #2723
 * established that a secret is kept out of an audit row by the SHAPE of the
 * payload rather than by a redaction filter, because a filter lives in one
 * place and is blind to every door that does not call it. The same argument
 * applies to a screen: {@link MirotalkSecretStatus} has no field a credential
 * VALUE fits into, so the admin API cannot return one by accident, and a future
 * edit that wanted to would have to add a field and be seen doing it.
 * `mirotalk-exposure-contract.test.ts` is the behavioural half.
 */

import {
  isBlockedDestinationHost,
  normaliseDestinationHost,
} from "@/lib/private-destination-hosts";

/** The provider namespace MiroTalk's secrets occupy in the credential store. */
export const MIROTALK_PROVIDER = "mirotalk";

/**
 * The three secrets, and why the username is one of them.
 *
 * A MiroTalk join token embeds `{ username, password, presenter }`, AES-
 * encrypted under the JWT key, and MiroTalk authenticates the pair against its
 * own `HOST_USERS` list. The username alone is not a secret in the way the
 * password is, but it is half of a credential pair whose whole value is being
 * unguessable together, and there is no surface on which showing it back helps
 * an administrator: they set the pair, and the screen tells them it is set.
 * Storing all three the same way also means there is one rule for MiroTalk
 * secrets rather than one rule and an exception.
 */
export const MIROTALK_CREDENTIAL_KEYS = {
  jwtKey: "jwt_key",
  meetingUsername: "meeting_username",
  meetingPassword: "meeting_password",
} as const;

export type MirotalkCredentialKey =
  (typeof MIROTALK_CREDENTIAL_KEYS)[keyof typeof MIROTALK_CREDENTIAL_KEYS];

/** Every writable MiroTalk credential key, in the order the screen shows them. */
export const MIROTALK_WRITABLE_CREDENTIAL_KEYS = [
  MIROTALK_CREDENTIAL_KEYS.jwtKey,
  MIROTALK_CREDENTIAL_KEYS.meetingUsername,
  MIROTALK_CREDENTIAL_KEYS.meetingPassword,
] as const;

const MIROTALK_CREDENTIAL_KEY_SET: ReadonlySet<string> = new Set<string>(
  MIROTALK_WRITABLE_CREDENTIAL_KEYS,
);

/** The runtime half of the closed key set, for a value arriving as text. */
export function isMirotalkCredentialKey(
  value: unknown,
): value is MirotalkCredentialKey {
  return typeof value === "string" && MIROTALK_CREDENTIAL_KEY_SET.has(value);
}

/** Plain-English name of each secret, for the screen and for an error message. */
export const MIROTALK_CREDENTIAL_LABELS: Record<MirotalkCredentialKey, string> =
  {
    [MIROTALK_CREDENTIAL_KEYS.jwtKey]: "Signing key",
    [MIROTALK_CREDENTIAL_KEYS.meetingUsername]: "Host username",
    [MIROTALK_CREDENTIAL_KEYS.meetingPassword]: "Host password",
  };

/** The three non-secret settings, named as the status and the screen key them. */
export type MirotalkSettingField = "baseUrl" | "presenter" | "tokenLifetime";

/** Anything on this screen that has an environment variable behind it. */
export type MirotalkEnvBackedSetting = MirotalkCredentialKey | MirotalkSettingField;

/**
 * THE environment variable behind each of the six, and the only place any of
 * their names is written.
 *
 * All six, not three. The secrets had this record from the start; the three
 * non-secret names were literals in three places each — the resolver's
 * `process.env` read, the sentence the resolver puts on the status when a value
 * would be refused, and the screen's own note — so renaming one meant finding
 * five sites and renaming a secret meant finding one. Two spellings of the same
 * fact is the defect; which spelling won is not the interesting part.
 */
export const MIROTALK_ENV_NAMES: Record<MirotalkEnvBackedSetting, string> = {
  [MIROTALK_CREDENTIAL_KEYS.jwtKey]: "MIRO_JWT_KEY",
  [MIROTALK_CREDENTIAL_KEYS.meetingUsername]: "MIRO_MEETING_USERNAME",
  [MIROTALK_CREDENTIAL_KEYS.meetingPassword]: "MIRO_MEETING_PASSWORD",
  baseUrl: "MIROTALK_URL",
  presenter: "MIRO_MEETING_PRESENTER",
  tokenLifetime: "MIRO_JWT_EXP",
};

/**
 * Where an effective value came from.
 *
 *   database    — a club administrator set it on this screen.
 *   environment — nothing is set here, so the documented environment variable
 *                 is being used. This is what keeps an install that predates
 *                 this screen working untouched.
 *   derived     — neither is set and the value is computed (the meeting address
 *                 derived from the club's own domain) or is the documented
 *                 default (presenter on, one-hour token).
 */
export type MirotalkValueSource = "database" | "environment" | "derived";

/** One non-secret value: what is in force, where it came from, what was ignored. */
export interface MirotalkFieldStatus {
  /**
   * The value actually IN FORCE, rendered as text — the page prints it under
   * the words "In force:", so it has to be the thing the join builder will use
   * rather than the raw text a source happened to hold. Text because not every
   * value is one: the presenter flag is a boolean, shown as "on"/"off". An
   * address is normalised here, so `MIROTALK_URL=meet.example.org` reads
   * `https://meet.example.org`, which is where the links go (#2940 review, C3).
   */
  effective: string;
  source: MirotalkValueSource;
  /**
   * Set when a stored or environment value was REJECTED and something else is
   * in force instead. Plain English, safe to show: it never quotes a secret,
   * because no secret is a field of this type.
   */
  problem: string | null;
}

/**
 * Where a SECRET came from — the value source minus the one a secret cannot
 * have.
 *
 * There is no computed default for a signing key or a host password: either
 * somebody set it or nobody did. The status used to reuse the non-secret union,
 * which admitted "derived" — a state the resolver has never produced — and the
 * screen's badge, having no case for it, fell through to "not set". A type that
 * describes the code loosely and a UI quietly covering for it: two small wrongs
 * that cancelled out, until one of them moved.
 */
export type MirotalkSecretSource = Exclude<MirotalkValueSource, "derived"> | "unset";

/**
 * One secret: whether it is set and from where — and NEVER what it is.
 *
 * `version` is the optimistic-concurrency token of the stored row, which #2723
 * defines as a SHA-256 over `(iv, authTag, ciphertext)` precisely so it can be
 * handed out the way an `If-Match` is: it changes on every write, and it
 * reveals none of the three. The screen sends it back on a replace or a clear,
 * which is how a second administrator's Save loses deterministically instead of
 * silently overwriting the first.
 */
export interface MirotalkSecretStatus {
  key: MirotalkCredentialKey;
  /** "unset" means neither the database nor the environment has this one. */
  source: MirotalkSecretSource;
  version: string | null;
  /** ISO instant the stored secret was last written, when stored. */
  updatedAt: string | null;
  /** Stored, but the app encryption key changed and it no longer decrypts. */
  needsReentry: boolean;
}

/** Everything the setup screen renders, and everything the admin API returns. */
export interface MirotalkConfigurationStatus {
  baseUrl: MirotalkFieldStatus;
  presenter: MirotalkFieldStatus;
  tokenLifetime: MirotalkFieldStatus;
  secrets: MirotalkSecretStatus[];
  /**
   * True when all three secrets resolve, so a join link carries a signed token.
   * False means the link still works — MiroTalk shows its own host login.
   */
  tokenMintable: boolean;
}

/**
 * The non-secret settings the screen stages and saves in one write.
 *
 * Each field distinguishes "the club set this" from "the club has not set
 * this", because they are different states and the second is what the
 * environment fallback reads. An empty string and a null therefore both mean
 * "not set here", and the API writes a null column for either.
 */
export interface MirotalkSettingsDraft {
  baseUrl: string;
  presenterEnabled: boolean | null;
  tokenLifetime: string;
}

/**
 * The `MirotalkSettings` singleton's row id.
 *
 * ONE HOME, and it is here rather than in the resolver because three files name
 * this row and the resolver is only one of them: it reads the row, the writer
 * upserts it, and the settings route names it as the audited entity of a
 * refusal. That third site was the literal `"default"` until #2940's review
 * (T4), which made this constant's own "every file that names a row in this
 * table reads this" claim false — and a claim a reader trusts and the code does
 * not keep is worse than no claim. Being a plain fact rather than a resolver
 * concern, it also belongs where every namer can reach it without dragging
 * `server-only` and Prisma in.
 */
export const MIROTALK_SETTINGS_ID = "default";

/** The stored column widths, which the form and the API both enforce. */
export const MIROTALK_BASE_URL_MAX_LENGTH = 500;
export const MIROTALK_TOKEN_LIFETIME_MAX_LENGTH = 16;

/** Shortest and longest access-token lifetime an administrator may store. */
export const MIROTALK_TOKEN_LIFETIME_MIN_SECONDS = 30;
export const MIROTALK_TOKEN_LIFETIME_MAX_SECONDS = 86_400;

/** The documented default lifetime, in force when nothing else says otherwise. */
export const MIROTALK_DEFAULT_TOKEN_LIFETIME = "1h";

export type MirotalkValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Drop every trailing slash from an address (#2940 review, T7).
 *
 * THREE places wanted this rule: the resolver's environment branch, the
 * validator's normalised output, and the join builder's defensive strip before
 * it appends a path. Three copies of a one-line regex is still three copies —
 * and the join builder's is genuinely defensive, because everything that can
 * reach it has already been stripped, so it is kept rather than deleted: the
 * next source added to the resolver would otherwise be the one that discovers
 * why it was there.
 */
export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * A bare host assumed to be `https://`, and the ONE test for whether it already
 * carries a scheme (#2940 review, T5).
 *
 * Both the resolver's environment branch and {@link validateMirotalkBaseUrl}
 * make this same assumption, so an administrator typing `meet.example.org` is
 * not told off for matching what the documentation shows them. They used to make
 * it with two hand-agreed regular expressions, and the pair had already drifted:
 * `/^https?:\/\//i` accepts only http and https, so the resolver bolted
 * `https://` onto `ftp://meet.example.org` and produced
 * `https://ftp://meet.example.org`, which then failed the page's rules with
 * "it needs a domain" rather than with the real reason. The RFC 3986 scheme
 * shape is the correct test and is now the only one.
 */
export function withAssumedHttpsScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * One address reduced to the meeting SERVER it names, for comparison only.
 *
 * The two sides of such a comparison arrive by different routes: a stored
 * address has been through {@link validateMirotalkBaseUrl} and so through the
 * URL parser, and an environment one deliberately never is, because an
 * environment value is never refused. So `https://meet.example.org:443`,
 * `https://meet.example.org/` and `meet.example.org` can all be the same server
 * written four ways, and a raw string comparison reads three of them as a move.
 * The parser drops a default port and lower-cases the host; a value it cannot
 * parse falls back to a trimmed, lower-cased, slash-stripped compare, which is
 * no worse than the string comparison it replaces.
 */
function meetingServerIdentity(value: string): string {
  const withScheme = withAssumedHttpsScheme(value.trim());
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return withScheme.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Whether two addresses name the same MiroTalk instance.
 *
 * THE ONE HOME for that question (#2940 review, C1/T5). The server asks it to
 * decide whether a Save moves the meeting server — which is the only thing
 * allowed to delete the three stored secrets — and the admin screen asks it to
 * warn the person BEFORE they save rather than after. Two copies of a rule that
 * decides whether three unreadable values are destroyed is not a rule.
 */
export function isSameMeetingServer(a: string, b: string): boolean {
  return meetingServerIdentity(a) === meetingServerIdentity(b);
}

/**
 * Validate a meeting-server address an administrator typed.
 *
 * STRICTER THAN THE ENVIRONMENT PATH, on purpose. `MIROTALK_URL` keeps the
 * behaviour it has always had — a bare host is assumed https, and a loopback
 * address is how local development works — because an install that predates
 * this screen must keep minting exactly the links it minted before. A value
 * stored HERE is new, is typed by a person, and is where a freshly signed join
 * token is sent, so it must be https (the token travels in the address), must
 * not carry credentials of its own, and must not name a private or loopback
 * host, which in production resolves on the CLICKER's machine rather than the
 * club's.
 */
export function validateMirotalkBaseUrl(value: string): MirotalkValidation {
  // Whitespace only. A trailing slash is dropped AFTER parsing, not before:
  // stripping it first turned "https://" into "https:", which then failed the
  // scheme test, got another "https://" bolted on, and parsed cleanly as the
  // host "https" — so a typo stored as the plausible-looking address
  // `https://https`. The test that found it is in
  // mirotalk-settings-shared.test.ts.
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, reason: "Enter the meeting server address." };
  if (trimmed.length > MIROTALK_BASE_URL_MAX_LENGTH) {
    return {
      ok: false,
      reason: `That address is longer than ${MIROTALK_BASE_URL_MAX_LENGTH} characters.`,
    };
  }

  // A bare host is assumed https, the same assumption the environment path
  // makes, so an administrator typing "meet.example.org" is not told off for
  // matching what the documentation shows them. One helper, one test: see
  // `withAssumedHttpsScheme`.
  const withScheme = withAssumedHttpsScheme(trimmed);

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That is not a valid web address." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason:
        "The meeting server address must start with https:// — a join link carries a signed access token in the address itself, so http:// would put that token on the wire in cleartext.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "Remove the username or password from the address.",
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      reason:
        "Remove the query string or the # fragment — the join link appends its own.",
    };
  }
  if (!normaliseDestinationHost(parsed.hostname).includes(".")) {
    // A single-label host is not publicly resolvable, and members open this
    // link from their own phones and home networks. It is also what a typed
    // fragment ("meet", "https") parses into once a scheme is assumed.
    //
    // Asked of the ROOT-LABEL-STRIPPED host, because `meet.` is the same single
    // label as `meet` and a raw `includes(".")` reads its trailing dot as a
    // domain separator.
    return {
      ok: false,
      reason:
        "That does not look like a full address — it needs a domain, for example meet.example.org.",
    };
  }
  if (isBlockedDestinationHost(parsed.hostname)) {
    return {
      ok: false,
      reason:
        "That is a private, loopback or link-local address. Members' browsers open the meeting link, so it has to be a public address — a localhost address resolves on whoever clicked it.",
    };
  }
  const normalised = stripTrailingSlashes(parsed.toString());
  if (normalised.length > MIROTALK_BASE_URL_MAX_LENGTH) {
    return {
      ok: false,
      reason: `That address is longer than ${MIROTALK_BASE_URL_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value: normalised };
}

/**
 * Parse a MiroTalk-style lifetime (`"1h"`, `"30m"`, `"45s"`, `"1d"`, or a bare
 * number of seconds) into seconds, or null when it is not one.
 *
 * Returning null rather than a default is the whole point of having this beside
 * {@link validateMirotalkTokenLifetime}: the RESOLVER wants a documented
 * fallback when the environment holds nonsense, and the WRITE path wants a
 * refusal, and both have to read the same string the same way. It is also why
 * the parser lives here rather than in `mirotalk-token.ts`, which the admin
 * screen cannot import.
 */
export function parseMirotalkLifetimeSeconds(
  value: string | null | undefined,
): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw);
  if (!match) return null;
  // Both capture groups are what the pattern is for; without them there is no
  // duration to read.
  const amountText = match[1];
  const unit = match[2];
  if (amountText === undefined || unit === undefined) return null;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (unit.toLowerCase()) {
    case "s":
    case "":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    case "d":
      return amount * 86400;
    default:
      return null;
  }
}

/** Validate an access-token lifetime an administrator typed. */
export function validateMirotalkTokenLifetime(
  value: string,
): MirotalkValidation {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: "Enter how long a join link stays usable." };
  }
  if (trimmed.length > MIROTALK_TOKEN_LIFETIME_MAX_LENGTH) {
    return {
      ok: false,
      reason: "That is not a length of time this understands.",
    };
  }
  const seconds = parseMirotalkLifetimeSeconds(trimmed);
  if (seconds === null) {
    return {
      ok: false,
      reason:
        'Write it as a number and a unit — "1h", "30m", "45s" or "1d" — or as a plain number of seconds.',
    };
  }
  if (seconds < MIROTALK_TOKEN_LIFETIME_MIN_SECONDS) {
    return {
      ok: false,
      reason: `A join link has to stay usable for at least ${MIROTALK_TOKEN_LIFETIME_MIN_SECONDS} seconds, or nobody can open it in time.`,
    };
  }
  if (seconds > MIROTALK_TOKEN_LIFETIME_MAX_SECONDS) {
    return {
      ok: false,
      reason:
        "A join link may last at most one day (24h). Longer is one more chance for a forwarded address to still work.",
    };
  }
  return { ok: true, value: trimmed };
}
