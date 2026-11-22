/**
 * The two halves of a session read that do not depend on how the caller
 * signed in: refreshing a session token from the member's row, and mapping a
 * refreshed token onto `session.user`.
 *
 * Moved verbatim out of the `jwt` and `session` callbacks in `auth.ts`
 * (ALP-653) so a second caller can run the SAME rules rather than a copy of
 * them (`INV-SSOT`): an AI app connection (`INV-MCP-005`) builds its token
 * from the connection and passes it through both functions, so login
 * revocation, the maximum session age (`INV-AUTH-007`), `canLogin`, roles and
 * the two-factor rules reach it by the code a browser session runs. The
 * browser's idle expiry and sign-out live in the cookie, not here, and do not
 * end a connection. Neither
 * function stamps `lastAuthenticatedAt` for such a caller: that is written
 * only on a password sign-in, which a connection never is.
 */
import "server-only";

import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import logger from "./logger";
import type { AppRole } from "./member-roles";
import {
  isAccessRole,
  sessionAccessRoleClaim,
  type AppAccessRole,
} from "./access-roles";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
  sanitizeAdminPermissionMatrix,
} from "./admin-permissions";
import {
  getTokenSessionIssuedAtMs,
  isRevokedMemberSession,
  loadSessionMemberSecurity,
} from "./session-member-security";
import { loadEffectiveModuleFlags } from "./module-settings";
import { loadLoginSecurityRefresh } from "./login-security-settings";
import { OFFICER_SIGN_IN_ENFORCED } from "./officer-sign-in-switch";
import { resolveOfficerTwoFactorClaims } from "./officer-two-factor";
import { clubTimeZone } from "./club-time/server";
import { isSessionPastMaxAge } from "./session-max-age";
import { isKioskSessionMember } from "./session-idle-expiry";
import { isSecondFactorEnrolled } from "./second-factor-enrolment";
import {
  passwordSignInOwesStrongerFactor,
  recentAuthSignInCounts,
} from "./recent-auth";

export interface SessionRefreshOptions {
  /** This call is the sign-in itself: only then does the `jwt` callback carry `user`. */
  readonly signIn: boolean;
  /** The sign-in was a password, the one proof this refresh may stamp. */
  readonly passwordSignIn: boolean;
}

/**
 * Refreshes a session token in place from the member's current row: roles,
 * the admin-permission matrix, login revocation, the maximum session age and
 * the two-factor claims. A token whose session must end leaves with
 * `sessionInvalidated: true`.
 */
