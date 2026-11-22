import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { cookies, headers } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { getSessionForAuthDiagnostics } from "./auth";
import { createAuditLog, type AuditSeverity } from "./audit";
import { prisma } from "./prisma";
import { clientIpFromHeaders } from "./rate-limit-http";
import logger from "./logger";

/**
 * Auth-bounce diagnostics (#1669).
 *
 * When a protected layout's guard #1 is about to redirect to /login because
 * the wrapped auth() returned null, recordAuthBounce() classifies WHY and
 * records it durably, keyed by a short random reference code that is also
 * appended to the login URL so a member can quote it when reporting the
 * silent "login loop".
 *
 * Noise gate (owner-approved design):
 * - `no-cookie` (plain anonymous visit): debug-level pino line only. No
 *   AuditLog row, no Sentry event, no reference code — bots and logged-out
 *   bookmarks must not flood any durable sink.
 * - `session-invalidated` (revocation gate nulled a decodable session after
 *   a password change): pino info + AuditLog row. No Sentry — this is the
 *   feature working as designed.
 * - `cookie-present-no-session` (the real anomaly — a session cookie was
 *   sent but no server session emerged): pino warn + AuditLog row + ONE
 *   deduped, narrowly-scoped Sentry event.
 *
 * Sentry scoping: this module deliberately does NOT extend
 * `observability-bridge.ts` — that bridge's contract is cron/webhook
 * genuine-failure paths only (#1214), and widening it would erode the
 * alert-fatigue guarantee it exists to provide. The helper below is a
 * separate, provably-scoped path: it fires for exactly one fingerprint
 * ("auth-bounce" / "cookie-present-no-session") behind its own in-process
 * cooldown.
 *
 * Robustness: every path is wrapped so a logging/DB/Sentry failure can never
 * convert the clean 307 login redirect into a 500. recordAuthBounce()
 * resolves null instead of throwing, always.
 *
 * Privacy: token values and raw cookie contents are never read into any
 * sink — only cookie NAME matches, chunk counts, and byte LENGTHS are
 * recorded. The durable record carries memberId (never raw email) and the
 * random reference code carries no personal data into the URL.
 */

export type AuthBounceReason =
  | "no-cookie"
  | "cookie-present-no-session"
  | "session-invalidated";

export type AuthBounceLayout = "authenticated" | "admin";

// next-auth v5 session cookie (plain and __Secure- prefixed) plus its
// chunked `.0`/`.1`... variants. Deliberately excludes legacy
// `next-auth.session-token` cookies: a years-stale v4 cookie on an otherwise
// anonymous request must not classify as an anomaly.
const SESSION_COOKIE_NAME_PATTERN =
  /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

const AUTH_BOUNCE_ACTION = "auth.bounce";
const AUTH_BOUNCE_SENTRY_SCOPE = "auth-bounce";
const AUTH_BOUNCE_ANOMALY_REASON =
  "cookie-present-no-session" satisfies AuthBounceReason;
// Same knob and default as observability-bridge.ts so operators tune one
// cooldown; the dedup map itself is separate and scoped to this module.
const DEFAULT_SENTRY_COOLDOWN_MS = 5 * 60 * 1000;

