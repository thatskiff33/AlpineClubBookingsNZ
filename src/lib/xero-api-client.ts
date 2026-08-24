/**
 * Xero API Client Infrastructure
 *
 * Centralises:
 * - Rate-limit and transient-outage state (process-local cool-downs).
 * - Error classes raised when those cool-downs trip.
 * - Metered Xero API calls (callXeroApi) that record usage and observe limits.
 * - withXeroRetry retry loop for 429 / 5xx / 408 responses.
 * - getAuthenticatedXeroClient: returns a XeroClient with valid tokens,
 *   refreshing through a single in-process mutex.
 *
 * Higher-level helpers (contact repair, sync, invoices) live in src/lib/xero.ts.
 */

import { XeroClient } from "xero-node";
import logger from "@/lib/logger";
import {
  recordXeroApiUsage,
  type XeroRateLimitCategory,
} from "@/lib/xero-api-usage";
import {
  getXeroErrorBodyMessage,
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";
import { getOperationalXeroConfig } from "@/lib/xero-config";
import { assertXeroProviderWriteAllowed } from "@/lib/xero-environment-write-gate";
import { createXeroClient } from "./xero-oauth";
import {
  XERO_TOKEN_REFRESH_LEASE_MS,
  claimXeroTokenRefreshLease,
  loadXeroTokens,
  releaseXeroTokenRefreshLease,
  saveXeroTokens,
  type XeroTokenRecord,
} from "./xero-token-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_XERO_TRANSIENT_MAX_RETRIES = 1;
const XERO_TRANSIENT_FAILURE_COOLDOWN_SEC = 120;

// Xero tokens expire after 30 minutes; refresh 10 minutes early
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes — buffer for long-running bulk ops (contact sync, membership refresh)
const TOKEN_REFRESH_POLL_MS = 250;
const TOKEN_REFRESH_WAIT_GRACE_MS = 5 * 1000;

// ---------------------------------------------------------------------------
// Rate-limit / transient outage state
// ---------------------------------------------------------------------------

// Cache the daily-limit cooldown in-process so we stop hammering Xero until Retry-After expires.
let xeroDailyLimitUntilMs = 0;
let xeroTransientOutageUntilMs = 0;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class XeroDailyLimitError extends Error {
  retryAfterSec: number;
  /**
   * `true` only when this error was raised by the pre-HTTP daily gate
   * (`throwIfXeroDailyLimitActive`, also re-checked inside
   * `getAuthenticatedXeroClient`) — i.e. the operation was refused BEFORE any
   * request reached Xero and nothing was sent. `false` when `withXeroRetry`
   * minted it from a real HTTP 429 that Xero itself returned carrying
   * `x-rate-limit-problem: day` — an ATTEMPTED call whose provider-side effect
   * is unknown. The outbox keys its FAILED→PENDING auto-re-drive on this marker
   * (#2423 review F2), so it only re-drives operations that provably never
   * reached Xero; default `false` keeps any new construction site fail-safe
   * (attempted → replayable FAILED path) until it opts in.
   */
  readonly preHttp: boolean;
  constructor(retryAfterSec: number, preHttp = false) {
    super(
      `Xero daily API limit reached. Retry after ${retryAfterSec} seconds (~${Math.round(retryAfterSec / 3600)} hours). Please try again tomorrow.`
    );
    this.name = "XeroDailyLimitError";
    this.retryAfterSec = retryAfterSec;
    this.preHttp = preHttp;
  }
}

// test seam
export class XeroTransientOutageError extends Error {
  retryAfterSec: number;
  /**
   * See `XeroDailyLimitError.preHttp`. This class has only the pre-HTTP
   * construction site today (`throwIfXeroTransientOutageActive`) — the
   * post-HTTP transient path rethrows the raw Xero error, never this class — so
   * it is always `true` in practice, but the marker is carried explicitly so
   * the outbox's re-drive predicate is symmetric and stays safe if a future
   * post-HTTP construction site is ever added (it would default to `false`).
   */
  readonly preHttp: boolean;

  constructor(retryAfterSec: number, preHttp = false) {
    super(
      `Xero is temporarily unavailable. Suppressing further Xero calls for ${retryAfterSec} seconds to protect API quota.`
    );
    this.name = "XeroTransientOutageError";
    this.retryAfterSec = retryAfterSec;
    this.preHttp = preHttp;
  }
}

/**
 * Raised at the token/tenant sites that indicate the Xero connection can only
 * be restored by an admin re-authorising it (missing tokens, missing tenant, or
 * a refresh that failed with an identity-level auth error such as a revoked
 * refresh token). Distinct from XeroTransientOutageError, which the retry/gate
 * machinery raises for temporary unavailability the caller should retry.
 *
 * getXeroApiErrorInfo maps this class (name-keyed) to the same 401-style
 * "reconnect Xero" client message a live 401/403 produces, and the lock-date
 * guard classifies it as reason "reconnect_required".
 */
export class XeroReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroReconnectRequiredError";
  }
}

