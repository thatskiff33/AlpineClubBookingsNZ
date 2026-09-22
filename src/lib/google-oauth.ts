import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { AppRole } from "./member-roles";
import { prisma } from "./prisma";
import { getAuthSecret } from "./runtime-config";
import logger from "./logger";
import { getGoogleOAuthConfig } from "./google-config";
import { isDeletedAccountRecord } from "./deleted-account";
import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "./audit";

/**
 * Google OAuth sign-in via profile-initiated linking (#2035).
 *
 * The SAME Google provider serves both login and account-linking. The two are
 * distinguished by a short-lived, HMAC-signed, HttpOnly "link intent" cookie set
 * only by the authenticated `POST /api/profile/google/link/start` route:
 *
 *   - Link round-trip  → intent cookie present → the signIn callback pins
 *     `Member.googleSub` and returns a redirect STRING, so @auth/core returns
 *     early WITHOUT minting a new session (no identity switch — the member's
 *     existing session cookie is untouched).
 *   - Login round-trip → no intent cookie → the provider `profile()` resolves the
 *     member by `googleSub === profile.sub` ONLY (never email-match, never
 *     provision) and the signIn callback allows or refuses with a friendly error.
 *
 * CSRF-safety of the link flow rests on three independent guarantees:
 *   1. The intent cookie is HttpOnly + HMAC-signed with the auth secret, so it
 *      cannot be read or forged by client script, and it binds the member id of
 *      the authenticated session that created it. It is set ONLY by an
 *      authenticated same-origin POST.
 *   2. The OAuth leg carries @auth/core's own state + PKCE cookies, so the
 *      callback must correspond to an authorization request THIS browser started
 *      — an attacker cannot inject a pre-generated Google authorization.
 *   3. The link write itself refuses any collision (sub already linked to another
 *      member; member already linked to a different sub), so even a replayed
 *      cookie can only ever (idempotently) re-link the same member to the same
 *      Google account.
 *
 * The cookie is deliberately short-lived and best-effort cleared after use; the
 * security guarantee does not depend on single-use (guarantees 1–3 above do).
 */

export const GOOGLE_LINK_INTENT_COOKIE = "acb.google_link_intent";

// Short window: long enough to complete a Google consent round-trip, short
// enough that a stale cookie cannot linger. The security boundary does not
// depend on this (see module doc) — it only bounds the "a fresh Google login
// is treated as a link" UX window if best-effort clearing fails.
export const GOOGLE_LINK_INTENT_TTL_SECONDS = 5 * 60;

// Setup-wizard "Verify" round-trip (#2087). A Full Admin proves the stored
// Google credentials work by clicking through Google consent as themselves: the
// verify-intent cookie (set only by the authenticated Full-Admin verify-start
// route) marks the ensuing OAuth callback as a verification rather than a login
// or link. It is namespaced (`k: "verify"`) so a link cookie can never be
// replayed as a verify or vice versa, HMAC-signed like the link cookie, and
// bounded by the same short TTL. Reaching the signIn callback with this cookie
// present is itself the proof of success — @auth/core only runs signIn AFTER it
// has exchanged the authorization code with Google using the client id + secret.
export const GOOGLE_VERIFY_INTENT_COOKIE = "acb.google_verify_intent";
export const GOOGLE_VERIFY_INTENT_TTL_SECONDS = 5 * 60;

/**
 * The user shape returned to next-auth on a successful Google LOGIN. Byte-for-byte
 * identical to the password + magic-link Credentials providers so the UNCHANGED
 * jwt/session callbacks stamp role, the admin-permission matrix, and every 2FA
 * claim identically — a 2FA-enabled member still lands on /login/verify, and this
 * path NEVER pre-sets twoFactorVerified.
 */
export interface GoogleMemberUser {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  forcePasswordChange: boolean;
  isEmailVerified: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: "TOTP" | "EMAIL" | null;
}

export type GoogleLoginStatus = "ok"
  | "unlinked"
  | "refused"
  | "password_change"
  | "failed";

/**
 * What the provider `profile()` returns. On the eligible LOGIN path it is a full
 * member user shape carrying `googleLoginStatus: "ok"` (the extra field is
 * ignored by the jwt callback, which only copies named fields). On any refusal it
 * is a SENTINEL whose `id` is deliberately NOT a member id, so even if the flow
 * somehow reached the jwt callback it could never resolve a member — but the
 * signIn callback always intercepts a non-"ok" status first and refuses.
 */