function resolveSentryCooldownMs(): number {
  const raw = process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS;
  if (!raw) {
    return DEFAULT_SENTRY_COOLDOWN_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SENTRY_COOLDOWN_MS;
}

// In-process cooldown: last epoch-ms an auth-bounce fingerprint was
// forwarded to Sentry. Single-process only, like the bridge's map.
const lastSentryByFingerprint = new Map<string, number>();

/** Reset the in-process Sentry cooldown map. Test-only. */
export function resetAuthBounceSentryDedupForTests(): void {
  lastSentryByFingerprint.clear();
}

// Durable-write throttle: page routes carry no rate limiting, so any junk
// cookie named like a session token would otherwise buy an unauthenticated
// AuditLog INSERT (16 indexes) per request. Cap rows per process-minute;
// the pino warn stays unthrottled so raw bounce volume remains observable
// in logs, and every suppressed row is tallied onto the next written one.
const AUDIT_THROTTLE_WINDOW_MS = 60 * 1000;
const DEFAULT_AUDIT_WRITES_PER_MINUTE = 10;

function resolveAuditWritesPerMinute(): number {
  const raw = process.env.AUTH_BOUNCE_AUDIT_MAX_WRITES_PER_MINUTE;
  if (!raw) {
    return DEFAULT_AUDIT_WRITES_PER_MINUTE;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AUDIT_WRITES_PER_MINUTE;
}

let auditWindowStartMs = 0;
let auditWindowCount = 0;
let auditSuppressedCount = 0;

/** Reset the in-process durable-write throttle. Test-only. */
export function resetAuthBounceAuditThrottleForTests(): void {
  auditWindowStartMs = 0;
  auditWindowCount = 0;
  auditSuppressedCount = 0;
}

function takeAuditWriteBudget(nowMs: number): {
  allowed: boolean;
  suppressedSinceLastWrite: number;
} {
  if (nowMs - auditWindowStartMs >= AUDIT_THROTTLE_WINDOW_MS) {
    auditWindowStartMs = nowMs;
    auditWindowCount = 0;
  }
  if (auditWindowCount >= resolveAuditWritesPerMinute()) {
    auditSuppressedCount += 1;
    return { allowed: false, suppressedSinceLastWrite: 0 };
  }
  auditWindowCount += 1;
  const suppressedSinceLastWrite = auditSuppressedCount;
  auditSuppressedCount = 0;
  return { allowed: true, suppressedSinceLastWrite };
}

export function generateAuthBounceRef(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

interface AuthBounceRecord {
  reason: Exclude<AuthBounceReason, "no-cookie">;
  ref: string;
  layout: AuthBounceLayout;
  path: string | null;
  memberId: string | null;
  sessionIssuedAt: number | null;
  sessionCookieChunkCount: number;
  sessionCookieBytes: number;
  cookieHeaderApproxBytes: number;
  /** Raw probe saw a live, NON-invalidated session while auth() saw null. */
  probeMismatch: boolean;
  /** Trimmed name+message when the raw probe itself threw. */
  probeError: string | null;
  /** Durable rows dropped by the write throttle since the previous row. */
  suppressedSinceLastWrite: number;
  ipAddress: string | null;
  userAgent: string | null;
}

// Defence in depth: authjs/jose decode errors do not embed token material in
// practice, but this string flows into pino/Sentry/AuditLog, so scrub
// anything JWT-shaped before it can. 2–4 dot-segments after the header
// covers both 3-segment JWS and the 5-segment JWE session cookies.
const JWT_LIKE_PATTERN =
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){2,4}/g;

function describeProbeError(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  return text.replace(JWT_LIKE_PATTERN, "[REDACTED]").slice(0, 200);
}

function bounceSeverity(record: AuthBounceRecord): AuditSeverity {
  return record.reason === "session-invalidated" ? "info" : "important";
}

async function persistAuthBounceAuditRow(
  record: AuthBounceRecord
): Promise<void> {
  try {
    // Enrichment only: the delta between session issuance and the revoking
    // password change is the payload that confirms (or falsifies) the
    // "revocation surfacing as a silent loop" hypothesis.
    let passwordChangedAt: Date | null = null;
    if (record.reason === "session-invalidated" && record.memberId) {
      try {
        const member = await prisma.member.findUnique({
          where: { id: record.memberId },
          select: { passwordChangedAt: true },
        });
        passwordChangedAt = member?.passwordChangedAt ?? null;
      } catch (error) {
        logger.warn(
          { err: error, ref: record.ref },
          "Auth bounce: passwordChangedAt enrichment failed"
        );
      }
    }

    const deltaMs =
      passwordChangedAt && record.sessionIssuedAt !== null
        ? passwordChangedAt.getTime() - record.sessionIssuedAt
        : null;

    await createAuditLog({
      action: AUTH_BOUNCE_ACTION,
      // `security`, not the invented `auth` this used to write (#2581). `auth`
      // was never in the taxonomy, so these rows were selectable by no Admin
      // category filter and by no Diagnostics correlation tool. The affected
      // domain is authentication, which is `security`.
      //
      // THREE CONSEQUENCES, all deliberate. These rows become readable through
      // the system correlation entry, which needs `support:view` alone — a
      // widening from "readable by nobody". And `security` is a high-volume
      // family here, so it now competes for that entry's 22-row ceiling; the
      // explicit `diagnostic_high_volume` retention below is unchanged, so the
      // 90-day expiry still bounds how long that lasts.
      //
      // The third is member-facing and is the one worth stating, because a
      // category change is an easy place to move a row across that boundary
      // without meaning to. `security` is in MEMBER_VISIBLE_AUDIT_CATEGORIES and
      // the invented `auth` was in nothing, so a member now sees their OWN login
      // bounces in their profile timeline (this row sets `memberId`, no
      // `subjectMemberId`, which the member self-timeline matches). That is the
      // member's own sign-in data and the member projection returns no metadata,
      // no request id and no IP — and members already see their own high-volume
      // `diagnostic_high_volume` rows under `privacy` (`member_guest.search`), so
      // it is consistent rather than novel. It is pinned by
      // `audit-writer-census.test.ts` so it cannot change again unnoticed.
      category: "security",
      outcome: record.reason,
      severity: bounceSeverity(record),
      memberId: record.memberId,
      requestId: record.ref,
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      retentionClass: "diagnostic_high_volume",
      summary:
        record.reason === "session-invalidated"
          ? "Login bounce: session revoked by a later password change"
          : "Login bounce: session cookie present but server auth() returned null",
      // Key names deliberately avoid the substrings "cookie" and "password":
      // sanitizeAuditMetadata redacts ANY key containing them (correctly —
      // values under such keys are usually secrets). These are counts, byte
      // lengths, and timestamps: hasSessionCredential/sessionChunk* describe
      // the session cookie, credentialChangedAt is Member.passwordChangedAt.
      metadata: {
        layout: record.layout,
        path: record.path,
        hasSessionCredential: true,
        sessionChunkCount: record.sessionCookieChunkCount,
        sessionChunkBytes: record.sessionCookieBytes,
        credentialHeaderApproxBytes: record.cookieHeaderApproxBytes,
        sessionIssuedAt:
          record.sessionIssuedAt !== null
            ? new Date(record.sessionIssuedAt)
            : null,
        credentialChangedAt: passwordChangedAt,
        deltaMs,
        probeMismatch: record.probeMismatch,
        probeError: record.probeError,
        ...(record.suppressedSinceLastWrite > 0
          ? { suppressedSinceLastWrite: record.suppressedSinceLastWrite }
          : {}),
      },
    });
  } catch (error) {
    try {
      logger.error(
        { err: error, ref: record.ref },
        "Failed to persist auth-bounce audit row"
      );
    } catch {
      // Deliberately swallowed: diagnostics must never propagate.
    }
  }
}

function scheduleAuthBounceAuditWrite(record: AuthBounceRecord): void {
  const budget = takeAuditWriteBudget(Date.now());
  if (!budget.allowed) {
    // Row dropped by the throttle; the bounce's pino line (unthrottled, with
    // ref and reason) remains the record of this occurrence, and the drop is
    // tallied onto the next written row's suppressedSinceLastWrite.
    return;
  }
  record.suppressedSinceLastWrite = budget.suppressedSinceLastWrite;
  try {
    // Post-response so the durable write never delays the login redirect.
    // persistAuthBounceAuditRow never rejects (fully guarded above).
    after(() => persistAuthBounceAuditRow(record));
  } catch {
    // after() is unavailable outside a request scope (and in some unit
    // contexts) — fall back to a guarded fire-and-forget write.
    void persistAuthBounceAuditRow(record);
  }
}

function reportAuthBounceAnomalyToSentry(record: AuthBounceRecord): void {
  try {
    const fingerprintKey = `${AUTH_BOUNCE_SENTRY_SCOPE}:${record.reason}`;
    const now = Date.now();
    const lastSent = lastSentryByFingerprint.get(fingerprintKey);
    if (lastSent !== undefined && now - lastSent < resolveSentryCooldownMs()) {
      return;
    }
    lastSentryByFingerprint.set(fingerprintKey, now);

    Sentry.captureMessage(
      "Auth bounce anomaly: session cookie present but server auth() returned null",
      {
        level: "warning",
        fingerprint: [AUTH_BOUNCE_SENTRY_SCOPE, record.reason],
        tags: { scope: AUTH_BOUNCE_SENTRY_SCOPE, operation: record.reason },
        // Same sink-safe key names as the AuditLog metadata so operator
        // queries line up across Sentry and the audit trail.
        extra: {
          ref: record.ref,
          layout: record.layout,
          path: record.path,
          sessionChunkCount: record.sessionCookieChunkCount,
          sessionChunkBytes: record.sessionCookieBytes,
          credentialHeaderApproxBytes: record.cookieHeaderApproxBytes,
          probeMismatch: record.probeMismatch,
          probeError: record.probeError,
        },
      }
    );
  } catch {
    // Sentry failures must never reach the redirect path.
  }
}

/**
 * Classify and record why auth() returned null on a guard-#1 bounce.
 *
 * Returns the reference code to thread into the login URL for the durable
 * cases, or null for plain anonymous no-cookie visits (and on any internal
 * failure). Never throws and never rejects.
 */
export async function recordAuthBounce(input: {
  layout: AuthBounceLayout;
  requestedPath: string | null;
}): Promise<string | null> {
  try {
    const [cookieStore, requestHeaders] = await Promise.all([
      cookies(),
      headers(),
    ]);
    const allCookies = cookieStore.getAll();
    // A zero-length value (botched logout, proxy quirk) can never decode, so
    // it counts as no-cookie rather than paging as an anomaly on every hit.
    const sessionCookies = allCookies.filter(
      (cookie) =>
        SESSION_COOKIE_NAME_PATTERN.test(cookie.name) &&
        cookie.value.length > 0
    );
    const path = input.requestedPath;

    if (sessionCookies.length === 0) {
      // Normal anonymous visit. Quietest possible signal, no durable write.
      logger.debug(
        { event: AUTH_BOUNCE_ACTION, reason: "no-cookie", layout: input.layout, path },
        "Auth bounce: anonymous request without a session cookie"
      );
      return null;
    }

    const ref = generateAuthBounceRef();

    // Byte LENGTHS only — cookie values must never reach a sink.
    const sessionCookieBytes = sessionCookies.reduce(
      (sum, cookie) => sum + cookie.value.length,
      0
    );
    const cookieHeaderApproxBytes = allCookies.reduce(
      // name=value plus "; " separator per RFC 6265 serialization.
      (sum, cookie) => sum + cookie.name.length + cookie.value.length + 3,
      0
    );

    // Probe the raw next-auth session to split "revoked by password change"
    // from "no decodable session". Must run before the redirect: request
    // cookie/header APIs are unavailable inside after().
    let reason: Exclude<AuthBounceReason, "no-cookie"> =
      AUTH_BOUNCE_ANOMALY_REASON;
    let memberId: string | null = null;
    let sessionIssuedAt: number | null = null;
    let probeMismatch = false;
    let probeError: string | null = null;
    try {
      const rawSession = await getSessionForAuthDiagnostics();
      if (rawSession?.user?.sessionInvalidated) {
        reason = "session-invalidated";
        memberId = rawSession.user.id ?? null;
        sessionIssuedAt = rawSession.user.sessionIssuedAt ?? null;
      } else if (rawSession?.user) {
        // The wrapped auth() saw null moments ago but the probe now sees a
        // live, non-invalidated session: per-request nondeterminism, the
        // most diagnostic anomaly of all. Stays classified as the anomaly.
        memberId = rawSession.user.id ?? null;
        sessionIssuedAt = rawSession.user.sessionIssuedAt ?? null;
        probeMismatch = true;
      }
    } catch (error) {
      probeError = describeProbeError(error);
    }

    const record: AuthBounceRecord = {
      reason,
      ref,
      layout: input.layout,
      path,
      memberId,
      sessionIssuedAt,
      sessionCookieChunkCount: sessionCookies.length,
      sessionCookieBytes,
      cookieHeaderApproxBytes,
      probeMismatch,
      probeError,
      suppressedSinceLastWrite: 0,
      ipAddress: clientIpFromHeaders(requestHeaders),
      userAgent: requestHeaders.get("user-agent"),
    };

    const logPayload = {
      event: AUTH_BOUNCE_ACTION,
      reason,
      ref,
      layout: record.layout,
      path,
      memberId,
      sessionIssuedAt,
      sessionChunkCount: record.sessionCookieChunkCount,
      sessionChunkBytes: sessionCookieBytes,
      probeMismatch,
      probeError,
    };
    try {
      if (reason === "session-invalidated") {
        logger.info(
          logPayload,
          "Auth bounce: session revoked by a later password change"
        );
      } else {
        logger.warn(
          logPayload,
          "Auth bounce: session cookie present but server auth() returned null"
        );
      }
    } catch {
      // A throwing logger must not cost us the Sentry event or the durable
      // write below.
    }

    if (reason === AUTH_BOUNCE_ANOMALY_REASON) {
      reportAuthBounceAnomalyToSentry(record);
    }

    scheduleAuthBounceAuditWrite(record);

    return ref;
  } catch (error) {
    // The diagnostic must never break the redirect it decorates.
    try {
      logger.error({ err: error }, "Auth bounce diagnostics failed");
    } catch {
      // Even the failure log is best-effort.
    }
    return null;
  }
}
