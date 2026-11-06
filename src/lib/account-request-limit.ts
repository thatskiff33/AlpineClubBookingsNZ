/**
 * Per-account limits on the public requests that email an account a link —
 * forgot-password and the emailed sign-in link (#4613, INV-AUTH-005).
 *
 * The per-address limiters on those routes cannot see one account requested
 * from many addresses, so a sender spread across them could fill a member's
 * inbox from the club's sending quota. This counts requests per ACCOUNT KEY as
 * well: the same HMAC of the normalised email that the password throttle uses
 * (`loginAccountKey`, INV-AUTH-001), so the address never reaches the counter
 * table or a log. The counter is the ordinary shared `RateLimitCounter`, with
 * its #1142 per-process fallback, so no second store or keying exists.
 *
 * The caller decides from the key alone, before it reads any Member, and a
 * limited request gets the same answer as an accepted one: unknown emails are
 * counted exactly like real ones, so the limit says nothing about which
 * accounts exist.
 */
import "server-only";

import { loginAccountKey, loginAccountMemoryKey } from "./login-throttle";
import {
  checkRateLimit,
  checkRateLimitInMemory,
  type RateLimitConfig,
  type RateLimitResult,
} from "./rate-limit";

/** Namespace for account keys, so one can never collide with an address key. */
const ACCOUNT_KEY_PREFIX = "account:";

/**
 * Counts one request for `email` against `config` and says whether it is
 * within the account's budget. Never throws, and never refuses because a
 * store failed: a shared-store failure falls back inside `checkRateLimit` to
 * the per-process count at the #1142 divided budget.
 *
 * Without an auth secret the HMAC cannot be formed, and an unkeyed digest of
 * an email must never reach the shared table, so the count stays in this
 * process at that same degraded budget.
 */
export async function checkAccountRequestLimit(
  config: RateLimitConfig,
  email: string,
): Promise<RateLimitResult> {
  let accountKey: string;
  try {
    accountKey = loginAccountKey(email);
  } catch {
    return checkRateLimitInMemory(
      config,
      ACCOUNT_KEY_PREFIX + loginAccountMemoryKey(email),
      { degraded: true },
    );
  }
  return checkRateLimit(config, ACCOUNT_KEY_PREFIX + accountKey);
}