export async function refreshSessionToken(
  token: JWT,
  options: SessionRefreshOptions,
): Promise<void> {
  // #4611 (INV-AUTH-007): the maximum session age is judged on the stamp
  // the token ARRIVED with, before the line below back-fills a missing one
  // from `iat` or now: a token with no readable stamp is expired, never
  // given a fresh clock. Only the sign-in branch of the `jwt`
  // callback mints a stamp.
  const incomingSessionStamp = { sessionIssuedAt: token.sessionIssuedAt };

  const sessionIssuedAt = getTokenSessionIssuedAtMs(token);
  token.sessionIssuedAt = sessionIssuedAt;

  if (typeof token.id === "string") {
    // Refresh security-sensitive session fields so role changes take effect
    // on the next request instead of waiting for JWT expiry.
    const member = await loadSessionMemberSecurity(token.id);

    if (member) {
      const [modules, loginSecurity] = await Promise.all([
        loadEffectiveModuleFlags(),
        // #4611 and #4618: session age and the officer policy, one read
        // on every refresh, so a changed setting reaches existing sessions
        // on their next one.
        loadLoginSecurityRefresh(),
      ]);
      const clubSessionMaxAgeHours = loginSecurity.sessionMaxAgeHours;
      const twoFactorRequired = modules.twoFactor === true;
      // The officer claims are a separate fact from the module flag.
      // While the release is off they stay false and nothing is stamped.
      const zone = OFFICER_SIGN_IN_ENFORCED ? await clubTimeZone() : null;
      const officerClaims = await resolveOfficerTwoFactorClaims({
        releaseEnabled: OFFICER_SIGN_IN_ENFORCED,
        policyEnabled: loginSecurity.officerTwoFactorPolicy,
        graceDays: loginSecurity.officerTwoFactorGraceDays,
        member: {
          id: token.id,
          canLogin: member.canLogin,
          role: member.role,
          financeAccessLevel: member.financeAccessLevel,
          accessRoles: member.accessRoles,
          twoFactorEnabled: member.twoFactorEnabled,
          twoFactorMethod: member.twoFactorMethod,
          hasPasskey: member.hasPasskey,
          twoFactorGraceStartedAt: member.twoFactorGraceStartedAt,
          factorsResetAt: member.factorsResetAt,
        },
        zone,
        now: new Date(),
      });
      // A later refresh has no `user`, so it cannot stamp again. A required
      // officer with an app or a passkey gets no password stamp even when
      // the club-wide module is off (INV-AUTH-012).
      const owesAuthenticatorApp = passwordSignInOwesStrongerFactor({
        moduleRequired: twoFactorRequired,
        officerRequired: officerClaims.officerTwoFactorRequired,
        twoFactorEnabled: member.twoFactorEnabled,
        twoFactorMethod: member.twoFactorMethod,
        hasPasskey: member.hasPasskey,
      });
      if (
        options.passwordSignIn &&
        recentAuthSignInCounts("password", owesAuthenticatorApp)
      ) {
        token.lastAuthenticatedAt = Date.now();
      }
      const kioskAccount = isKioskSessionMember(member);

      token.role = member.canLogin === false ? "USER" : member.role;
      // role is null for definition-backed custom-role rows, so the
      // accessRoles claim stays enum-only. Custom roles reach the
      // session through adminPermissionMatrix below (#1367).
      token.accessRoles = sessionAccessRoleClaim(member);
      token.canLogin = member.canLogin;
      // #4612: the next refresh's idle window (session-idle-expiry.ts).
      token.kioskAccount = kioskAccount;
      // #1367: merged admin-permission matrix over the JOINED assignment
      // rows, so definition-backed custom roles and club-edited seeded
      // definitions grant correctly through every session.user-based
      // check (e.g. the #1289/#1313 hasAdminAreaAccess(session.user, …)
      // gates). Recomputed on every token refresh — the same freshness
      // as the enum role claims above.
      token.adminPermissionMatrix = getAdminPermissionMatrix({
        accessRoles: member.accessRoles,
        canLogin: member.canLogin,
      });
      token.forcePasswordChange = member.forcePasswordChange;
      token.postLoginLanding = member.postLoginLanding ?? null;
      token.isEmailVerified = member.emailVerified;
      // #2620 deleted account, #3603 login off or switched off, or a newer
      // password: the defence-in-depth backstop behind the provider
      // refusals above. auth() nulls any session carrying the flag, so every
      // server touch reads as logged-out; a token once invalidated stays so
      // (see session-member-security.ts). #4611 (INV-AUTH-007): so is a
      // session past its maximum age, counted from sign-in: the club's
      // setting, or the lodge kiosk's own 30 days. Nothing here extends it.
      const pastMaxAge =
        token.sessionInvalidated !== true &&
        isSessionPastMaxAge(
          incomingSessionStamp,
          { kioskAccount, clubSessionMaxAgeHours },
          Date.now(),
        );
      // Debug, not info: a bare auth() never saves the flag, so a past-cap
      // cookie is judged again, and would log again, on every read until
      // the session endpoint re-encodes it (#4611 review, R6).
      if (pastMaxAge) {
        logger.debug(
          { memberId: token.id, kioskAccount },
          "Ending a session that has reached its maximum age (#4611)",
        );
      }
      token.sessionInvalidated =
        token.sessionInvalidated === true ||
        isRevokedMemberSession(member, sessionIssuedAt, token.id) ||
        pastMaxAge;
      token.twoFactorRequired = twoFactorRequired;
      token.officerTwoFactorRequired = officerClaims.officerTwoFactorRequired;
      token.twoFactorSatisfiesOfficer = officerClaims.twoFactorSatisfiesOfficer;
      token.officerTwoFactorGraceEndsAt = officerClaims.officerTwoFactorGraceEndsAt;
      const enrolled = isSecondFactorEnrolled({
        twoFactorEnabled: member.twoFactorEnabled,
        hasPasskey: member.hasPasskey,
        sessionEnrolled: false,
      });
      token.hasPasskey = member.hasPasskey === true;
      token.twoFactorEnrolled = enrolled;
      token.twoFactorMethod = member.twoFactorMethod ?? null;
      if (!twoFactorRequired) {
        token.twoFactorVerified = true;
      } else if (!enrolled) {
        token.twoFactorVerified = false;
        token.twoFactorVerifiedByChallenge = false;
      } else if (options.signIn) {
        token.twoFactorVerified = false;
        token.twoFactorVerifiedByChallenge = false;
      } else {
        const verifiedByChallenge =
          token.twoFactorVerifiedByChallenge === true;
        token.twoFactorVerified = verifiedByChallenge;
        token.twoFactorVerifiedByChallenge = verifiedByChallenge;
      }
    } else {
      // No live member resolves for this token id — a deleted member, or a
      // dangling id from a fallback-user substitution (#2229). Invalidate the
      // session using the SAME kill-switch as a revoking password change:
      // auth() (the shared helper) nulls any session carrying
      // sessionInvalidated. Because every server touch — the authenticated
      // layout AND /login itself — resolves the session through auth(), a
      // dangling token now reads as logged-out EVERYWHERE, so /login renders
      // the sign-in form instead of bouncing back to /dashboard. That breaks
      // the /dashboard <-> /login white-flash loop at its root rather than
      // papering over one redirect. loadSessionMemberSecurity returns null
      // ONLY for a genuinely absent row (a transient DB error throws and is
      // left to propagate), so a connection blip never invalidates a live
      // session.
      token.sessionInvalidated = true;
      token.kioskAccount = false;
      token.officerTwoFactorRequired = false;
      token.twoFactorSatisfiesOfficer = false;
      token.officerTwoFactorGraceEndsAt = null;
    }
  }
}

