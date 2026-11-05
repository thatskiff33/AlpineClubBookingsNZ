import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import logger from "@/lib/logger";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import type { LoginSecurityPolicy } from "@/lib/password-policy";
import { BREACHED_PASSWORD_RANGE_URL } from "@/lib/breached-password-endpoint";

// Breached-password check for a CHOSEN password (#4610, INV-AUTH-005).
//
// The one helper every place a person chooses a password calls before hashing
// it; `password-hash-writer-census.test.ts` fails a `passwordHash` writer that
// neither calls `screenChosenPassword` first nor is listed as exempt.
//
// k-anonymity range method: the password is SHA-1 hashed here, only the first
// five hex characters of that hash are sent, and the service answers with every
// listed hash suffix sharing that prefix (padded with zero-count decoys). The
// match is made locally, so neither the password, the full hash nor anything
// naming the member leaves the server. Nothing here logs the prefix, and the
// shared Sentry privacy options (`sentry-privacy-options.ts`) drop or scrub any
// span, breadcrumb or event that would carry the range URL.
//
// It fails open: a slow (over three seconds), unreachable or malformed answer
// accepts the password and logs the failure without the prefix. An outage
// elsewhere must never stop members setting a password or finishing setup.

export { BREACHED_PASSWORD_RANGE_URL };
export const BREACHED_PASSWORD_PREFIX_LENGTH = 5;
export const BREACHED_PASSWORD_TIMEOUT_MS = 3_000;

export const BREACHED_PASSWORD_CODE = "PASSWORD_BREACHED";
export const BREACHED_PASSWORD_MESSAGE =
  "This password has appeared in a public data breach, so attackers are likely to try it. Please choose a different password.";

export type BreachedPasswordLookup = "breached" | "not_breached" | "unavailable";

type UnavailableReason = "timeout" | "http_status" | "network_error" | "malformed";

class BreachServiceError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly status?: number,
  ) {
    super(reason);
  }
}

const HEX_SUFFIX_LENGTH = 40 - BREACHED_PASSWORD_PREFIX_LENGTH;
const RANGE_LINE = new RegExp(`^([0-9A-F]{${HEX_SUFFIX_LENGTH}}):(\\d+)$`);

/** True when `body` lists `suffix` with a non-zero count (zero is padding). */
function rangeListsSuffix(body: string, suffix: string): boolean {
  let parsedAny = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().toUpperCase();
    if (!line) continue;
    const match = RANGE_LINE.exec(line);
    if (!match) throw new BreachServiceError("malformed");
    parsedAny = true;
    if (match[1] === suffix && Number(match[2]) > 0) return true;
  }
  // A 200 with no hash lines at all is not an answer the service gives.
  if (!parsedAny) throw new BreachServiceError("malformed");
  return false;
}

/**
 * Ask the range service whether `password` is listed. Never throws: every
 * failure, including the three-second timeout, is `"unavailable"`.
 */
export async function lookupBreachedPassword(
  password: string,
): Promise<BreachedPasswordLookup> {
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = digest.slice(0, BREACHED_PASSWORD_PREFIX_LENGTH);
  const suffix = digest.slice(BREACHED_PASSWORD_PREFIX_LENGTH);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, BREACHED_PASSWORD_TIMEOUT_MS);
  });

  const lookup = (async (): Promise<Exclude<BreachedPasswordLookup, "unavailable">> => {
    let response: Response;
    try {
      response = await fetch(`${BREACHED_PASSWORD_RANGE_URL}${prefix}`, {
        method: "GET",
        // Padding makes every answer a similar size, so the response length
        // says nothing about the prefix to anyone watching the wire.
        headers: { "Add-Padding": "true" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new BreachServiceError("network_error");
    }
    if (!response.ok) throw new BreachServiceError("http_status", response.status);
    return rangeListsSuffix(await response.text(), suffix) ? "breached" : "not_breached";
  })();
  // The race below may settle on the timeout first; the abandoned lookup's
  // later rejection must not surface as an unhandled rejection.
  lookup.catch(() => undefined);

  try {
    const outcome = await Promise.race([lookup, timedOut]);
    if (outcome === "timeout") {
      logUnavailable("timeout");
      return "unavailable";
    }
    return outcome;
  } catch (error) {
    if (error instanceof BreachServiceError) {
      logUnavailable(error.reason, error.status);
    } else {
      logUnavailable("network_error");
    }
    return "unavailable";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Logs only the failure class (and an HTTP status): never the prefix, the
// password, the URL or the raw error, which could carry either.
function logUnavailable(reason: UnavailableReason, status?: number) {
  logger.warn(
    { reason, ...(status === undefined ? {} : { status }) },
    "Breached-password check unavailable; password accepted (fail open)",
  );
}

export type ChosenPasswordRefusal = {
  ok: false;
  error: string;
  code: typeof BREACHED_PASSWORD_CODE;
};
export type ChosenPasswordScreen = { ok: true } | ChosenPasswordRefusal;

/**
 * The one HTTP answer to a refused chosen password: 400 with the message and
 * `PASSWORD_BREACHED`, so every route refuses it the same way (`INV-SSOT`).
 */
export function breachedPasswordRefusal(screen: ChosenPasswordRefusal): NextResponse {
  return NextResponse.json({ error: screen.error, code: screen.code }, { status: 400 });
}

/**
 * Screen a password a person has just chosen, before it is hashed and stored.
 * Pass the club policy when the caller already loaded it; otherwise it is read
 * here. With the club's check switched off no request is made at all.
 */
export async function screenChosenPassword(
  password: string,
  policy?: Pick<LoginSecurityPolicy, "breachedPasswordCheck">,
): Promise<ChosenPasswordScreen> {
  const effective = policy ?? (await loadLoginSecuritySettings()).policy;
  if (!effective.breachedPasswordCheck) return { ok: true };
  if ((await lookupBreachedPassword(password)) !== "breached") return { ok: true };
  return { ok: false, error: BREACHED_PASSWORD_MESSAGE, code: BREACHED_PASSWORD_CODE };
}