export type GoogleProfileResult =
  | (GoogleMemberUser & { googleLoginStatus: "ok" })
  | {
      id: string;
      email: string | null;
      googleLoginStatus: Exclude<GoogleLoginStatus, "ok">;
    };

/**
 * True when both per-club Google OAuth credentials are configured — resolved
 * from the encrypted C1 store (DB-only, #2087), NOT the environment. The legacy
 * `GOOGLE_CLIENT_*` env vars are ignored (detected + warned about elsewhere).
 * Async because the resolution is a cache-backed DB fetch; FAIL-OPEN (returns
 * false, never throws) via `getGoogleOAuthConfig`.
 */
export async function googleCredentialsConfigured(): Promise<boolean> {
  return Boolean(await getGoogleOAuthConfig());
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requireSecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    // Auth cannot function without this; fail closed rather than sign with a
    // predictable key.
    throw new Error("AUTH_SECRET is required for Google account linking");
  }
  return secret;
}

function sign(payload: string): string {
  return base64url(createHmac("sha256", requireSecret()).update(payload).digest(),);
}

/**
 * Build the signed value for the link-intent cookie, binding the authenticated
 * member id and an absolute expiry. Format: `base64url(json).base64url(hmac)`.
 */
export function buildGoogleLinkIntentValue(memberId: string): string {
  const payload = base64url(
    JSON.stringify({
      m: memberId,
      e: Date.now() + GOOGLE_LINK_INTENT_TTL_SECONDS * 1000,
    }),
  );
  return `${payload}.${sign(payload)}`;
}

export interface GoogleLinkIntent {
  memberId: string;
}

function verifyIntentValue(value: string | undefined): GoogleLinkIntent | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as { m?: unknown; e?: unknown; k?: unknown };
    // Symmetric namespace guard (mirrors the `k: "verify"` check on the verify
    // side): a genuine LINK cookie never carries a `k`, so any payload that DOES
    // carry one — e.g. a validly-signed verify cookie — must be refused here.
    // This keeps the two intents disjoint in BOTH directions even though they
    // share the same HMAC key.
    if (
      decoded.k !== undefined ||
      typeof decoded.m !== "string" ||
      typeof decoded.e !== "number"
    ) {
      return null;
    }
    if (decoded.e <= Date.now()) {
      return null;
    }
    return { memberId: decoded.m };
  } catch {
    return null;
  }
}

/**
 * Read + verify the link-intent cookie from the current request, then best-effort
 * clear it. Returns the bound member id when a valid, unexpired intent is present,
 * else null (a plain login round-trip). Clearing is best-effort: @auth/core builds
 * its own Response, so a next/headers cookie mutation may not always be merged —
 * the short TTL bounds any stale cookie (see module doc).
 */
export async function readGoogleLinkIntent(): Promise<GoogleLinkIntent | null> {
  const store = await cookies();
  const intent = verifyIntentValue(store.get(GOOGLE_LINK_INTENT_COOKIE)?.value);
  if (intent) {
    try {
      store.delete(GOOGLE_LINK_INTENT_COOKIE);
    } catch {
      // Best-effort; TTL bounds a surviving cookie.
    }
  }
  return intent;
}

// ---------------------------------------------------------------------------
// Setup-wizard "Verify" intent cookie (#2087)
// ---------------------------------------------------------------------------

export interface GoogleVerifyIntent {
  memberId: string;
}

/**
 * Build the signed value for the verify-intent cookie, binding the Full Admin's
 * member id and an absolute expiry. Namespaced with `k: "verify"` so it can only
 * ever be interpreted as a verification, never as a link (and vice versa).
 * Format: `base64url(json).base64url(hmac)`.
 */
export function buildGoogleVerifyIntentValue(memberId: string): string {
  const payload = base64url(
    JSON.stringify({
      m: memberId,
      e: Date.now() + GOOGLE_VERIFY_INTENT_TTL_SECONDS * 1000,
      k: "verify",
    }),
  );
  return `${payload}.${sign(payload)}`;
}