/** Maps a refreshed token onto `session.user`, failing closed on anything unreadable. */
export function applySessionTokenToUser(user: Session["user"], token: JWT): void {
  user.role = token.role as AppRole;
  user.accessRoles = Array.isArray(token.accessRoles)
    ? token.accessRoles.filter(
        (role): role is AppAccessRole =>
          typeof role === "string" && isAccessRole(role),
      )
    : [];
  // #3603: fail closed; only an explicit true from the refresh counts.
  user.canLogin = token.canLogin === true;
  // #1367: the refresh above stamps the matrix from the DB-joined
  // member on every request BEFORE this projection runs, so this
  // fallback only fires when that refresh could not run (member row gone,
  // token without an id). Fail closed to all-none for those rather than
  // leaving the field absent — session.user always carries the property,
  // and getAdminPermissionMatrix treats a present matrix as
  // authoritative.
  user.adminPermissionMatrix =
    sanitizeAdminPermissionMatrix(token.adminPermissionMatrix) ??
    emptyAdminPermissionMatrix();
  user.id = token.id as string;
  user.forcePasswordChange = token.forcePasswordChange as boolean;
  user.postLoginLanding =
    token.postLoginLanding === "MEMBER_DASHBOARD" ||
    token.postLoginLanding === "ADMIN_DASHBOARD"
      ? token.postLoginLanding
      : null;
  user.isEmailVerified = token.isEmailVerified as boolean;
  user.sessionInvalidated = Boolean(token.sessionInvalidated);
  if (typeof token.sessionIssuedAt === "number") {
    user.sessionIssuedAt = token.sessionIssuedAt;
  }
  if (
    typeof token.lastAuthenticatedAt === "number" &&
    Number.isFinite(token.lastAuthenticatedAt)
  ) {
    user.lastAuthenticatedAt = token.lastAuthenticatedAt;
  }
  user.twoFactorRequired = Boolean(token.twoFactorRequired);
  user.officerTwoFactorRequired = token.officerTwoFactorRequired === true;
  user.twoFactorSatisfiesOfficer = token.twoFactorSatisfiesOfficer === true;
  user.officerTwoFactorGraceEndsAt =
    typeof token.officerTwoFactorGraceEndsAt === "number"
      ? token.officerTwoFactorGraceEndsAt
      : null;
  user.twoFactorVerified = Boolean(token.twoFactorVerified);
  user.twoFactorEnrolled = Boolean(token.twoFactorEnrolled);
  user.hasPasskey = token.hasPasskey === true;
  user.twoFactorMethod =
    token.twoFactorMethod === "TOTP" || token.twoFactorMethod === "EMAIL"
      ? token.twoFactorMethod
      : null;
}
