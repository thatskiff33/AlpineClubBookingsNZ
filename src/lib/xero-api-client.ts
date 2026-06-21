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
  constructor(retryAfterSec: number) {
    super(
      `Xero daily API limit reached. Retry after ${retryAfterSec} seconds (~${Math.round(retryAfterSec / 3600)} hours). Please try again tomorrow.`
    );
    this.name = "XeroDailyLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class XeroTransientOutageError extends Error {
  retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super(
      `Xero is temporarily unavailable. Suppressing further Xero calls for ${retryAfterSec} seconds to protect API quota.`
    );
    this.name = "XeroTransientOutageError";
    this.retryAfterSec = retryAfterSec;
  }
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
    throw new Error("Xero tenant ID not found. Please reconnect Xero.");
  }

  const xero = createXeroClient();
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
      throw new Error("Xero is not connected. Please connect via admin panel.");
    }

    if (!latestTokens.tenantId) {
      throw new Error("Xero tenant ID not found. Please reconnect Xero.");
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
    throw new Error("Xero is not connected. Please connect via admin panel.");
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
    throw new Error("Xero is not connected. Please connect via admin panel.");
  }
  if (!tokens.tenantId) {
    throw new Error("Xero tenant ID not found. Please reconnect Xero.");
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
      const { xero } = await buildAuthenticatedXeroClient(claimedTokens);
      xero.setTokenSet({
        access_token: claimedTokens.accessToken,
        refresh_token: claimedTokens.refreshToken,
        token_type: "Bearer",
      });
      const config = getOperationalXeroConfig();
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
        throw new Error("Xero token refresh failed. Please reconnect Xero via the admin panel.");
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
    throw new XeroDailyLimitError(remainingSec);
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
    throw new XeroTransientOutageError(remainingSec);
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
 */
export async function callXeroApi<T>(
  fn: () => Promise<T>,
  options: MeteredXeroCallOptions
): Promise<T> {
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

        // Daily limit — abort immediately, no point retrying for hours
        if (rateLimitProblem === "day") {
          const retryAfterSec = parsedRetryAfterSec;
          rememberXeroDailyLimit(retryAfterSec);
          throw new XeroDailyLimitError(retryAfterSec);
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

        rememberXeroTransientOutage(getXeroTransientCooldownSeconds(err));
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
