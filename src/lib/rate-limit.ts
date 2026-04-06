/**
 * In-memory rate limiter for Next.js API routes.
 * Uses a sliding window approach with automatic cleanup.
 * Acceptable for single-instance deployments (this app runs on one Lightsail instance).
 */

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
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * Check rate limit for a given key (typically IP address).
 * Returns whether the request should be allowed.
 */
export function checkRateLimit(
  config: RateLimitConfig,
  key: string
): RateLimitResult {
  ensureCleanup();

  const storeKey = `${config.id}:${key}`;
  const now = Date.now();
  const entry = store.get(storeKey);

  // No existing entry or window expired - create new
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + config.windowSeconds * 1000;
    store.set(storeKey, { count: 1, resetAt });
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit - 1,
      resetAt,
    };
  }

  // Within window - increment
  entry.count++;

  if (entry.count > config.limit) {
    return {
      success: false,
      limit: config.limit,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  return {
    success: true,
    limit: config.limit,
    remaining: config.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * Get the client IP from a request, considering common proxy headers.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

/**
 * Apply rate limiting to a request. Returns a Response if rate limited, null if allowed.
 */
export function applyRateLimit(
  config: RateLimitConfig,
  request: Request
): Response | null {
  const ip = getClientIp(request);
  const result = checkRateLimit(config, ip);

  if (!result.success) {
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

  return null;
}

// Pre-configured rate limiters for common routes
export const rateLimiters = {
  /** Login: 10 attempts per 15 minutes */
  login: { id: "login", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Register: 5 attempts per hour */
  register: { id: "register", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Password reset request: 5 per hour */
  forgotPassword: { id: "forgot-password", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Password reset submission: 10 per hour */
  resetPassword: { id: "reset-password", limit: 10, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** General API: 100 per minute */
  api: { id: "api", limit: 100, windowSeconds: 60 } as RateLimitConfig,
  /** Booking creation: 20 per hour */
  bookingCreate: { id: "booking-create", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Booking quote / availability / promo validate: 60 per minute */
  bookingQuery: { id: "booking-query", limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Contact form: 5 per hour */
  contact: { id: "contact", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Resend verification email: 3 per hour */
  resendVerification: { id: "resend-verification", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Request email change: 3 per hour */
  requestEmailChange: { id: "request-email-change", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
} as const;

// Export for testing
export { store as _testStore };