function verifyVerifyIntentValue(
  value: string | undefined,
): GoogleVerifyIntent | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expected = sign(payload);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as { m?: unknown; e?: unknown; k?: unknown };
    // The `k: "verify"` namespace guard: a link cookie (no `k`) can never be
    // accepted here even if its HMAC checks out, so the two intents never cross.
    if (
      decoded.k !== "verify" ||
      typeof decoded.m !== "string" ||
      typeof decoded.e !== "number"
    ) {
      return null;
    }
    if (decoded.e <= Date.now()) {
      return null;
    }
    return { memberId: decoded.m };
  } catch {
    return null;
  }
}

/**
 * Read + verify the verify-intent cookie from the current request, then
 * best-effort clear it. Returns the bound Full-Admin member id when a valid,
 * unexpired verify intent is present, else null. The signIn callback binds the
 * result to the CURRENT session before recording verification, so a stale cookie
 * on a shared device can never mark Google verified on someone else's behalf.
 */
export async function readGoogleVerifyIntent(): Promise<GoogleVerifyIntent | null> {
  const store = await cookies();
  const intent = verifyVerifyIntentValue(
    store.get(GOOGLE_VERIFY_INTENT_COOKIE)?.value,
  );
  if (intent) {
    try {
      store.delete(GOOGLE_VERIFY_INTENT_COOKIE);
    } catch {
      // Best-effort; TTL bounds a surviving cookie.
    }
  }
  return intent;
}

/**
 * Pure sub-only resolver for the LOGIN path, run inside the Google provider's
 * `profile()`. Resolves ONLY by `googleSub === profile.sub` among login-capable
 * members — never by email, never provisioning. Applies the same gate as password
 * login (active + emailVerified) plus the forcePasswordChange refusal, and reports
 * the verdict via `googleLoginStatus` so the signIn callback can surface a friendly
 * message. Has NO write side effects.
 */
export async function resolveGoogleProfile(profile: {
  sub?: unknown;
  email?: unknown;
}): Promise<GoogleProfileResult> {
  const sub = typeof profile.sub === "string" ? profile.sub : "";
  const email = typeof profile.email === "string" ? profile.email : null;
  // Sentinel id: clearly not a member id, so it can never resolve a session even
  // if the flow reached the jwt callback (it never does — signIn refuses first).
  const sentinelId = `google-oauth:${sub || "unknown"}`;

  if (!sub) {
    return { id: sentinelId, email, googleLoginStatus: "failed" };
  }

  // This runs INSIDE the Google provider's profile(), i.e. inside @auth/core. A
  // throw escaping here lets @auth/core substitute a default/fallback user whose
  // id matches no member row — the production dangling-session incident that
  // trapped /dashboard <-> /login in a redirect loop (#2229). The live DB read
  // below can throw transiently, so fail CLOSED to the explicit refusal sentinel
  // rather than ever surfacing a throw. The sentinel id is deliberately not a
  // member id, and signIn maps "failed" to a friendly refusal redirect.
  try {
    const member = await prisma.member.findFirst({
      where: { googleSub: sub, canLogin: true },
    });

    if (!member) {
      return { id: sentinelId, email, googleLoginStatus: "unlinked" };
    }
    // #2620, deliberately BEFORE the `active` gate and independent of it. This
    // is the sharpest edge of the deleted-account defect: anonymisation does not
    // clear `googleSub`, and this resolver matches on `googleSub` alone — the
    // `@deleted.invalid` address is never consulted — so the erased person's
    // Google account still points at their row. `active: false` is the only
    // thing refusing them, and `active` is precisely what an admin Reactivate
    // flips. Refusing on the canonical deletion predicate here means a directly
    // flipped `active` column still yields no session.
    if (isDeletedAccountRecord(member)) {
      logger.warn(
        { memberId: member.id },
        "Refusing Google sign-in for a deleted account (#2620)",
      );
      return { id: sentinelId, email, googleLoginStatus: "refused" };
    }
    if (!member.active || !member.emailVerified) {
      return { id: sentinelId, email, googleLoginStatus: "refused" };
    }
    if (member.forcePasswordChange) {
      return { id: sentinelId, email, googleLoginStatus: "password_change" };
    }

    return {
      id: member.id,
      email: member.email,
      name: `${member.firstName} ${member.lastName}`,
      role: member.role,
      forcePasswordChange: member.forcePasswordChange,
      isEmailVerified: member.emailVerified,
      twoFactorEnabled: member.twoFactorEnabled,
      twoFactorMethod: member.twoFactorMethod,
      googleLoginStatus: "ok",
    };
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.name : "unknown" },
      "resolveGoogleProfile failed — refusing Google sign-in (fail closed)",
    );
    return { id: sentinelId, email, googleLoginStatus: "failed" };
  }
}

