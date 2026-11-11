import { getSafeInternalReturnPath } from "@/lib/internal-return-path";
import { isSecondFactorEnrolled } from "@/lib/second-factor-enrolment";

export type TwoFactorSessionUser = {
  id?: string | null;
  twoFactorRequired?: boolean;
  twoFactorVerified?: boolean;
  twoFactorEnrolled?: boolean;
  hasPasskey?: boolean;
  /** Officer rule (#4618). Independent of the club-wide module flag. */
  officerTwoFactorRequired?: boolean;
  twoFactorSatisfiesOfficer?: boolean;
  /** Epoch ms. Null when they are not required or they already satisfy. */
  officerTwoFactorGraceEndsAt?: number | null;
};

export type TwoFactorGateMember = {
  forcePasswordChange?: boolean | null;
  twoFactorEnabled?: boolean | null;
};

export function isTwoFactorSessionBlocked(params: {
  sessionUser?: TwoFactorSessionUser | null;
  member?: TwoFactorGateMember | null;
  allowForcePasswordChange?: boolean;
}) {
  const { sessionUser, member, allowForcePasswordChange = false } = params;

  if (!sessionUser?.twoFactorRequired || sessionUser.twoFactorVerified) {
    return false;
  }

  if (allowForcePasswordChange && member?.forcePasswordChange) {
    return false;
  }

  return true;
}

export function buildTwoFactorGatePath(params: {
  sessionUser?: TwoFactorSessionUser | null;
  member?: TwoFactorGateMember | null;
  callbackPath?: string | null;
}) {
  const callbackUrl = getSafeInternalReturnPath(params.callbackPath) ?? "/dashboard";
  const enrolled = isSecondFactorEnrolled({
    twoFactorEnabled: params.member?.twoFactorEnabled,
    hasPasskey: params.sessionUser?.hasPasskey,
    sessionEnrolled: params.sessionUser?.twoFactorEnrolled,
  });
  const destination = enrolled ? "/login/verify" : "/login/enroll";
  const query = new URLSearchParams({ callbackUrl });
  return `${destination}?${query.toString()}`;
}

/**
 * Pages and routes a required officer can still open after grace (#4618).
 * Sign-in assertion routes are not on this list. A module challenge is a
 * separate gate and is not waived by being listed here.
 */
export function isOfficerEnrolmentPathAllowed(
  pathname: string | null | undefined,
  method?: string | null,
): boolean {
  if (!pathname) return false;
  const path = pathname.split("?")[0] ?? "";
  if (path === "/login/enroll" || path === "/login/verify" || path === "/profile") {
    return true;
  }
  if (path.startsWith("/profile/")) return true;
  if (path === "/api/auth/signout") {
    return (method ?? "POST").toUpperCase() === "POST";
  }
  if (path.startsWith("/api/auth/2fa/enroll/")) return true;
  if (path === "/api/auth/2fa/totp/setup" || path === "/api/auth/2fa/status") {
    return true;
  }
  if (
    path === "/api/auth/2fa/webauthn/register/options" ||
    path === "/api/auth/2fa/webauthn/register/verify"
  ) {
    return true;
  }
  return (
    /^\/api\/auth\/2fa\/webauthn\/[^/]+$/.test(path) &&
    (method ?? "").toUpperCase() === "DELETE"
  );
}

/**
 * After the club-wide challenge is done (or when there is none): a required
 * officer who does not satisfy, and whose grace has ended, is blocked
 * everywhere except the enrolment allowlist. A null deadline is "not started"
 * and is not a lock-out.
 */
export function isOfficerEnrolmentSessionBlocked(params: {
  sessionUser?: TwoFactorSessionUser | null;
  pathname?: string | null;
  method?: string | null;
  now?: Date;
}): boolean {
  const user = params.sessionUser;
  if (user?.officerTwoFactorRequired !== true) return false;
  if (user.twoFactorSatisfiesOfficer === true) return false;
  if (user.officerTwoFactorGraceEndsAt == null) return false;
  const now = params.now ?? new Date();
  if (now.getTime() < user.officerTwoFactorGraceEndsAt) return false;
  return !isOfficerEnrolmentPathAllowed(params.pathname, params.method);
}

/**
 * One answer for every caller of the club-wide challenge: the existing
 * enrol-or-verify redirect, then the officer enrolment gate. Null means the
 * request proceeds. Allowlisted paths proceed through the officer gate; they
 * do not skip a club-wide challenge that is still owed.
 */
export function factorGateRedirect(params: {
  sessionUser?: TwoFactorSessionUser | null;
  member?: TwoFactorGateMember | null;
  callbackPath?: string | null;
  pathname?: string | null;
  method?: string | null;
  allowForcePasswordChange?: boolean;
  now?: Date;
}): string | null {
  if (isTwoFactorSessionBlocked(params)) {
    return buildTwoFactorGatePath(params);
  }
  if (
    isOfficerEnrolmentSessionBlocked({
      sessionUser: params.sessionUser,
      pathname: params.pathname ?? params.callbackPath ?? null,
      method: params.method,
      now: params.now,
    })
  ) {
    const callbackUrl =
      getSafeInternalReturnPath(params.callbackPath ?? params.pathname) ?? "/dashboard";
    const query = new URLSearchParams({ callbackUrl });
    return `/login/enroll?${query.toString()}`;
  }
  return null;
}
