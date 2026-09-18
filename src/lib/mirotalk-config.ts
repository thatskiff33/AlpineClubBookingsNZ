import "server-only";

import { prisma } from "@/lib/prisma";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  invalidateProviderCredentialCache,
  resolveIntegrationCredential,
} from "@/lib/integration-credentials";
import type { CredentialVersion } from "@/lib/integration-credential-actor";
import { mintMirotalkAccessToken } from "@/lib/mirotalk-token";
import { isLoopbackDestinationHost } from "@/lib/private-destination-hosts";
import {
  MIROTALK_CREDENTIAL_KEYS,
  MIROTALK_DEFAULT_TOKEN_LIFETIME,
  MIROTALK_ENV_NAMES,
  MIROTALK_PROVIDER,
  MIROTALK_SETTINGS_ID,
  MIROTALK_WRITABLE_CREDENTIAL_KEYS,
  isSameMeetingServer,
  parseMirotalkLifetimeSeconds,
  stripTrailingSlashes,
  validateMirotalkBaseUrl,
  validateMirotalkTokenLifetime,
  withAssumedHttpsScheme,
  type MirotalkConfigurationStatus,
  type MirotalkCredentialKey,
  type MirotalkFieldStatus,
  type MirotalkSecretSource,
  type MirotalkSecretStatus,
  type MirotalkValueSource,
} from "@/lib/mirotalk-settings-shared";

/**
 * THE ONE MiroTalk resolver (#2940).
 *
 * ## What moved, and what deliberately did not
 *
 * MiroTalk configuration used to be read straight out of `process.env` in two
 * different files — the base URL in `calendar-events.ts`, the token secrets in
 * `mirotalk-token.ts` — so there was no single place that knew what a join link
 * would actually be, and no place an administrator could change it. The
 * CLUB-EDITABLE half now lives in the database and is resolved here:
 *
 *   - the meeting server address, the presenter flag and the token lifetime in
 *     the `MirotalkSettings` singleton;
 *   - the signing key and the host username/password in the encrypted
 *     `IntegrationCredential` store under provider "mirotalk" (#2723).
 *
 * The DEPLOYMENT half stays in the environment and is not represented here at
 * all: `MEET_HOST` and `MIROTALK_UPSTREAM` are the reverse-proxy block in
 * `docker-compose.yml` (which host Caddy answers on and where it reaches
 * MiroTalk), and `NEXTAUTH_URL` is the app's own origin the derived default is
 * computed from. Those are topology — they are answered by whoever runs the
 * server, not by the club — and `INV-CONFIG-001` is the rule that decides which
 * side of that line a value falls on.
 *
 * ## Precedence, per field: database -> environment -> derived
 *
 * Per FIELD rather than per group, so an install that has only ever set
 * environment variables keeps minting exactly the links it minted before, with
 * no row in the new table at all, and a club that sets one value on the screen
 * does not have to re-enter the rest. NOTHING IMPORTS THE ENVIRONMENT INTO THE
 * DATABASE: a value arrives in a column only when an administrator types it and
 * presses Save, which is why the `MirotalkSettings` columns are all nullable and
 * why the presenter flag is `Boolean?` — "the admin chose false" and "the admin
 * has not chosen" are different states and a database default would spell them
 * the same way.
 *
 * A stored value that fails validation is IGNORED rather than trusted, and the
 * next source down takes effect with the reason recorded on the status. An
 * environment value is never rejected, because rejecting one would break an
 * install that works today; where it would not pass the screen's own rules the
 * status says so and keeps using it.
 *
 * ## Restarts
 *
 * A database value takes effect on the next join click — nothing here is read
 * at build time or cached across requests beyond the credential store's own
 * 45-second cross-process TTL (`integration-credentials.ts`), which is what
 * lets a write in one web container reach the other without a restart. The
 * ADMIN STATUS read drops that cache first, because it is the only consumer
 * whose correctness depends on the concurrency token being current rather than
 * merely recent. An
 * environment value still needs a restart, because that is what changing an
 * environment variable means. The screen says which of the two an administrator
 * is looking at, so the restart advice matches what is actually being consumed.
 */

