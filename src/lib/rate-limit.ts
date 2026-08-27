/**
 * Rate limiter for Next.js API routes (fixed window with automatic cleanup).
 *
 * Counters live in Postgres (`RateLimitCounter`, one atomic upsert per check)
 * so multiple replicas and blue/green slots share the same window (#1039
 * item 4). When the database is unreachable the limiter falls back to the
 * original per-process in-memory counters — degraded to per-instance limiting
 * rather than failing the request. Auth-sensitive limiters fall back at a
 * reduced budget (limit / DEGRADED_AUTH_LIMIT_DIVISOR, issue #1142) so the
 * degraded window cannot be used to multiply a brute-force budget.
 */

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { decodeRawRows, rawIntColumn } from "@/lib/raw-sql-rows";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
    // Stop cleanup timer when store is empty
    if (store.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't prevent Node.js from exiting
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export interface RateLimitConfig {
  /** Unique identifier for this limiter (e.g. "login", "register") */
  id: string;
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /**
   * Credential-guessing or public-abuse surface (login, password reset,
   * two-factor codes, public forms). When the shared Postgres counter is
   * unavailable these limiters do not fall back at full strength: the
   * per-process fallback runs at limit / DEGRADED_AUTH_LIMIT_DIVISOR
   * (issue #1142) so an attacker cannot multiply their brute-force budget
   * by degrading the store or spreading across replicas. Fail-closed was
   * rejected: a limiter-store-local fault (table lock, migration drift)
   * must not turn into a full login outage while auth queries still work.
   */
  authSensitive?: boolean;
}

/**
 * Divisor applied to an auth-sensitive limiter's budget while running on the
 * per-process fallback. 4 covers the blue/green double-slot deployment plus
 * headroom for process restarts resetting in-memory counters mid-window.
 */
const DEGRADED_AUTH_LIMIT_DIVISOR = 4;

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

// test seam
/**
 * Per-process fallback limiter (the pre-#1039 behaviour). Exported for tests;
 * production traffic goes through `checkRateLimit`, which only lands here
 * when the shared Postgres counter is unavailable.
 */
export function checkRateLimitInMemory(
  config: RateLimitConfig,
  key: string,
  options: { degraded?: boolean } = {}
): RateLimitResult {
  ensureCleanup();

  // Degraded mode (shared store unreachable): auth-sensitive limiters run at
  // a fraction of their budget because per-process counting no longer sees
  // traffic hitting other replicas — see RateLimitConfig.authSensitive.
  const effectiveLimit =
    options.degraded && config.authSensitive
      ? Math.max(1, Math.floor(config.limit / DEGRADED_AUTH_LIMIT_DIVISOR))
      : config.limit;

  const storeKey = `${config.id}:${key}`;
  const now = Date.now();
  const entry = store.get(storeKey);

  // No existing entry or window expired - create new
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + config.windowSeconds * 1000;
    store.set(storeKey, { count: 1, resetAt });
    return {
      success: effectiveLimit >= 1,
      limit: effectiveLimit,
      remaining: Math.max(0, effectiveLimit - 1),
      resetAt,
    };
  }

  // Within window - increment
  entry.count++;

  if (entry.count > effectiveLimit) {
    return {
      success: false,
      limit: effectiveLimit,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  return {
    success: true,
    limit: effectiveLimit,
    remaining: effectiveLimit - entry.count,
    resetAt: entry.resetAt,
  };
}

let lastRateLimitDbErrorLogAt = 0;
const RATE_LIMIT_DB_ERROR_LOG_INTERVAL_MS = 60 * 1000;

/**
 * The shape the upsert below actually RETURNS, checked at runtime (#2289).
 *
 * This is the one raw statement in `src/` whose result is read and which cannot
 * be expressed through a Prisma model — the whole point is the atomic
 * `CASE ... RETURNING` upsert, which restarts an expired window and increments a
 * live one in a single statement with no read-modify-write race. So it keeps its
 * raw SQL and gets a decoder instead: a renamed or retyped column now throws
 * naming itself, rather than yielding `undefined` and letting `Number(undefined)`
 * become `NaN` — under which `NaN > config.limit` is false and EVERY request is
 * allowed. A rate limiter that silently stops limiting is the exact failure this
 * class produces, and the fallback below would never see it, because there is no
 * error to catch.
 *
 * `count` is an `int4` column, so it arrives as a number; `rawIntColumn` also
 * accepts the BigInt a future `COUNT(*)`-style rewrite would return.
 *
 * WHERE THE THROW LANDS, deliberately: inside the existing `try`, so a shape
 * mismatch is treated as exactly what it is — the shared store failing to answer
 * usefully — and the request drops to the per-process fallback, with the error
 * logged. That keeps the limiter's standing decision that a store-local fault
 * must not become a login outage, while still turning a mismatch into a visible
 * error instead of a silent `NaN` that waves everything through.
 *
 * BE PRECISE ABOUT WHAT THE FALLBACK BUYS, because it is easy to over-read.
 * `degraded: true` only *reduces* the budget for `authSensitive` limiters
 * (`checkRateLimitInMemory` above); for the majority — `api`, `bookingQuery`,
 * `bookingCreate`, the member-guest resolve/search/add-probe throttles,
 * `dataExport`, `deletionRequest`, the group-booking limiters — the degraded
 * budget IS the full budget, now counted per process. And a shape mismatch is
 * PERMANENT, not a blip: every call throws until the schema is fixed, so a
 * two-replica deployment enforces each of those budgets twice over, with the
 * window resetting on every restart. That is still strictly better than what it
 * replaces (`Number(undefined)` → `NaN`, under which `NaN > limit` is false and
 * every request is allowed, forever, silently), which is why the throw belongs
 * here rather than outside the `try` — but the fallback is a floor, not a fix.
 * The `RawSqlShapeError` travels in `err` to the logger and to Sentry naming the
 * column, so the fix is the alert, not the fallback.
 */
const RATE_LIMIT_UPSERT_ROW = z.object({
  count: rawIntColumn,
  resetAt: z.date(),
});

/**
 * Check the shared rate limit for a given key (typically IP address). One
 * atomic upsert: expired windows restart, live windows increment. Falls back
 * to the per-process in-memory limiter when the database is unavailable.
 */
export async function checkRateLimit(
  config: RateLimitConfig,
  key: string
): Promise<RateLimitResult> {
  const storeKey = `${config.id}:${key}`;
  const now = new Date();
  const newResetAt = new Date(now.getTime() + config.windowSeconds * 1000);

  try {
    const returned = await prisma.$queryRaw`
      INSERT INTO "RateLimitCounter" ("id", "count", "resetAt")
      VALUES (${storeKey}, 1, ${newResetAt})
      ON CONFLICT ("id") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitCounter"."resetAt" <= ${now} THEN 1
          ELSE "RateLimitCounter"."count" + 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitCounter"."resetAt" <= ${now} THEN ${newResetAt}
          ELSE "RateLimitCounter"."resetAt"
        END
      RETURNING "count", "resetAt"
    `;

    const rows = decodeRawRows(returned, RATE_LIMIT_UPSERT_ROW, "rate-limit upsert");
    const row = rows[0];
    if (!row) {
      throw new Error("Rate limit upsert returned no row");
    }
    const count = row.count;
    const resetAt = row.resetAt.getTime();
    scheduleSharedCleanup();

    if (count > config.limit) {
      return { success: false, limit: config.limit, remaining: 0, resetAt };
    }
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit - count,
      resetAt,
    };
  } catch (err) {
    if (
      Date.now() - lastRateLimitDbErrorLogAt >
      RATE_LIMIT_DB_ERROR_LOG_INTERVAL_MS
    ) {
      lastRateLimitDbErrorLogAt = Date.now();
      logger.error(
        { err, limiterId: config.id, authSensitive: config.authSensitive === true },
        "Shared rate-limit store unavailable; falling back to per-process limiting"
      );
    }
    return checkRateLimitInMemory(config, key, { degraded: true });
  }
}

// Delete expired shared counters occasionally so the table stays small. The
// timer mirrors the in-memory cleanup and never blocks a request.
let sharedCleanupTimer: ReturnType<typeof setInterval> | null = null;

function scheduleSharedCleanup() {
  if (sharedCleanupTimer) return;
  sharedCleanupTimer = setInterval(() => {
    prisma
      .$executeRaw`DELETE FROM "RateLimitCounter" WHERE "resetAt" <= ${new Date()}`.catch(
      () => {
        // Cleanup is best-effort; expired rows are also overwritten in place.
      }
    );
  }, CLEANUP_INTERVAL_MS);
  if (
    sharedCleanupTimer &&
    typeof sharedCleanupTimer === "object" &&
    "unref" in sharedCleanupTimer
  ) {
    sharedCleanupTimer.unref();
  }
}

/**
 * Get the client IP from a request, considering common proxy headers.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Use the LAST IP in the chain — Caddy (our reverse proxy) appends the real client IP,
    // so the first value is attacker-controllable but the last one is trustworthy.
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

/**
 * Build the standard 429 response for a rate-limit denial, with Retry-After and
 * X-RateLimit-* headers. Shared by applyRateLimit (per-IP) and any handler that
 * calls checkRateLimit directly (e.g. per-member / global limiters) so every
 * 429 carries identical headers.
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
  return new Response(
    JSON.stringify({
      error: "Too many requests. Please try again later.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(result.resetAt),
      },
    }
  );
}

/**
 * Apply rate limiting to a request. Returns a Response if rate limited, null if allowed.
 */
export async function applyRateLimit(
  config: RateLimitConfig,
  request: Request
): Promise<Response | null> {
  const ip = getClientIp(request);
  const result = await checkRateLimit(config, ip);

  if (!result.success) {
    return rateLimitedResponse(result);
  }

  return null;
}

/**
 * How much bigger the shared-IP budget is than one member's, on a member-scoped
 * limiter.
 *
 * THE MEMBER KEY IS THE CONTROL; THE IP KEY IS A BACKSTOP, and that asymmetry has
 * to be in the numbers or the function does the opposite of what its own docblock
 * claims (privacy review of MG3 #2308, finding M1). Checking `ip:` with the SAME
 * limit as `member:` leaves the shared-network budget exactly where per-IP-only
 * limiting left it: ten members on the lodge wifi making five cross-family quote
 * attempts each exhaust a fifty-a-day cap for the whole building, and the 429
 * they get names nothing they can act on.
 *
 * Ten is chosen as "a plausibly large household or club night, and nothing like a
 * script": it lets a real shared network work while still cutting off a single
 * address issuing an order of magnitude more traffic than the member budget can
 * explain (which is the only thing the IP key can honestly detect once every
 * caller is authenticated).
 */
export const MEMBER_SCOPED_IP_LIMIT_MULTIPLIER = 10;

/**
 * Rate limit an AUTHENTICATED surface by acting member, with a much larger
 * shared-IP backstop. Returns a `Response` when either budget is spent.
 *
 * WHY `applyRateLimit` IS THE WRONG TOOL FOR THESE SURFACES. It keys on the
 * client IP alone, which is right for a public door and wrong for an
 * authenticated enumeration surface, in both directions at once:
 *
 *  - one household behind a single NAT — a family all booking from the lodge's
 *    own wifi, or a club night — shares ONE budget, so an honest member is
 *    locked out by their relatives;
 *  - one member can rotate addresses (phone data, a VPN, a coffee shop) and get
 *    a fresh budget each time, which is precisely what somebody probing the
 *    membership list would do.
 *
 * The member key closes the second hole outright. The first is closed by SIZING
 * rather than by dropping the IP check: the shared key carries
 * `MEMBER_SCOPED_IP_LIMIT_MULTIPLIER` times the per-member budget, so a NAT full
 * of honest members never reaches it and a single address behaving like ten
 * members still does. Both keys are namespaced (`ip:` / `member:`) so a member id
 * that happens to look like an address cannot collide with one, and both counters
 * live under the same limiter id.
 *
 * The IP key is checked FIRST so an unauthenticated flood is rejected before it
 * can cost a member-keyed write.
 *
 * The pattern was already written by hand in the whole-lodge request routes
 * (#2263); this is that pattern lifted into one function so MG3's find routes
 * and the add-path throttle cannot get the ordering or the namespacing subtly
 * different.
 */
export async function applyMemberScopedRateLimit(
  config: RateLimitConfig,
  request: Request,
  memberId: string
): Promise<Response | null> {
  const ipResult = await checkRateLimit(
    // Same limiter id, so the counter row is the same one it always was — only
    // the threshold this key is judged against changes.
    { ...config, limit: config.limit * MEMBER_SCOPED_IP_LIMIT_MULTIPLIER },
    `ip:${getClientIp(request)}`,
  );
  if (!ipResult.success) {
    return rateLimitedResponse(ipResult);
  }

  const memberResult = await checkRateLimit(config, `member:${memberId}`);
  if (!memberResult.success) {
    return rateLimitedResponse(memberResult);
  }

  return null;
}

// Pre-configured rate limiters for common routes
export const rateLimiters = {
  /** Login: 10 attempts per 15 minutes */
  login: { id: "login", limit: 10, windowSeconds: 15 * 60, authSensitive: true } as RateLimitConfig,
  /** Register: 5 attempts per hour */
  register: { id: "register", limit: 5, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Membership application: 3 submissions per hour */
  membershipApplication: { id: "membership-application", limit: 3, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Password reset request: 5 per hour */
  forgotPassword: { id: "forgot-password", limit: 5, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Magic-link sign-in request: 5 per hour (mirrors forgot-password) */
  magicLinkRequest: { id: "magic-link-request", limit: 5, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Password reset submission: 10 per hour */
  resetPassword: { id: "reset-password", limit: 10, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** General API: 100 per minute */
  api: { id: "api", limit: 100, windowSeconds: 60 } as RateLimitConfig,
  /** Booking creation: 20 per hour */
  bookingCreate: { id: "booking-create", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Booking quote / availability / promo validate: 60 per minute */
  bookingQuery: { id: "booking-query", limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Public address autocomplete proxy: 90 requests per minute */
  addressAutocomplete: { id: "address-autocomplete", limit: 90, windowSeconds: 60 } as RateLimitConfig,
  /** Contact form: 10 per hour */
  contact: { id: "contact", limit: 10, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Lodge hut leader PIN login: 5 attempts per minute */
  lodgePinLogin: { id: "lodge-pin-login", limit: 5, windowSeconds: 60, authSensitive: true } as RateLimitConfig,
  /** Lobby display pairing start + admin code bind: 10 per 15 minutes */
  displayPairing: { id: "display-pairing", limit: 10, windowSeconds: 15 * 60, authSensitive: true } as RateLimitConfig,
  /** Lobby display claim poll (signed-blob-bound, not guessable): 30 per minute */
  displayClaim: { id: "display-claim", limit: 30, windowSeconds: 60 } as RateLimitConfig,
  /** Resend verification email: 3 per hour */
  resendVerification: { id: "resend-verification", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Request email change: 3 per hour */
  requestEmailChange: { id: "request-email-change", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Token-bearing verification links: 10 hits per 15 minutes */
  verificationToken: { id: "verification-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Two-factor code verification and email-code sends: 10 attempts per 10 minutes */
  twoFactorVerify: { id: "two-factor-verify", limit: 10, windowSeconds: 10 * 60, authSensitive: true } as RateLimitConfig,
  /** Guest chore token routes: 20 hits per 15 minutes */
  guestChoreToken: { id: "guest-chore-token", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Booking .ics calendar download (fork #35): 30 hits per 15 minutes — a one-shot email download; the headroom absorbs mail-client link prefetchers and household re-clicks, and starves token guessing */
  bookingCalendarDownload: { id: "booking-calendar-download", limit: 30, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Family group join request: 3 per hour */
  familyGroupJoinRequest: { id: "family-group-join-request", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Personal data export: 5 per day */
  dataExport: { id: "data-export", limit: 5, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Account deletion request: 3 per day */
  deletionRequest: { id: "deletion-request", limit: 3, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Membership cancellation request: 3 per day */
  membershipCancellationRequest: { id: "membership-cancellation-request", limit: 3, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Membership cancellation confirmation links: 10 per 15 minutes */
  membershipCancellationConfirmation: { id: "membership-cancellation-confirmation", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Booking change review requests: 5 per day */
  bookingChangeRequest: { id: "booking-change-request", limit: 5, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Public non-member booking request submission: 5 per hour */
  bookingRequest: { id: "booking-request", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /**
   * Member whole-lodge booking request submission (#2263): 5 per hour.
   * Deliberately no cheaper than the public/school door's `bookingRequest`
   * limiter — an authenticated door must not be the easier one to hammer.
   * Applied per-IP and again per-member, so neither a shared network nor a
   * rotating address is a free pass.
   */
  memberWholeLodgeRequest: { id: "member-whole-lodge-request", limit: 5, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /** Member whole-lodge request withdrawal (#2263): 20 per hour */
  memberWholeLodgeWithdraw: { id: "member-whole-lodge-withdraw", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public booking request verification links: 10 hits per 15 minutes */
  bookingRequestToken: { id: "booking-request-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Tokenised public payment link pages and payment intents: 20 hits per 15 minutes */
  paymentLinkToken: { id: "payment-link-token", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Organiser opens a group on their booking: 20 per hour */
  groupBookingCreate: { id: "group-booking-create", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public group-booking code lookup: 20 hits per 15 minutes (anti-enumeration) */
  groupBookingLookup: { id: "group-booking-lookup", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Public ski-condition widgets: 60 hits per minute, backed by server-side caching */
  skifieldConditions: { id: "skifield-conditions", limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Member self-add to a group (a booking creation): 20 per hour */
  groupBookingJoin: { id: "group-booking-join", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public non-member group join request: 5 per hour */
  groupBookingJoinRequest: { id: "group-booking-join-request", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Group join verification links: 10 hits per 15 minutes */
  groupBookingToken: { id: "group-booking-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /**
   * Member-guest consent answers (#2307): 30 per 15 minutes.
   *
   * Deliberately tight relative to how often a real person answers a request
   * (once), because the endpoint takes two ids and returns a uniform 403 for
   * every failure — the only way to probe it at all is volume, and this is what
   * makes that uneconomic. `authSensitive` so a degraded shared-store fallback
   * cannot be used to multiply the allowance.
   */
  memberGuestConsentRespond: { id: "member-guest-consent-respond", limit: 30, windowSeconds: 15 * 60, authSensitive: true } as RateLimitConfig,
  /**
   * Member-guest EMAIL resolve (#2308): 20 per 15 minutes, per IP and per member.
   *
   * Deliberately NOT `authSensitive`. Degrading it to a quarter on a shared-store
   * outage would cut a legitimate booker off at five lookups mid-flow, and the
   * surface it protects returns only a name and an age tier for an address the
   * caller already possessed — a much smaller prize than a login attempt. The
   * real controls here are the uniform envelope and the audit trail; this cap
   * exists so that GUESSING addresses is uneconomic, not to defend a secret.
   */
  memberGuestResolve: { id: "member-guest-resolve", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /**
   * Member-guest EMAIL resolve, DAILY (#2308): 400 per 24 hours per member.
   *
   * ADDED BY THE PRIVACY REVIEW (finding M3), and the reason is the arithmetic
   * the burst window hides: 20 per 15 minutes with no daily backstop is 1,920
   * lookups per member per day. The open name search — the mode the owner
   * explicitly accepted as browsable and which ships OFF — is capped at 400 a
   * day, so the DEFAULT-ON mode carried a budget nearly five times larger than
   * the opt-in one. This mirrors the search cap so neither mode is the cheap way
   * in.
   *
   * It is a backstop, not the control: guessing addresses is uneconomic because
   * an address has to be guessed at all, and because every attempt is audited
   * with the address on it.
   */
  memberGuestResolveDaily: { id: "member-guest-resolve-daily", limit: 400, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /**
   * Member-guest NAME type-ahead (#2308): 60 per 5 minutes, per IP and per member.
   *
   * Sized for the interaction rather than for an attacker: a 300 ms debounce and
   * a two-character floor mean a fifteen-letter name costs four to six queries,
   * so an ordinary booker uses well under ten. The five-minute window smooths
   * bursts; it is NOT the anti-harvest control — that is the daily cap below.
   */
  memberGuestSearch: { id: "member-guest-search", limit: 60, windowSeconds: 5 * 60 } as RateLimitConfig,
  /**
   * Member-guest name type-ahead, DAILY (#2308): 400 per 24 hours per member.
   *
   * This is the actual anti-harvest cap, and it is honest about what it buys —
   * corrected by the privacy review (finding M2), because the number it used to
   * claim was wrong by a factor of several. With open search ON the membership
   * list is browsable BY DESIGN, and 400 queries a day is NOT weeks of work: the
   * 676 two-letter prefixes alone are covered in under two days, and for a club
   * of a few hundred members most prefixes fall under the ten-row cap, so the
   * roll is essentially complete at that point.
   *
   * What the cap therefore buys is not infeasibility. It buys TIME AND
   * VISIBILITY: a harvest takes days rather than minutes, and it leaves up to 400
   * audit rows a day carrying the member's name and the exact fragments they
   * typed. That is the trade the owner accepted when they turned this setting on
   * (MG3-D-b), and the admin toggle says so in those words.
   */
  memberGuestSearchDaily: { id: "member-guest-search-daily", limit: 400, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /**
   * CROSS-FAMILY member-guest add attempts on the booking add paths (#2388):
   * 15 per 15 minutes and 50 per day, per acting member.
   *
   * THE OWNER'S 31 JUL DECISION, and the reason it is a separate limiter rather
   * than a tightening of `bookingQuery`: the channel #2388 describes is a run of
   * quote/create attempts naming ONE other member across many dates, from which
   * the pattern of refusals maps the nights that member is already booked. So
   * this limiter counts only the attempts that actually name a beyond-family
   * member, which means an ordinary family booking — the overwhelming majority,
   * forever — is not rate-limited by it at all, however many times the booker
   * changes their dates.
   *
   * THE SIZING, STATED HONESTLY — corrected by the privacy review (finding M2),
   * which caught this docblock overstating what it buys by a factor of about
   * seven. Fifty cross-family attempts a day is NOT "three weeks to map a
   * season": a lodge season is roughly 150 nights, so at 50 a day a single
   * member's season is mapped in about three days, and a whole year in about
   * seven and a half. What the cap actually does is turn an afternoon's scripted
   * run into days of patient work that leaves up to 50 audit rows a day naming
   * the prober and their target — while an honest booker, who would struggle to
   * exceed fifteen cross-family quote attempts in a sitting, never notices it.
   *
   * Closing the residual entirely would need an automatic block on repeated
   * refusals, which the owner explicitly rejected on #2388: the innocent case
   * (hunting for a date that suits a friend) is indistinguishable from the
   * probing one, and only a person can tell them apart.
   *
   * It is a THROTTLE, not the "cap or block on repeated refusals" the owner
   * explicitly rejected: it counts attempts (successful and refused alike), it
   * is not keyed on the target, it clears itself, and it never turns into a
   * permanent refusal. See `member-guest-probe-guard.ts`.
   */
  memberGuestAddProbe: { id: "member-guest-add-probe", limit: 15, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** The daily backstop for the above (#2388): 50 cross-family add attempts per member per day. */
  memberGuestAddProbeDaily: { id: "member-guest-add-probe-daily", limit: 50, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  // AI help assistant (#2211, C3). These caps only throttle abuse/burst; the
  // real spend cap is the monthly budget gate (checkAiBudget) in the route —
  // authSensitive so a degraded shared-store fallback cannot be used to multiply
  // paid-call budget across replicas.
  /** AI help chat per member: 10 questions per 10 minutes */
  aiChatMember: { id: "ai-chat-member", limit: 10, windowSeconds: 600, authSensitive: true } as RateLimitConfig,
  /** AI help chat per IP: 20 questions per 10 minutes */
  aiChatIp: { id: "ai-chat-ip", limit: 20, windowSeconds: 600, authSensitive: true } as RateLimitConfig,
  /**
   * AI help chat global backstop: 300 questions per day across the deployment.
   * authSensitive, so on a shared-store outage the degraded per-process fallback
   * runs at limit/4 (~75/process): the global 300/day effectively becomes ~75
   * per replica. That deliberately under-permits (fail-safe) — a degraded store
   * tightens, never loosens, the paid-call backstop.
   */
  aiChatGlobal: { id: "ai-chat-global", limit: 300, windowSeconds: 86400, authSensitive: true } as RateLimitConfig,
  // AI Diagnostics (AID-2, #2371) — a SEPARATE admin-only paid product with its
  // OWN abuse throttles, deliberately NOT the page-help aiChat* limiters above.
  // A diagnostics session is a multi-tool loop (several paid roundtrips), so
  // these are sized per SESSION and much tighter than page-help chat. The real
  // spend control is the concurrency-safe monthly reservation gate
  // (reserveDiagnosticsBudget); these caps stop bursts and abuse. All three are
  // authSensitive: on a degraded shared-store fallback they run at limit/4 so the
  // paid-call budget can never be multiplied across replicas — a store-local
  // fault TIGHTENS, never loosens, the paid-call backstop.
  /** AI Diagnostics per admin: 15 sessions per 10 minutes. */
  aiDiagnosticsAdmin: { id: "ai-diagnostics-admin", limit: 15, windowSeconds: 600, authSensitive: true } as RateLimitConfig,
  /** AI Diagnostics per IP: 30 sessions per 10 minutes (shared-network backstop). */
  aiDiagnosticsIp: { id: "ai-diagnostics-ip", limit: 30, windowSeconds: 600, authSensitive: true } as RateLimitConfig,
  /**
   * AI Diagnostics global backstop: 200 sessions per day across the deployment.
   * authSensitive, so on a shared-store outage the degraded per-process fallback
   * runs at limit/4 (~50/process): the global 200/day effectively becomes ~50
   * per replica. That deliberately under-permits (fail-safe) — a degraded store
   * tightens the paid-call backstop rather than loosening it.
   */
  aiDiagnosticsGlobal: { id: "ai-diagnostics-global", limit: 200, windowSeconds: 86400, authSensitive: true } as RateLimitConfig,
  // Maintenance reports (#2780). Three limiters, because the QR door and the
  // members' door are different risks and one budget cannot size both.
  /**
   * UNAUTHENTICATED per-lodge QR submissions: 5 per hour, per IP.
   *
   * Deliberately the same shape as `bookingRequest`, the other public form that
   * writes a row and mails an officer, because the abuse is the same abuse: an
   * anonymous POST that costs the club an email and a queue entry. Five an hour
   * is far more than a real person standing in a lodge needs (they report the
   * broken thing once) and far less than a script needs to be worth writing.
   *
   * `authSensitive`, so a degraded shared-store fallback runs it at limit/4
   * rather than handing an attacker a fresh full budget per replica. There is no
   * credential to guess here, but the *public form* half of that flag's
   * docblock is exactly what this is.
   */
  maintenanceReportAnonymous: { id: "maintenance-report-anonymous", limit: 5, windowSeconds: 60 * 60, authSensitive: true } as RateLimitConfig,
  /**
   * READS of the anonymous form's question set: 30 per 15 minutes, per IP.
   *
   * Separate from the submit budget on purpose. Loading the page is cheap and a
   * person may reload it, so throttling reads at the submit rate would break
   * honest use; but the read is also the only endpoint that answers anything at
   * all about a token, so it is the one an enumeration attempt would hammer.
   * Capping it is what makes guessing 2^256 tokens uneconomic in wall-clock
   * terms as well as in arithmetic.
   */
  maintenanceReportToken: { id: "maintenance-report-token", limit: 30, windowSeconds: 15 * 60, authSensitive: true } as RateLimitConfig,
  /**
   * Signed-in member submissions: 10 per hour, applied per member AND per IP
   * (the IP key at ten times the budget, via applyMemberScopedRateLimit).
   *
   * Deliberately NOT `authSensitive`: there is no credential behind it, and
   * quartering a member's allowance during a database blip would refuse a real
   * fault report at the moment somebody is standing in front of the fault.
   */
  maintenanceReportMember: { id: "maintenance-report-member", limit: 10, windowSeconds: 60 * 60 } as RateLimitConfig,
  /**
   * Club message board: 10 posts per hour per member (#2994).
   *
   * The board is a conversation, so the limit is set to stop one member filling
   * it rather than to make posting feel rationed - ten an hour is far above
   * ordinary use and far below what it takes to bury everyone else's posts.
   * Applied member-scoped, so the IP key carries ten times the budget and a
   * household or a lodge on one connection is not throttled as if it were one
   * person.
   *
   * Deliberately NOT `authSensitive`: there is no credential behind it, and
   * quartering the allowance during a database blip would silence the board at
   * the moment somebody is trying to tell the club something.
   */
  clubPostCreate: { id: "club-post-create", limit: 10, windowSeconds: 60 * 60 } as RateLimitConfig,
  // Deliberately below clubPostCreate's ten posts x six images: an upload holds
  // a decoded bitmap in memory while sharp works, so THIS limit rather than the
  // byte cap is what stops one member exhausting the container.
  clubPostImageUpload: { id: "club-post-image-upload", limit: 30, windowSeconds: 60 * 60 } as RateLimitConfig,
} as const;

// test seam
// Export for testing
export { store as _testStore };