export type GoogleLinkOutcome =
  | "googleLinked=1"
  | "googleError=already_linked"
  | "googleError=account_conflict"
  | "googleError=failed";

async function auditGoogleLink(event: StructuredAuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create(buildStructuredAuditLogCreateArgs(event));
  } catch (err) {
    logger.error({ err }, "Failed to write Google account-link audit");
  }
}

/**
 * Pin `Member.googleSub = sub` for the authenticated member, guarded and audited.
 * Refuses when the sub is already linked to ANOTHER member (takeover guard) or the
 * member is already linked to a DIFFERENT sub (must unlink first). Idempotent when
 * the member is already linked to this exact sub. Never touches password login.
 */
export async function linkGoogleAccount(
  memberId: string,
  sub: string,
): Promise<GoogleLinkOutcome> {
  const [existingBySub, member] = await Promise.all([
    prisma.member.findUnique({
      where: { googleSub: sub },
      select: { id: true },
    }),
    prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, googleSub: true },
    }),
  ]);

  if (!member) {
    return "googleError=failed";
  }

  if (existingBySub && existingBySub.id !== memberId) {
    // Sub already pinned to a different member — refuse (no takeover).
    await auditGoogleLink({
      action: "member.google.link_refused",
      actor: { memberId },
      subject: { memberId },
      entity: { type: "Member", id: memberId },
      category: "security",
      severity: "important",
      outcome: "blocked",
      summary: "Google account link refused (already linked to another member)",
      metadata: { reason: "sub_linked_to_other_member" },
    });
    return "googleError=already_linked";
  }

  if (member.googleSub && member.googleSub !== sub) {
    // Member already linked to a different Google account — unlink first.
    await auditGoogleLink({
      action: "member.google.link_refused",
      actor: { memberId },
      subject: { memberId },
      entity: { type: "Member", id: memberId },
      category: "security",
      severity: "important",
      outcome: "blocked",
      summary: "Google account link refused (member already linked)",
      metadata: { reason: "member_already_linked_other_sub" },
    });
    return "googleError=account_conflict";
  }

  if (member.googleSub === sub) {
    // Idempotent no-op (e.g. re-link of the same account, replayed cookie).
    return "googleLinked=1";
  }

  try {
    await prisma.member.update({
      where: { id: memberId },
      data: { googleSub: sub },
    });
  } catch (err) {
    // Race: another member linked this exact sub between the read above and this
    // write. The googleSub @unique constraint rejects it with P2002 — fail
    // closed to the same friendly refusal rather than the bare Auth.js error
    // page (never a takeover; the first writer keeps the sub).
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002"
    ) {
      await auditGoogleLink({
        action: "member.google.link_refused",
        actor: { memberId },
        subject: { memberId },
        entity: { type: "Member", id: memberId },
        category: "security",
        severity: "important",
        outcome: "blocked",
        summary: "Google account link refused (unique-constraint race)",
        metadata: { reason: "sub_linked_to_other_member_race" },
      });
      return "googleError=already_linked";
    }
    throw err;
  }
  await auditGoogleLink({
    action: "member.google.linked",
    actor: { memberId },
    subject: { memberId },
    entity: { type: "Member", id: memberId },
    category: "security",
    severity: "important",
    outcome: "success",
    summary: "Google account linked",
  });
  return "googleLinked=1";
}

/**
 * Clear `Member.googleSub`, audited. Password login always remains, so unlinking
 * is always allowed and never strands a member.
 */
export async function unlinkGoogleAccount(memberId: string): Promise<void> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { googleSub: true },
  });
  if (!member?.googleSub) {
    // Already unlinked — idempotent, nothing to audit.
    return;
  }
  await prisma.member.update({
    where: { id: memberId },
    data: { googleSub: null },
  });
  await auditGoogleLink({
    action: "member.google.unlinked",
    actor: { memberId },
    subject: { memberId },
    entity: { type: "Member", id: memberId },
    category: "security",
    severity: "important",
    outcome: "success",
    summary: "Google account unlinked",
  });
}