/** MiroTalk dev instance used when the app itself is on a loopback host. */
const LOCAL_MIROTALK_FALLBACK = "http://localhost:3010";

// Emit the "loopback fallback in production" warning at most once per process so
// a misconfigured prod deploy is diagnosable without spamming every click.
let warnedLoopbackFallback = false;

/** test seam — the one-shot warning must be re-armable between cases. */
export function resetMirotalkWarningsForTests(): void {
  warnedLoopbackFallback = false;
}

/**
 * Return the localhost MiroTalk dev instance, warning ONCE when this happens in
 * production — a prod deploy that resolves meeting links to `localhost:3010`
 * means nothing is configured on either side and the app origin looks like a
 * loopback host, so every join link points at the clicker's own machine.
 */
function loopbackFallback(): string {
  if (process.env.NODE_ENV === "production" && !warnedLoopbackFallback) {
    warnedLoopbackFallback = true;
    console.warn(
      "[mirotalk] No meeting server address is set in Admin -> Integrations or " +
        "in MIROTALK_URL, and the app origin resolves to a loopback host; " +
        "meeting join links point at the localhost dev instance " +
        "(http://localhost:3010). Set the address on the Video meetings setup page.",
    );
  }
  return LOCAL_MIROTALK_FALLBACK;
}

/**
 * The address when neither the database nor the environment names one: derive
 * `https://meet.<app-domain>` from the app's OWN origin (`NEXTAUTH_URL`, via
 * getAppBaseUrl). This makes a deployment that has configured nothing point at
 * a real, same-domain host the operator controls — a visible, diagnosable
 * failure if that subdomain is not up — instead of `http://localhost:3010`,
 * which silently resolved to the CLICKER's own machine on every prod deploy.
 *
 * A leading `www.` is dropped; any other extra subdomain is kept (an app at
 * `bookings.example.org` derives `meet.bookings.example.org`), so a club on a
 * non-www subdomain sets the address explicitly.
 */
function derivedBaseUrl(): string {
  try {
    const { hostname } = new URL(getAppBaseUrl());
    if (isLoopbackDestinationHost(hostname)) return loopbackFallback();
    return `https://meet.${hostname.replace(/^www\./i, "")}`;
  } catch {
    return loopbackFallback();
  }
}

// ---------------------------------------------------------------------------
// The stored non-secret settings
// ---------------------------------------------------------------------------

export interface MirotalkStoredSettings {
  baseUrl: string | null;
  presenterEnabled: boolean | null;
  tokenLifetime: string | null;
  updatedAt: string | null;
}

const NO_STORED_SETTINGS: MirotalkStoredSettings = {
  baseUrl: null,
  presenterEnabled: null,
  tokenLifetime: null,
  updatedAt: null,
};

/**
 * Read the singleton, or the all-null "nothing set here" shape when no
 * administrator has ever saved. A missing row is the normal state of an
 * environment-only install and is NOT an error.
 */