/**
 * A token-refresh failure means "reconnect Xero" only when the identity
 * endpoint rejected the refresh token itself — an `invalid_grant` / HTTP 400
 * (revoked, expired, or already-rotated refresh token). A transient identity
 * 5xx (or a network blip with no status) leaves the refresh token valid and is
 * a retryable outage, NOT a reconnect situation, so it stays an ordinary Error.
 */
function refreshFailureRequiresReconnect(err: unknown): boolean {
  const statusCode = getXeroErrorStatusCode(err);
  if (statusCode !== undefined && statusCode >= 500) {
    return false;
  }
  if (statusCode === 400 || statusCode === 401) {
    return true;
  }
  const text = getXeroErrorSearchText(err);
  return (
    text.includes("invalid_grant") ||
    text.includes("invalid grant") ||
    text.includes("unauthorized_client")
  );
}

// ---------------------------------------------------------------------------
// Authenticated Xero client (with auto-refresh)
// ---------------------------------------------------------------------------

// Simple mutex to prevent concurrent token refreshes from using the same refresh token
let _tokenRefreshPromise: Promise<{ xero: XeroClient; tenantId: string }> | null = null;

function tokenNeedsRefresh(tokens: XeroTokenRecord, now = Date.now()) {
  return now >= tokens.expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildAuthenticatedXeroClient(
  tokens: XeroTokenRecord
): Promise<{ xero: XeroClient; tenantId: string }> {
  if (!tokens.tenantId) {
    throw new XeroReconnectRequiredError("Xero tenant ID not found. Please reconnect Xero.");
  }

  const xero = await createXeroClient();
  await xero.initialize();
  xero.setTokenSet({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
  });

  return { xero, tenantId: tokens.tenantId };
}

async function waitForSharedXeroTokenRefresh(): Promise<XeroTokenRecord> {
  const deadline = Date.now() + XERO_TOKEN_REFRESH_LEASE_MS + TOKEN_REFRESH_WAIT_GRACE_MS;

  do {
    await sleep(TOKEN_REFRESH_POLL_MS);
    const latestTokens = await loadXeroTokens();
    if (!latestTokens) {
      throw new XeroReconnectRequiredError("Xero is not connected. Please connect via admin panel.");
    }

    if (!latestTokens.tenantId) {
      throw new XeroReconnectRequiredError("Xero tenant ID not found. Please reconnect Xero.");
    }

    if (!tokenNeedsRefresh(latestTokens)) {
      return latestTokens;
    }

    const activeLease = latestTokens.refreshInProgressUntil;
    if (!activeLease || activeLease.getTime() <= Date.now()) {
      return latestTokens;
    }
  } while (Date.now() < deadline);

  const latestTokens = await loadXeroTokens();
  if (!latestTokens) {
    throw new XeroReconnectRequiredError("Xero is not connected. Please connect via admin panel.");
  }

  return latestTokens;
}

/**
 * Get an authenticated XeroClient with valid tokens.
 * Automatically refreshes if token is about to expire.
 */
export async function getAuthenticatedXeroClient(): Promise<{
  xero: XeroClient;
  tenantId: string;
}> {
  throwIfXeroDailyLimitActive();

  const tokens = await loadXeroTokens();
  if (!tokens) {
    throw new XeroReconnectRequiredError("Xero is not connected. Please connect via admin panel.");
  }
  if (!tokens.tenantId) {
    throw new XeroReconnectRequiredError("Xero tenant ID not found. Please reconnect Xero.");
  }

  // Check if token needs refresh
  if (tokenNeedsRefresh(tokens)) {
    // Mutex: if a refresh is already in progress, wait for it instead of double-refreshing
    if (_tokenRefreshPromise) {
      return _tokenRefreshPromise;
    }

    const leaseClaim = await claimXeroTokenRefreshLease();
    if (!leaseClaim.claimed) {
      const refreshedOrAvailableTokens = await waitForSharedXeroTokenRefresh();
      if (tokenNeedsRefresh(refreshedOrAvailableTokens)) {
        return getAuthenticatedXeroClient();
      }

      return buildAuthenticatedXeroClient(refreshedOrAvailableTokens);
    }

    // Token expired or about to expire - refresh it (wrapped in mutex)
    const refreshWork = (async () => {
      const { tokens: claimedTokens, leaseUntil } = leaseClaim;
      // Everything after the lease claim must run under this try: if client
      // construction (initialize() -> identity.xero.com discovery) throws
      // before the finally is armed, the rejected promise stays cached in
      // _tokenRefreshPromise and the DB lease stays claimed, so every later
      // call in this process instantly replays the stale error until restart.
      try {
        const { xero } = await buildAuthenticatedXeroClient(claimedTokens);
        xero.setTokenSet({
          access_token: claimedTokens.accessToken,
          refresh_token: claimedTokens.refreshToken,
          token_type: "Bearer",
        });
        const config = await getOperationalXeroConfig();
        try {
          const newTokenSet = await xero.refreshWithRefreshToken(
            config.clientId,
            config.clientSecret,
            claimedTokens.refreshToken
          );

          await saveXeroTokens({
            accessToken: newTokenSet.access_token!,
            refreshToken: newTokenSet.refresh_token!,
            expiresAt: new Date(Date.now() + (newTokenSet.expires_in ?? 1800) * 1000),
            tenantId: claimedTokens.tenantId,
          }, {
            claimedTokenId: claimedTokens.id,
            refreshLeaseUntil: leaseUntil,
          });

          xero.setTokenSet({
            access_token: newTokenSet.access_token!,
            refresh_token: newTokenSet.refresh_token!,
            token_type: newTokenSet.token_type ?? "Bearer",
          });

          return { xero, tenantId: claimedTokens.tenantId! };
        } catch (err) {
          logger.error({ err }, "Xero token refresh failed");
          import("./xero-error-alert").then(({ notifyXeroSyncError }) =>
            notifyXeroSyncError({
              errorType: "Token Refresh Failure",
              operation: "getAuthenticatedXeroClient",
              errorMessage: err instanceof Error ? err.message : String(err),
            })
          ).catch(() => {});
          const message = "Xero token refresh failed. Please reconnect Xero via the admin panel.";
          if (refreshFailureRequiresReconnect(err)) {
            throw new XeroReconnectRequiredError(message);
          }
          throw new Error(message);
        }
      } finally {
        await releaseXeroTokenRefreshLease(claimedTokens.id, leaseUntil).catch((err) => {
          logger.warn({ err }, "Failed to release Xero token refresh lease");
        });
        _tokenRefreshPromise = null;
      }
    })();
    _tokenRefreshPromise = refreshWork;
    return refreshWork;
  }

  // Token still valid
  return buildAuthenticatedXeroClient(tokens);
}

// ---------------------------------------------------------------------------
// Rate-limit helpers
// ---------------------------------------------------------------------------

/** Throttle helper: wait ms milliseconds */
function throttle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRemainingXeroDailyLimitSeconds(): number {
  const remainingMs = xeroDailyLimitUntilMs - Date.now();
  if (remainingMs <= 0) {
    xeroDailyLimitUntilMs = 0;
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

function throwIfXeroDailyLimitActive(): void {
  const remainingSec = getRemainingXeroDailyLimitSeconds();
  if (remainingSec > 0) {
    // Pre-HTTP refusal: no request has been sent. Mark it so the outbox can
    // safely return the row to PENDING rather than condemning it (#2423 F2).
    throw new XeroDailyLimitError(remainingSec, true);
  }
}

function getRemainingXeroTransientOutageSeconds(): number {
  const remainingMs = xeroTransientOutageUntilMs - Date.now();
  if (remainingMs <= 0) {
    xeroTransientOutageUntilMs = 0;
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

function throwIfXeroTransientOutageActive(): void {
  const remainingSec = getRemainingXeroTransientOutageSeconds();
  if (remainingSec > 0) {
    // Pre-HTTP refusal: no request has been sent. Mark it so the outbox can
    // safely return the row to PENDING rather than condemning it (#2423 F2).
    throw new XeroTransientOutageError(remainingSec, true);
  }
}

function rememberXeroDailyLimit(retryAfterSec: number): void {
  const clampedRetryAfterSec = Math.max(0, retryAfterSec);
  const nextLimitUntilMs = Date.now() + clampedRetryAfterSec * 1000;

  if (nextLimitUntilMs > xeroDailyLimitUntilMs) {
    xeroDailyLimitUntilMs = nextLimitUntilMs;
    logger.warn(
      {
        retryAfterSec: clampedRetryAfterSec,
        availableAt: new Date(nextLimitUntilMs).toISOString(),
      },
      "Xero daily API limit reached, suppressing further Xero calls until cooldown expires"
    );
  }
}

function rememberXeroTransientOutage(retryAfterSec: number): void {
  const clampedRetryAfterSec = Math.max(0, retryAfterSec);
  const nextLimitUntilMs = Date.now() + clampedRetryAfterSec * 1000;

  if (nextLimitUntilMs > xeroTransientOutageUntilMs) {
    xeroTransientOutageUntilMs = nextLimitUntilMs;
    logger.warn(
      {
        retryAfterSec: clampedRetryAfterSec,
        availableAt: new Date(nextLimitUntilMs).toISOString(),
      },
      "Xero transient API failures exceeded retry budget, suppressing further Xero calls until cooldown expires"
    );
  }
}

// test seam
export function resetXeroRateLimitStateForTests(): void {
  xeroDailyLimitUntilMs = 0;
  xeroTransientOutageUntilMs = 0;
}

// ---------------------------------------------------------------------------
// Retry / metering primitives
// ---------------------------------------------------------------------------

interface XeroRetryRateLimitEvent {
  attempt: number;
  retryAfterSec: number;
  rateLimitCategory: XeroRateLimitCategory;
}

interface XeroRetryOptions {
  maxRetries?: number;
  maxTransientRetries?: number;
  /**
   * Whether exhausting the transient (5xx/408) budget may arm the PROCESS-GLOBAL
   * transient-outage breaker. Defaults to true, which is right for every call
   * that MATTERS: if invoicing keeps hitting 5xx, stopping the whole process for
   * two minutes protects the quota and the downstream state.
   *
   * Pass false for a call whose own failure is inconsequential but whose blast
   * radius would not be — a decorative read behind an operator-facing button, in
   * particular (#2394). Such a call should be able to fail as often as a human
   * presses it without taking invoicing, sync and webhook replay down with it.
   * Opting out never lets a call IGNORE the breaker: `withXeroRetry` still
   * refuses up front while a cooldown armed elsewhere is active.
   */
  armTransientBreaker?: boolean;
  maxWaitSec?: number;
  context?: string;
  onRateLimit?: (event: XeroRetryRateLimitEvent) => void;
}

export interface MeteredXeroCallOptions extends XeroRetryOptions {
  operation: string;
  resourceType: string;
  workflow?: string;
}

function getObservedXeroRateLimitCategory(err: unknown): XeroRateLimitCategory {
  if (err instanceof XeroDailyLimitError) {
    return "day";
  }

  if (getXeroErrorStatusCode(err) !== 429) {
    return null;
  }

  const rateLimitProblem = getXeroErrorHeader(err, "x-rate-limit-problem");
  if (rateLimitProblem === "day" || rateLimitProblem === "minute") {
    return rateLimitProblem;
  }

  return "unknown";
}

function parseXeroRetryAfterSeconds(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const numericValue = Number.parseInt(value, 10);
  if (Number.isFinite(numericValue) && numericValue >= 0) {
    return numericValue;
  }

  const retryAtMs = Date.parse(value);
  if (Number.isFinite(retryAtMs)) {
    return Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
  }

  return null;
}

function isRetryableXeroTransientStatus(statusCode: number | undefined): boolean {
  return (
    statusCode === 408 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode <= 599)
  );
}

function getXeroTransientRetryDelaySeconds(
  err: unknown,
  attempt: number,
  maxWaitSec: number
): number {
  const retryAfterSec = parseXeroRetryAfterSeconds(
    getXeroErrorHeader(err, "retry-after")
  );
  const backoffSec = Math.min(2 ** attempt, maxWaitSec);

  return Math.min(retryAfterSec ?? backoffSec, maxWaitSec);
}

function getXeroTransientCooldownSeconds(err: unknown): number {
  return (
    parseXeroRetryAfterSeconds(getXeroErrorHeader(err, "retry-after")) ??
    XERO_TRANSIENT_FAILURE_COOLDOWN_SEC
  );
}

function getXeroUsageErrorMessage(err: unknown): string | null {
  const statusCode = getXeroErrorStatusCode(err);
  const bodyMessage = getXeroErrorBodyMessage(err);
  if (bodyMessage) {
    const correlationId = getXeroErrorHeader(err, "xero-correlation-id");
    const prefix = statusCode ? `HTTP ${statusCode}: ` : "";
    const suffix = correlationId ? ` (Xero correlation ID: ${correlationId})` : "";
    return `${prefix}${bodyMessage}${suffix}`;
  }

  if (err instanceof Error) {
    return err.message;
  }

  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }

  return err ? String(err) : null;
}

async function persistMeteredXeroApiUsage(
  options: MeteredXeroCallOptions,
  success: boolean,
  durationMs: number,
  err?: unknown,
  observedRateLimitCategory?: XeroRateLimitCategory
): Promise<void> {
  await recordXeroApiUsage({
    operation: options.operation,
    resourceType: options.resourceType,
    workflow: options.workflow ?? options.context,
    success,
    rateLimitCategory: observedRateLimitCategory ?? getObservedXeroRateLimitCategory(err),
    statusCode: err ? getXeroErrorStatusCode(err) ?? null : null,
    durationMs,
    errorMessage: getXeroUsageErrorMessage(err),
  });
}

/**
 * Wrap a Xero API call so each attempt is observed (usage row, rate-limit
 * category) and retries are governed by withXeroRetry. Use for any
 * outbound Xero call we want metered.
 *
 * ## Every attempt re-invokes `fn`, so build the request OUTSIDE it
 *
 * `withXeroRetry` calls `fn` again per attempt. Anything the callback computes
 * from ambient state — above all a date read off the clock — is therefore
 * recomputed per attempt, and a retry that crosses club midnight would send a
 * different document date than the first attempt did under the SAME
 * `Idempotency-Key`. Compose the request body before the `callXeroApi` call and
 * close over it (#2834; `xero-supplementary-invoices.ts` is the worked example).
 *
 * ## The one assumption this leaves standing
 *
 * Idempotency keys in this codebase carry no date (censused on #2834), so
 * changing how a date is derived never changes a key. That is what makes an
 * operation queued before a deploy still dedupe after it — but it also means the
 * retry can arrive with the SAME key and a DIFFERENT `date` in the body, which
 * is exactly what happens to an operation that sent its first request under the
 * pre-#2834 UTC-day derivation and is re-driven afterwards.
 *
 * This ships on the assumption that a repeated `Idempotency-Key` never re-dates
 * a document Xero has already created: Xero either replays the original
 * response (the original date stands — the outcome we want) or rejects the
 * mismatch (the operation fails loudly and is re-driven, which is also safe).
 * That assumption is recorded rather than verified against the live API — no
 * exploratory work runs against a live provider — so treat it as a known
 * assumption, not a proven property, if a same-key/changed-body case ever turns
 * up in the outbox.
 */
export async function callXeroApi<T>(
  fn: () => Promise<T>,
  options: MeteredXeroCallOptions
): Promise<T> {
  /*
    INV-CONFIG-005 (#3036): an installation that has not declared whether it is
    the club's live site or a copy writes NOTHING to Xero. This is the backstop
    under the entry-point refusals rather than a replacement for them — those
    refuse before an operation is reserved or a lock is taken, so nothing is left
    half-written; this one catches the writer nobody has routed through a gate.

    BEFORE `withXeroRetry` AND BEFORE THE USAGE ROW, because nothing was
    attempted: a refused call is not an API call and must not appear in the
    quota ledger. Reads are unaffected, deliberately — see
    `xero-environment-write-gate.ts`.
  */
  await assertXeroProviderWriteAllowed(options.operation);
  const startedAt = Date.now();
  let observedRateLimitCategory: XeroRateLimitCategory = null;

  try {
    const result = await withXeroRetry(fn, {
      ...options,
      onRateLimit: (event) => {
        observedRateLimitCategory = event.rateLimitCategory;
        options.onRateLimit?.(event);
      },
    });
    await persistMeteredXeroApiUsage(
      options,
      true,
      Date.now() - startedAt,
      undefined,
      observedRateLimitCategory
    );
    return result;
  } catch (err) {
    await persistMeteredXeroApiUsage(
      options,
      false,
      Date.now() - startedAt,
      err,
      observedRateLimitCategory
    );
    throw err;
  }
}

// test seam
/**
 * Retry wrapper for Xero API calls with rate-limit and transient failure handling.
 * - On daily limit: throws XeroDailyLimitError immediately (no point waiting hours).
 * - On minute/app limit: waits Retry-After seconds (capped at maxWaitSec) and retries.
 * - On transient Xero/server failures: retries with a short capped exponential backoff.
 */
export async function withXeroRetry<T>(
  fn: () => Promise<T>,
  options?: XeroRetryOptions
): Promise<T> {
  throwIfXeroDailyLimitActive();
  throwIfXeroTransientOutageActive();

  const maxRateLimitRetries = options?.maxRetries ?? 3;
  const maxTransientRetries =
    options?.maxTransientRetries ??
    Math.min(maxRateLimitRetries, DEFAULT_XERO_TRANSIENT_MAX_RETRIES);
  const maxWaitSec = options?.maxWaitSec ?? 120;
  const armTransientBreaker = options?.armTransientBreaker ?? true;
  const context = options?.context ?? "Xero API call";
  const maxAttempts = Math.max(maxRateLimitRetries, maxTransientRetries);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const statusCode = getXeroErrorStatusCode(err);

      if (statusCode === 429) {
        const retryAfter = getXeroErrorHeader(err, "retry-after");
        const rateLimitProblem = getXeroErrorHeader(err, "x-rate-limit-problem");
        const parsedRetryAfterSec =
          parseXeroRetryAfterSeconds(retryAfter) ??
          (rateLimitProblem === "day" ? 86400 : 30);
        const rateLimitCategory =
          rateLimitProblem === "day" || rateLimitProblem === "minute"
            ? rateLimitProblem
            : "unknown";

        options?.onRateLimit?.({
          attempt: attempt + 1,
          retryAfterSec: parsedRetryAfterSec,
          rateLimitCategory,
        });

        // Daily limit — abort immediately, no point retrying for hours.
        // This is a POST-HTTP conversion of a 429 Xero itself returned: the
        // call WAS attempted, so `preHttp` stays false (the default) and the
        // outbox keeps it on the replayable FAILED path rather than treating it
        // as never-sent (#2423 review F2).
        if (rateLimitProblem === "day") {
          const retryAfterSec = parsedRetryAfterSec;
          rememberXeroDailyLimit(retryAfterSec);
          throw new XeroDailyLimitError(retryAfterSec, false);
        }

        // Minute/app limit — retry if we have attempts left
        if (attempt < maxRateLimitRetries) {
          const waitSec = Math.min(parsedRetryAfterSec, maxWaitSec);
          logger.warn(
            { context, attempt: attempt + 1, maxRetries: maxRateLimitRetries, waitSec, rateLimitProblem },
            "Xero 429 rate limit hit, retrying after backoff"
          );
          await throttle(waitSec * 1000);
          continue;
        }

        throw err;
      }

      if (isRetryableXeroTransientStatus(statusCode)) {
        if (attempt < maxTransientRetries) {
          const waitSec = getXeroTransientRetryDelaySeconds(err, attempt, maxWaitSec);
          logger.warn(
            { context, attempt: attempt + 1, maxRetries: maxTransientRetries, waitSec, statusCode },
            "Xero transient API failure, retrying after backoff"
          );
          await throttle(waitSec * 1000);
          continue;
        }

        if (armTransientBreaker) {
          rememberXeroTransientOutage(getXeroTransientCooldownSeconds(err));
        }
        throw err;
      }

      throw err;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Error-text helpers (shared with contact repair logic in xero.ts)
// ---------------------------------------------------------------------------

export function getXeroErrorSearchText(error: unknown): string {
  const values = new Set<string>();

  const addValue = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      values.add(value.toLowerCase());
    }
  };

  if (error instanceof Error) {
    addValue(error.message);
  }

  if (typeof error === "string") {
    addValue(error);
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      body?: { Detail?: unknown; Message?: unknown; Title?: unknown };
      message?: unknown;
    };

    addValue(candidate.message);
    addValue(candidate.body?.Detail);
    addValue(candidate.body?.Message);
    addValue(candidate.body?.Title);

    try {
      addValue(JSON.stringify(error));
    } catch {
      // Ignore non-serializable values.
    }
  }

  return Array.from(values).join("\n");
}

export function isRetryableXeroContactReferenceError(error: unknown): boolean {
  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode !== undefined && statusCode !== 400 && statusCode !== 404) {
    return false;
  }

  const text = getXeroErrorSearchText(error);
  if (!text.includes("contact")) {
    return false;
  }

  return [
    "not found",
    "does not exist",
    "invalid reference",
    "invalid_reference",
    "invalid contact",
    "not a valid contact",
    "could not be found",
  ].some((fragment) => text.includes(fragment));
}