export async function readMirotalkStoredSettings(): Promise<MirotalkStoredSettings> {
  const row = await prisma.mirotalkSettings.findUnique({
    where: { id: MIROTALK_SETTINGS_ID },
  });
  if (!row) return { ...NO_STORED_SETTINGS };
  return {
    baseUrl: row.baseUrl,
    presenterEnabled: row.presenterEnabled,
    tokenLifetime: row.tokenLifetime,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One resolved non-secret value, with the source and anything discarded. */
interface ResolvedField<T> {
  value: T;
  /** What an administrator typed, or the environment holds, in display form. */
  display: string;
  source: MirotalkValueSource;
  problem: string | null;
}

function resolveBaseUrl(stored: MirotalkStoredSettings): ResolvedField<string> {
  if (stored.baseUrl) {
    const check = validateMirotalkBaseUrl(stored.baseUrl);
    if (check.ok) {
      return {
        value: check.value,
        display: check.value,
        source: "database",
        problem: null,
      };
    }
    // A stored value that no longer passes — because the rule tightened, or
    // because it was written by something other than this screen — is ignored
    // rather than used. Falling through is safe: the next source down is what
    // the club had before they set this one.
    const fallback = resolveBaseUrlWithoutDatabase();
    return {
      ...fallback,
      problem: `The address saved here is not being used: ${check.reason}`,
    };
  }
  return resolveBaseUrlWithoutDatabase();
}

function resolveBaseUrlWithoutDatabase(): ResolvedField<string> {
  const envName = MIROTALK_ENV_NAMES.baseUrl;
  const raw = process.env[envName]?.trim();
  if (raw) {
    // Behaviour preserved exactly: a bare host is assumed https, and the value
    // is used whatever it is. An environment value is never refused, because
    // refusing one would break an install that works today. Where it would not
    // pass the screen's rules the status says so and keeps using it.
    //
    // ONE scheme test, shared with the page's validator (#2940 review, T5): the
    // two hand-agreed copies had already drifted, and this one accepted only
    // http/https, so `ftp://meet.example.org` had `https://` bolted on.
    const inForce = stripTrailingSlashes(withAssumedHttpsScheme(raw));
    const check = validateMirotalkBaseUrl(inForce);
    return {
      value: inForce,
      // THE VALUE IN FORCE, not the raw text (#2940 review, C3). `effective` is
      // read by the page under the words "In force:", and with
      // `MIROTALK_URL=meet.example.org` the raw text said `meet.example.org`
      // while every join link went to `https://meet.example.org`. Saying what is
      // in force is the screen's whole job; `problem` below is where a value
      // that would not be accepted is called out, and the source note names the
      // variable, so nothing is lost by normalising here.
      display: inForce,
      source: "environment",
      problem: check.ok
        ? null
        : `${envName} is in force, but it would not be accepted on this page: ${check.reason}`,
    };
  }
  const derived = derivedBaseUrl();
  return { value: derived, display: derived, source: "derived", problem: null };
}

/**
 * Whether a Save MOVES the meeting server — the question the secret clear is
 * allowed to ask, and the only one it may ask (#2940 review, C1).
 *
 * IT COMPARES WHAT IS IN FORCE, NOT WHAT IS STORED. The stored column is `null`
 * on every install that has only ever set `MIROTALK_URL`, so a column-level
 * comparison reads `null -> "https://meet.club.org"` as a move even when that is
 * the address already in force and the environment variable says so. The cost of
 * getting that wrong is not cosmetic: the clear deletes three secrets nobody can
 * read back. A Full Admin who stores the signing key and the host credentials
 * and then types the address they are already using into the box — which is what
 * `.env.example` now tells them to do — would lose all three, told only
 * afterwards.
 *
 * The secrets are paired with a MiroTalk INSTANCE: the signing key must equal
 * that instance's `JWT_KEY` and the credentials must match one of its
 * `HOST_USERS`. So the move that invalidates them is a move of the address
 * actually in force, which is what this asks, and writing the same address down
 * explicitly is not one.
 *
 * Both sides go through the same resolver, so every precedence rule — a stored
 * value that no longer validates falling back, an empty column returning to the
 * environment, the derived address when neither names one — applies to both
 * automatically rather than being restated here.
 */
export function mirotalkMeetingServerMoved(
  before: MirotalkStoredSettings,
  after: MirotalkStoredSettings,
): boolean {
  return !isSameMeetingServer(
    resolveBaseUrl(before).value,
    resolveBaseUrl(after).value,
  );
}

function resolvePresenter(stored: MirotalkStoredSettings): ResolvedField<boolean> {
  if (stored.presenterEnabled !== null) {
    return {
      value: stored.presenterEnabled,
      display: stored.presenterEnabled ? "on" : "off",
      source: "database",
      problem: null,
    };
  }
  const raw = process.env[MIROTALK_ENV_NAMES.presenter]?.trim();
  if (raw) {
    // Preserved exactly: anything other than the literal "false" is on.
    const value = raw.toLowerCase() !== "false";
    return {
      value,
      display: value ? "on" : "off",
      source: "environment",
      problem: null,
    };
  }
  // Default on: the join link is meant to let committee members open and host
  // the meeting immediately. MiroTalk's /join page grants host status purely
  // from this flag, so "off" leaves the clicker on the "waiting for host"
  // screen.
  return { value: true, display: "on", source: "derived", problem: null };
}

function resolveTokenLifetime(
  stored: MirotalkStoredSettings,
): ResolvedField<number> {
  const derived = {
    value: parseMirotalkLifetimeSeconds(MIROTALK_DEFAULT_TOKEN_LIFETIME) ?? 3600,
    display: MIROTALK_DEFAULT_TOKEN_LIFETIME,
    source: "derived" as const,
    problem: null,
  };

  if (stored.tokenLifetime) {
    const check = validateMirotalkTokenLifetime(stored.tokenLifetime);
    if (check.ok) {
      return {
        value: parseMirotalkLifetimeSeconds(check.value) ?? derived.value,
        display: check.value,
        source: "database",
        problem: null,
      };
    }
    const fallback = resolveTokenLifetimeWithoutDatabase(derived);
    return {
      ...fallback,
      problem: `The join-link lifetime saved here is not being used: ${check.reason}`,
    };
  }
  return resolveTokenLifetimeWithoutDatabase(derived);
}

function resolveTokenLifetimeWithoutDatabase(
  derived: ResolvedField<number>,
): ResolvedField<number> {
  const envName = MIROTALK_ENV_NAMES.tokenLifetime;
  const raw = process.env[envName]?.trim();
  if (!raw) return derived;
  const seconds = parseMirotalkLifetimeSeconds(raw);
  if (seconds === null) {
    // Includes a zero (`MIRO_JWT_EXP=0`), which the OLD parser read as a zero-second
    // token — a link that had expired before it was clicked. It now falls to the
    // documented default with this note, which is the one place the environment
    // behaviour genuinely changed rather than merely moving.
    return {
      ...derived,
      problem: `${envName} is not a length of time this understands, so the default ${MIROTALK_DEFAULT_TOKEN_LIFETIME} is in force.`,
    };
  }
  // CHECKED AGAINST THE PAGE'S OWN RULES, exactly as the address branch above
  // is. Without this an environment value outside 30s–24h read as "in force,
  // from the environment" with no caveat at all, so an administrator who typed
  // the same value into the box to make it explicit was refused — the page
  // telling them two different things about one value.
  const check = validateMirotalkTokenLifetime(raw);
  return {
    value: seconds,
    display: raw,
    source: "environment",
    problem: check.ok
      ? null
      : `${envName} is in force, but it would not be accepted on this page: ${check.reason}`,
  };
}

/**
 * EVERYTHING ABOUT A SECRET THAT A SURFACE MAY SEE, and it has no field a
 * plaintext fits into.
 *
 * This is the #2723 argument applied one layer further out. There, a secret
 * stays out of an audit row because the PAYLOAD TYPE has nowhere to put one —
 * structure rather than a redaction filter, because a filter is blind to every
 * door that does not call it. Here the projection used to be built from an
 * object that DID carry the plaintext, so what kept it out of the status was a
 * comment saying "written field by field, and never as a spread" plus a test.
 * Both are real and the test is mutation-verified, but they police a mistake
 * rather than making it unrepresentable: nothing stopped a later edit reaching
 * for `resolved.value` from inside the projection. Now nothing in scope there
 * HAS a value, so the leak cannot be written.
 */
interface ResolvedSecretMeta {
  key: MirotalkCredentialKey;
  /**
   * "derived" is deliberately absent, where the non-secret fields have it. A
   * secret is set or it is not; there is no computed default for a signing key,
   * and the resolver below never produced one. The wider union admitted a state
   * that cannot happen, and the screen's badge fell through to "not set" for
   * it — a type describing the code loosely, and a UI quietly covering for it.
   */
  source: MirotalkSecretSource;
  version: CredentialVersion | null;
  needsReentry: boolean;
}

/** One resolved secret: what may be shown, and separately the plaintext. */
interface ResolvedSecret {
  meta: ResolvedSecretMeta;
  /** Read by the join-token mint and by nothing else in this module. */
  value: string | null;
}

async function resolveSecret(
  key: MirotalkCredentialKey,
): Promise<ResolvedSecret> {
  const envName = MIROTALK_ENV_NAMES[key];
  const stored = await resolveIntegrationCredential(MIROTALK_PROVIDER, key);
  if (stored.status === "configured") {
    return {
      meta: {
        key,
        source: "database",
        version: stored.version,
        needsReentry: false,
      },
      value: stored.value,
    };
  }
  if (stored.status === "needs_reentry") {
    // DELIBERATELY NO FALLBACK. A stored secret that no longer decrypts means
    // the app encryption key changed, and quietly reverting to the environment
    // value would hide that: meetings would keep working on credentials the
    // club replaced, and nobody would ever be told to re-enter the ones they
    // meant to use. The join link degrades visibly instead — no token, so
    // MiroTalk shows its own host login — and the screen says which secret to
    // re-enter.
    return {
      meta: {
        key,
        source: "database",
        version: stored.version,
        needsReentry: true,
      },
      value: null,
    };
  }
  const fromEnv = process.env[envName];
  // Only the password may legitimately carry leading or trailing spaces, so it
  // is the one value not trimmed — exactly as the environment path read it
  // before this change.
  const value =
    key === MIROTALK_CREDENTIAL_KEYS.meetingPassword
      ? (fromEnv ?? "")
      : (fromEnv?.trim() ?? "");
  if (!value) {
    return {
      meta: { key, source: "unset", version: null, needsReentry: false },
      value: null,
    };
  }
  return {
    meta: { key, source: "environment", version: null, needsReentry: false },
    value,
  };
}

interface ResolvedMirotalk {
  baseUrl: ResolvedField<string>;
  presenter: ResolvedField<boolean>;
  tokenLifetime: ResolvedField<number>;
  secrets: ResolvedSecret[];
}

/**
 * THE resolution. Every consumer — the join-link path, the admin status, the
 * setup screen — is a projection of this one function, so DB/environment
 * precedence cannot be answered two different ways by two callers.
 */
async function resolveMirotalk(): Promise<ResolvedMirotalk> {
  const stored = await readMirotalkStoredSettings();
  const [jwtKey, username, password] = await Promise.all([
    resolveSecret(MIROTALK_CREDENTIAL_KEYS.jwtKey),
    resolveSecret(MIROTALK_CREDENTIAL_KEYS.meetingUsername),
    resolveSecret(MIROTALK_CREDENTIAL_KEYS.meetingPassword),
  ]);
  return {
    baseUrl: resolveBaseUrl(stored),
    presenter: resolvePresenter(stored),
    tokenLifetime: resolveTokenLifetime(stored),
    secrets: [jwtKey, username, password],
  };
}

// ---------------------------------------------------------------------------
// The runtime consumer
// ---------------------------------------------------------------------------

/**
 * Build a MiroTalk join URL for a stored room slug.
 *
 * When all three secrets resolve, a freshly-signed short-lived access token
 * authenticates the clicker as host so the meeting starts with no login prompt.
 * The token is minted per request — the signing key and the host password never
 * reach the browser.
 *
 * IMPORTANT: MiroTalk only reads the token on its QUERY-form route
 * (`/join?room=...&token=...`). Its path-form route (`/join/<room>`) is a
 * different handler that ignores the token and shows the "waiting for host"
 * page, so a token URL must use the query form. Without a token we keep the
 * friendlier path form (the standard shareable MiroTalk link).
 *
 * ASYNC because the club's own configuration is now the first thing consulted.
 * It is called once per click on the join endpoint, never during list
 * serialisation, so this is one primary-key read and (at most) one cached
 * credential read per meeting somebody actually opens.
 */
export async function buildMeetingJoinUrl(room: string): Promise<string> {
  const resolved = await resolveMirotalk();
  // Defensive: everything that can reach here has already been stripped. Kept,
  // through the one helper, so the next source added to the resolver is not the
  // one that discovers why it was there (#2940 review, T7).
  const base = stripTrailingSlashes(resolved.baseUrl.value);
  const [jwtKey, username, password] = resolved.secrets;

  if (!jwtKey?.value || !username?.value || !password?.value) {
    // With MiroTalk's HOST_USER_AUTH on, a token whose credentials do not match
    // a HOST_USERS entry is rejected outright, so a partial set mints nothing
    // rather than a token that cannot authenticate.
    return `${base}/join/${encodeURIComponent(room)}`;
  }

  const token = mintMirotalkAccessToken({
    key: jwtKey.value,
    username: username.value,
    password: password.value,
    presenter: resolved.presenter.value,
    expiresInSeconds: resolved.tokenLifetime.value,
  });
  return `${base}/join?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// The admin status projection
// ---------------------------------------------------------------------------

function fieldStatus<T>(resolved: ResolvedField<T>): MirotalkFieldStatus {
  return {
    effective: resolved.display,
    source: resolved.source,
    problem: resolved.problem,
  };
}

/**
 * Project the resolution onto what the screen and the admin API may see.
 *
 * IT TAKES THE META, NOT THE SECRET. {@link ResolvedSecretMeta} has no field a
 * plaintext fits into, so the leak this function used to guard against by
 * convention — "written field by field, and never as a spread", because a
 * spread of the wider shape would have carried `value` into a JSON response
 * silently — is unrepresentable here now: there is no value in scope to reach
 * for. The fields are still named one by one, so ADDING one to the meta stays a
 * visible decision rather than an automatic disclosure.
 * `mirotalk-exposure-contract.test.ts` remains the behavioural half, driving
 * the real resolver with a sentinel secret.
 */
function secretStatus(
  meta: ResolvedSecretMeta,
  updatedAt: string | null,
): MirotalkSecretStatus {
  return {
    key: meta.key,
    source: meta.source,
    version: meta.version,
    updatedAt,
    needsReentry: meta.needsReentry,
  };
}

/**
 * Metadata-only configuration status for the setup page and the admin API.
 * NEVER returns a secret value. A database error propagates — an administrator
 * reading this screen must not be told "environment" because a read failed.
 */
export async function getMirotalkConfigurationStatus(): Promise<MirotalkConfigurationStatus> {
  // DROP THE CACHED ROWS FIRST. This screen is the first consumer that DEPENDS
  // on the concurrency token being current: every other caller of the store
  // passes the unconditional expectation, so a token up to 45 seconds old cost
  // them nothing. Here the token is what a Save or a Clear declares, and the
  // status also reads `updatedAt` straight from the database — so without this
  // the two halves disagree. In the two-container topology `docker-compose.yml`
  // documents, an administrator would see the new timestamp beside the old
  // version, press Clear, be told somebody else changed it first and to reload,
  // and reloading would hand back the same stale version for the rest of the
  // TTL. They loop, with no way out but waiting. Nothing else pays for it: this
  // is an admin screen read, not a join click.
  //
  // THE ACCEPTED COST, weighed in #2940's review (S4). The GET is `finance:
  // view`, so an admin who may not change any of this can still drop the cache
  // by reloading the page — each reload costing the next join click one decrypt
  // per secret instead of a cached read. It is kept because the correctness
  // above is not optional and nothing cheaper buys it: a read that skipped the
  // invalidation would hand out a version token the Save and Clear buttons on
  // the same screen then lose against, which is a loop the administrator cannot
  // get out of. The cost is bounded by three decrypts, is paid only by
  // authenticated admins, and is the same work a cold cache does anyway.
  invalidateProviderCredentialCache(MIROTALK_PROVIDER);
  const resolved = await resolveMirotalk();

  // METADATA COLUMNS ONLY — never ciphertext/iv/authTag, and never a value.
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: MIROTALK_PROVIDER,
      key: { in: [...MIROTALK_WRITABLE_CREDENTIAL_KEYS] },
    },
    select: { key: true, updatedAt: true },
  });
  const updatedAtByKey = new Map(
    rows.map((row) => [row.key, row.updatedAt.toISOString()]),
  );

  return {
    baseUrl: fieldStatus(resolved.baseUrl),
    presenter: fieldStatus(resolved.presenter),
    tokenLifetime: fieldStatus(resolved.tokenLifetime),
    secrets: resolved.secrets.map((secret) =>
      secretStatus(secret.meta, updatedAtByKey.get(secret.meta.key) ?? null),
    ),
    tokenMintable: resolved.secrets.every((secret) => Boolean(secret.value)),
  };
}
