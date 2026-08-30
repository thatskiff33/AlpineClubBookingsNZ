/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850): a `"use client"` module
 * that reaches NextAuth's configuration, `bcrypt` and the credential callbacks
 * fails `next build` with the import chain printed.
 * `scripts/ci/server-only-boundary-selftest.mjs` plants exactly that and proves
 * the build still catches it, for this module and for `@/lib/prisma`.
 * `docs/invariants/operations.md` → `INV-OPS-013` lists every marked root and
 * why the operator CLIs that reach them run with `--conditions=react-server`.
 */
import "server-only";

import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { getAuthSecret, getAuthTrustHost } from "./runtime-config";
import logger from "./logger";
import type { PostLoginLanding } from "@prisma/client";
import type { AppRole } from "./member-roles";
import {
  hasAccessRole,
  isAccessRole,
  isFullAdmin,
  type AppAccessRole,
} from "./access-roles";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
  sanitizeAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "./admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "./access-role-definitions";
import { loadEffectiveModuleFlags } from "./module-settings";
import { consumeTwoFactorSessionChallenge } from "./two-factor";
import { hashActionToken, isActionTokenFormat } from "./action-tokens";
import {
  linkGoogleAccount,
  readGoogleLinkIntent,
  readGoogleVerifyIntent,
  resolveGoogleProfile,
  type GoogleMemberUser,
  type GoogleProfileResult,
} from "./google-oauth";
import { getGoogleOAuthConfig, recordGoogleVerified } from "./google-config";
import { isDeletedAccountRecord } from "./deleted-account";

class EmailNotVerifiedError extends CredentialsSignin {
  code = "EMAIL_NOT_VERIFIED";
}

// A magic link must never trap a member who has a pending forced password
// change: the /change-password flow requires the current password, and only the
// password-reset flow clears `forcePasswordChange`. So passwordless sign-in
// refuses these members and points them at "Forgot password" (#2034).
class MagicLinkPasswordChangeRequiredError extends CredentialsSignin {
  code = "PASSWORD_CHANGE_REQUIRED";
}

// bcrypt hash of a random throwaway value. Compared against when no member
// matches the email so unknown and known accounts take the same time,
// preventing account enumeration via response timing.
const DUMMY_PASSWORD_HASH =
  // Not a live credential: a bcrypt hash of a random throwaway value, only ever
  // compared against to equalise response timing (see comment above).
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
  "$2b$12$vgnj5fAMZNzi.jYdELu0f.rjCvFqb/tgzYxtvBWJu8vCJYVO64SKC";

const SESSION_MEMBER_SECURITY_SELECT = {
  role: true,
  canLogin: true,
  forcePasswordChange: true,
  emailVerified: true,
  passwordChangedAt: true,
  // #2620: the two markers an approved deletion request writes over the row.
  // Read on every token refresh so an anonymised member's session dies on their
  // NEXT request through the same kill-switch a revoking password change uses —
  // deletion invalidates no token today, so without this a session minted
  // before the deletion (or after a direct `active` flip) would keep working.
  // Neither value is ever copied into the token; only the predicate's verdict
  // is used.
  email: true,
  passwordHash: true,
  twoFactorEnabled: true,
  twoFactorMethod: true,
  // Post-login landing preference (#2090), refreshed per request alongside the
  // security fields so a profile toggle change takes effect on the next request.
  postLoginLanding: true,
  // Joined definitions (#1367) so the per-request token refresh can compute
  // the merged admin-permission matrix over custom and club-edited
  // definition-backed roles, not just the enum bundles.
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} as const;

async function loadSessionMemberSecurity(userId: string) {
  return prisma.member.findUnique({
    where: { id: userId },
    select: SESSION_MEMBER_SECURITY_SELECT,
  });
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: AppRole;
      /**
       * Enum access roles ONLY. Definition-backed custom roles carry
       * `role: null` and are absent here — admin-capability checks must use
       * `adminPermissionMatrix` below (via hasAdminAreaAccess), which covers
       * custom and club-edited roles (#1367).
       */
      accessRoles: AppAccessRole[];
      /**
       * Merged admin-permission matrix computed from the DB-joined member at
       * the per-request token refresh (#1367). Authoritative for
       * session.user-based area checks: getAdminPermissionMatrix returns it
       * directly when present.
       */
      adminPermissionMatrix: AdminPermissionMatrix;
      forcePasswordChange: boolean;
      isEmailVerified: boolean;
      sessionInvalidated?: boolean;
      /**
       * Epoch ms the JWT session was first issued (#1669). Present so the
       * auth-bounce diagnostics can record how far a revoking password
       * change post-dates the session; absent when the token carries no
       * issuance claim.
       */
      sessionIssuedAt?: number;
      twoFactorRequired: boolean;
      twoFactorVerified: boolean;
      twoFactorEnrolled: boolean;
      twoFactorMethod: "TOTP" | "EMAIL" | null;
      /**
       * Post-login landing preference (#2090). null = follow the role default
       * (admin access ⇒ first accessible admin page, else /dashboard).
       */
      postLoginLanding: PostLoginLanding | null;
    };
  }
  interface User {
    role: AppRole;
    forcePasswordChange: boolean;
    isEmailVerified: boolean;
    twoFactorEnabled: boolean;
    twoFactorMethod: "TOTP" | "EMAIL" | null;
  }
}

function getTokenSessionIssuedAtMs(token: {
  sessionIssuedAt?: unknown;
  iat?: unknown;
}) {
  if (
    typeof token.sessionIssuedAt === "number" &&
    Number.isFinite(token.sessionIssuedAt)
  ) {
    return token.sessionIssuedAt;
  }

  if (typeof token.iat === "number" && Number.isFinite(token.iat)) {
    return token.iat * 1000;
  }

  return Date.now();
}

/**
 * Build the Google OAuth provider (#2035 semantics, frozen). JWT strategy, NO
 * adapter. The provider `profile()` maps a Google identity to OUR member identity
 * by `googleSub === profile.sub` ONLY (never email-match, never provision),
 * returning the EXACT same user shape as the Credentials providers so the
 * UNCHANGED jwt/session callbacks stamp role, the admin-permission matrix, and
 * the 2FA claims identically. Every gate and the module kill-switch are finalised
 * in the signIn callback. The same provider serves account-linking, disambiguated
 * there by the short-lived link-intent cookie.
 *
 * Only the SOURCE of clientId/clientSecret changed in #2087: the runtime config
 * resolves them from the encrypted C1 store and passes them here; the static
 * test-seam config passes them unset (as when the env vars were unset).
 */
function buildGoogleProvider(credentials: {
  clientId?: string;
  clientSecret?: string;
}) {
  return Google({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    // Never auto-link by matching email across identity providers — linking is
    // profile-initiated only.
    allowDangerousEmailAccountLinking: false,
    async profile(profile) {
      // Pure sub-only resolver (no writes). Returns the member user shape when
      // eligible, else a sentinel carrying the refusal reason for signIn. The
      // sentinel intentionally omits the augmented User fields (it can never
      // mint a session — signIn refuses first), so cast past the User type.
      //
      // Defence in depth (#2229): resolveGoogleProfile is already fail-closed and
      // never throws, but this boundary to @auth/core must be belt-and-braces —
      // any throw escaping profile() lets @auth/core substitute a default user
      // whose id matches no member (the dangling-session incident). Catch here
      // too and return the explicit refusal sentinel so a session can never be
      // minted from a fallback identity.
      try {
        return (await resolveGoogleProfile(
          profile,
        )) as unknown as GoogleMemberUser;
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.name : "unknown" },
          "Google provider profile() threw — refusing sign-in (fail closed)",
        );
        const rawSub = (profile as { sub?: unknown } | undefined)?.sub;
        const rawEmail = (profile as { email?: unknown } | undefined)?.email;
        const sub = typeof rawSub === "string" ? rawSub : "";
        const email = typeof rawEmail === "string" ? rawEmail : null;
        return {
          id: `google-oauth:${sub || "unknown"}`,
          email,
          googleLoginStatus: "failed",
        } as unknown as GoogleMemberUser;
      }
    },
  });
}

// test seam
export const authConfig = {
  trustHost: getAuthTrustHost(),
  secret: getAuthSecret(),
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Only members with canLogin=true (adults with unique email + password) can log in
        const member = await prisma.member.findFirst({
          where: { email: email.toLowerCase(), canLogin: true },
        });

        // #2620: `isDeletedAccountRecord` is an INDEPENDENT refusal, not a
        // restatement of `!member.active`. An approved deletion request
        // anonymises the row and leaves `active: false` as the only barrier, and
        // an admin Reactivate (or a direct column edit) flips exactly that flag.
        // Refusing on the anonymisation markers means an erased account cannot
        // sign in even with `active: true`. The sentinel password hash is not a
        // bcrypt hash so a compare could never match anyway — this is here so a
        // future credential-restoring path cannot re-open the door silently.
        // Still burns the dummy compare, so the refusal is timing-identical to
        // an unknown email and cannot be used to enumerate deleted accounts.
        if (!member || !member.active || isDeletedAccountRecord(member)) {
          await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const isValid = await bcrypt.compare(password, member.passwordHash);
        if (!isValid) {
          return null;
        }

        // Block unverified members from creating a session
        if (!member.emailVerified) {
          throw new EmailNotVerifiedError();
        }

        try {
          await prisma.member.update({
            where: { id: member.id },
            data: { lastLoginAt: new Date() },
          });
        } catch (error) {
          logger.warn(
            { err: error, memberId: member.id },
            "Failed to update member last login timestamp"
          );
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
        };
      },
    }),
    // Passwordless magic-link sign-in (#2034). Additive to the password
    // provider above and returns the EXACT same user shape, so the unchanged
    // jwt/session callbacks stamp role, the admin-permission matrix, and the
    // 2FA claims identically — a 2FA-enabled member still lands on
    // /login/verify. This provider NEVER sets twoFactorVerified.
    Credentials({
      id: "magic-link",
      name: "magic-link",
      credentials: {
        token: { label: "Token", type: "text" },
      },
      async authorize(credentials) {
        const rawToken = credentials?.token;
        if (typeof rawToken !== "string" || !isActionTokenFormat(rawToken)) {
          return null;
        }

        // Verify-side kill-switch: a fresh (never cached) module read, matching
        // the request endpoint's own fresh-read posture, so disabling the
        // magicLink module immediately stops outstanding links being redeemed
        // rather than leaving them live for up to the full TTL. Placed BEFORE
        // the single-use token claim on purpose: a temporary disable must not
        // burn an unredeemed link — re-enabling the module lets the same link
        // still work within its TTL, which is what an admin toggling expects.
        const modules = await loadEffectiveModuleFlags();
        if (!modules.magicLink) {
          return null;
        }

        const tokenHash = hashActionToken(rawToken.trim());
        const tokenRow = await prisma.magicLinkToken.findUnique({
          where: { tokenHash },
        });

        // Reject missing, already-used, or expired tokens.
        if (
          !tokenRow ||
          tokenRow.used ||
          tokenRow.expiresAt.getTime() <= Date.now()
        ) {
          return null;
        }

        // Single-use via a conditional claim: only the update that flips
        // used:false -> used:true wins, so two concurrent clicks of the same
        // link mint at most one session (planning-review finding — a plain
        // $transaction wrapper does NOT stop the race; the WHERE used:false
        // guard does). count !== 1 means another request already claimed it.
        const claim = await prisma.magicLinkToken.updateMany({
          where: { id: tokenRow.id, used: false },
          data: { used: true },
        });
        if (claim.count !== 1) {
          return null;
        }

        // Same gate as password login: only canLogin members, and only while
        // active. Archived/dependent members cannot mint a session even with a
        // valid, freshly-claimed token row.
        const member = await prisma.member.findFirst({
          where: { id: tokenRow.memberId, canLogin: true },
        });
        // #2620: and never for an account an approved deletion request has
        // anonymised. Deletion does not revoke outstanding magic-link tokens
        // (Half B of #2620 will), so any unexpired link the erased member was
        // sent stays redeemable the moment `active` goes back to true. Refuse on
        // the anonymisation markers, independently of `active`.
        if (!member || !member.active || isDeletedAccountRecord(member)) {
          return null;
        }

        // Block unverified members — magic link must never be an
        // email-verification bypass (owner decision, #2030).
        if (!member.emailVerified) {
          throw new EmailNotVerifiedError();
        }

        // Refuse while a forced password change is pending: signing in here
        // would strand the member on /change-password (which needs the current
        // password). Point them at Forgot password, which clears the flag.
        if (member.forcePasswordChange) {
          throw new MagicLinkPasswordChangeRequiredError();
        }

        try {
          await prisma.member.update({
            where: { id: member.id },
            data: { lastLoginAt: new Date() },
          });
        } catch (error) {
          logger.warn(
            { err: error, memberId: member.id },
            "Failed to update member last login timestamp"
          );
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
        };
      },
    }),
    // Google OAuth sign-in via profile-initiated linking (#2035, #2087). The
    // client id/secret now come from the encrypted C1 store (DB-only), resolved
    // per-request by the function-form config below — so this STATIC entry (the
    // test seam) carries unset credentials, exactly as it did when the env vars
    // were unset. At runtime the provider is registered ONLY when credentials
    // resolve, and omitted otherwise (buildRequestAuthConfig). See
    // buildGoogleProvider for the frozen #2035 profile()/link semantics.
    buildGoogleProvider({}),
  ],
  callbacks: {
    // Gate + disambiguate every Google round-trip. Non-Google providers are
    // untouched (they had no signIn callback before; returning true preserves
    // "allow"). Returning a STRING makes @auth/core redirect and return EARLY,
    // BEFORE minting a session — so the link path performs its write and
    // redirects with no session identity switch, and every refusal lands on a
    // friendly /login?error=… (or /profile?googleError=…) page.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") {
        return true;
      }

      const sub =
        profile && typeof profile.sub === "string" ? profile.sub : null;

      // SETUP-WIZARD VERIFY round-trip (#2087). Checked BEFORE the module
      // kill-switch: verifying credentials must work even while googleLogin is
      // still disabled (it is disabled until this very verify passes, D2). Being
      // here at all means @auth/core already exchanged the authorization code
      // with Google using the stored client id + secret — the exact production
      // round-trip — so this IS the proof of success. We record verification and
      // redirect WITHOUT minting a session or linking anything.
      const verifyIntent = await readGoogleVerifyIntent();
      if (verifyIntent) {
        // Bind to the CURRENT session: only the Full Admin who started the verify
        // may complete it (mirrors the link-flow shared-device guard). A stale
        // verify cookie on a shared device can therefore never mark Google
        // verified on someone else's OAuth round-trip. auth() here only decodes
        // the session cookie (no recursion into this callback).
        const session = await auth();
        if (
          session?.user?.id === verifyIntent.memberId &&
          isFullAdmin({ accessRoles: session.user.accessRoles })
        ) {
          await recordGoogleVerified();
          return "/admin/google/setup?googleVerified=1";
        }
        return "/admin/google/setup?googleVerifyError=1";
      }

      // Read (and best-effort clear) the link-intent cookie set by the
      // authenticated profile "Connect Google" route. Present ⇒ link round-trip.
      const intent = await readGoogleLinkIntent();

      // Fresh module read (never cached), mirroring magic-link's verify-side
      // kill-switch: disabling googleLogin immediately refuses BOTH new logins
      // AND linking — even for already-linked members.
      const modules = await loadEffectiveModuleFlags();
      if (!modules.googleLogin) {
        return intent
          ? "/profile?googleError=disabled#security"
          : "/login?error=google_disabled";
      }

      if (!sub) {
        return intent
          ? "/profile?googleError=failed#security"
          : "/login?error=google_failed";
      }

      if (intent) {
        // LINK path (profile-initiated, authenticated via the signed cookie).
        //
        // CRITICAL (planning-review MAJOR): bind the link to the CURRENT
        // session, not just to whoever the intent cookie names. Intent clearing
        // is best-effort (@auth/core builds its own Response, so the cookie can
        // survive to its TTL), so on a shared device (e.g. a lodge iPad) a stale
        // intent from member V must NOT convert member W's later Google LOGIN
        // into a cross-member link. Require the session that completed consent to
        // BE the member who started linking. In the legitimate flow the linker
        // always holds an active session equal to the intent, so this is
        // non-breaking; anyone else (no session, or a different member) is
        // refused and simply retries a normal login. auth() is callable here —
        // same request context, and it only decodes the session cookie (it never
        // re-enters this signIn callback, so there is no recursion).
        const session = await auth();
        if (!session?.user?.id || session.user.id !== intent.memberId) {
          return "/login?error=google_refused";
        }

        // Require a verified Google email before pinning the sub.
        const emailVerified =
          profile && (profile as { email_verified?: unknown }).email_verified;
        if (emailVerified !== true) {
          return "/profile?googleError=unverified#security";
        }
        const outcome = await linkGoogleAccount(intent.memberId, sub);
        return `/profile?${outcome}#security`;
      }

      // LOGIN path — sub-only resolution already ran in profile(); read its
      // verdict from the carried status. Never provision, never email-match.
      const status = (user as Partial<GoogleProfileResult> | undefined)
        ?.googleLoginStatus;
      if (status !== "ok") {
        switch (status) {
          case "unlinked":
            return "/login?error=google_unlinked";
          case "password_change":
            return "/login?error=google_password_change";
          case "failed":
            // The resolver (or profile() boundary) failed closed — a transient
            // internal error, not a refused member (#2229). Surface the
            // "couldn't complete" message rather than the "not linked" one.
            return "/login?error=google_failed";
          default:
            return "/login?error=google_refused";
        }
      }

      // Eligible: record the login timestamp, then allow — the unchanged
      // jwt/session callbacks stamp the member identity (never the Google sub)
      // and leave 2FA to be challenged as usual.
      try {
        await prisma.member.update({
          where: { id: user.id as string },
          data: { lastLoginAt: new Date() },
        });
      } catch (error) {
        // A P2025 (record-not-found) is PROOF the id we are about to mint a
        // session for matches no member row — a dangling session id (production
        // incident 2026-07-24, #2229, where @auth/core substituted a fallback
        // user). Refuse the sign-in rather than mint a session that /dashboard
        // can never resolve (which drove the /login <-> /dashboard white-flash
        // loop). Every OTHER error (transient DB/connection issue) keeps the
        // warn-and-allow behaviour: the id is sound, only the timestamp bump
        // failed — distinguish strictly by Prisma error code.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "P2025"
        ) {
          logger.error(
            { err: error, memberId: user.id },
            "Google sign-in refused: session id resolves to no member (dangling id)",
          );
          return "/login?error=google_failed";
        }
        logger.warn(
          { err: error, memberId: user.id },
          "Failed to update member last login timestamp (Google sign-in)",
        );
      }
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.role = user.role;
        token.accessRoles = [];
        token.id = user.id as string;
        token.forcePasswordChange = user.forcePasswordChange;
        token.isEmailVerified = user.isEmailVerified;
        token.sessionIssuedAt = Date.now();
        token.sessionInvalidated = false;
        token.twoFactorVerified = false;
        token.twoFactorVerifiedByChallenge = false;
        token.twoFactorEnrolled = user.twoFactorEnabled;
        token.twoFactorMethod = user.twoFactorMethod;
      }

      if (
        trigger === "update" &&
        typeof token.id === "string" &&
        typeof session === "object" &&
        session !== null &&
        "user" in session &&
        typeof session.user === "object" &&
        session.user !== null &&
        "twoFactorChallengeToken" in session.user &&
        typeof session.user.twoFactorChallengeToken === "string"
      ) {
        // The update trigger is reachable by any authenticated client via
        // POST /api/auth/session, so client-supplied fields such as
        // twoFactorVerified must never be trusted here. Verification is only
        // honoured when the update carries the single-use challenge token
        // minted server-side by markTwoFactorSessionVerified().
        const challengeVerified = await consumeTwoFactorSessionChallenge(
          token.id,
          session.user.twoFactorChallengeToken,
        );
        if (challengeVerified) {
          token.twoFactorVerified = true;
          token.twoFactorVerifiedByChallenge = true;
        }
      }

      const sessionIssuedAt = getTokenSessionIssuedAtMs(token);
      token.sessionIssuedAt = sessionIssuedAt;

      if (typeof token.id === "string") {
        // Refresh security-sensitive session fields so role changes take effect
        // on the next request instead of waiting for JWT expiry.
        const member = await loadSessionMemberSecurity(token.id);

        if (member) {
          const modules = await loadEffectiveModuleFlags();
          const twoFactorRequired = modules.twoFactor === true;

          token.role = member.role;
          // role is null for definition-backed custom-role rows, so the
          // accessRoles claim stays enum-only. Custom roles reach the
          // session through adminPermissionMatrix below (#1367).
          token.accessRoles = member.accessRoles
            .map(({ role }) => role)
            .filter(isAccessRole);
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
          // #2620: an account an approved deletion request has anonymised holds
          // no session, full stop — whatever `active` currently says. This is the
          // defence-in-depth backstop behind the provider refusals above: it
          // covers a session minted BEFORE the deletion (nothing revokes tokens
          // on deletion today) and a session minted after someone flipped
          // `active` back directly in the database. Same kill-switch as a
          // revoking password change: auth() nulls any session carrying it, so
          // every server touch reads as logged-out.
          const deletedAccountSession = isDeletedAccountRecord(member);
          if (deletedAccountSession) {
            logger.warn(
              { memberId: token.id },
              "Invalidating session for a deleted account (#2620)",
            );
          }
          token.sessionInvalidated =
            deletedAccountSession ||
            (member.passwordChangedAt instanceof Date &&
              member.passwordChangedAt.getTime() > sessionIssuedAt);
          token.twoFactorRequired = twoFactorRequired;
          token.twoFactorEnrolled = member.twoFactorEnabled;
          token.twoFactorMethod = member.twoFactorMethod ?? null;
          if (!twoFactorRequired) {
            token.twoFactorVerified = true;
          } else if (!member.twoFactorEnabled) {
            token.twoFactorVerified = false;
            token.twoFactorVerifiedByChallenge = false;
          } else if (user) {
            token.twoFactorVerified = false;
            token.twoFactorVerifiedByChallenge = false;
          } else {
            const verifiedByChallenge =
              token.twoFactorVerifiedByChallenge === true;
            token.twoFactorVerified = verifiedByChallenge;
            token.twoFactorVerifiedByChallenge = verifiedByChallenge;
          }
          // Lodge access accounts get 30-day sessions for shared iPad kiosk.
          if (user && hasAccessRole(member, "LODGE")) {
            token.exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
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
        }
      }

      return token;
    },
    async session({ session, token }) {
      session.user.role = token.role as AppRole;
      session.user.accessRoles = Array.isArray(token.accessRoles)
        ? token.accessRoles.filter(
            (role): role is AppAccessRole =>
              typeof role === "string" && isAccessRole(role),
          )
        : [];
      // #1367: the jwt callback above stamps the matrix from the DB-joined
      // member on every request BEFORE this projection runs, so this
      // fallback only fires when that refresh could not run (member row gone,
      // token without an id). Fail closed to all-none for those rather than
      // leaving the field absent — session.user always carries the property,
      // and getAdminPermissionMatrix treats a present matrix as
      // authoritative.
      session.user.adminPermissionMatrix =
        sanitizeAdminPermissionMatrix(token.adminPermissionMatrix) ??
        emptyAdminPermissionMatrix();
      session.user.id = token.id as string;
      session.user.forcePasswordChange = token.forcePasswordChange as boolean;
      session.user.postLoginLanding =
        token.postLoginLanding === "MEMBER_DASHBOARD" ||
        token.postLoginLanding === "ADMIN_DASHBOARD"
          ? token.postLoginLanding
          : null;
      session.user.isEmailVerified = token.isEmailVerified as boolean;
      session.user.sessionInvalidated = Boolean(token.sessionInvalidated);
      if (typeof token.sessionIssuedAt === "number") {
        session.user.sessionIssuedAt = token.sessionIssuedAt;
      }
      session.user.twoFactorRequired = Boolean(token.twoFactorRequired);
      session.user.twoFactorVerified = Boolean(token.twoFactorVerified);
      session.user.twoFactorEnrolled = Boolean(token.twoFactorEnrolled);
      session.user.twoFactorMethod =
        token.twoFactorMethod === "TOTP" || token.twoFactorMethod === "EMAIL"
          ? token.twoFactorMethod
          : null;
      return session;
    },
  },
  pages: {
    signIn: "/login",
    // Route genuine provider-side aborts (Google consent denied, OAuth state
    // mismatch, etc.) that never reach our signIn callback to /login instead of
    // the bare Auth.js /api/auth/error page. @auth/core appends ?error=<Code>
    // (e.g. OAuthCallbackError, AccessDenied), which the login form's generic
    // OAuth branch renders as a sensible "couldn't complete sign-in" message.
    error: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
} satisfies NextAuthConfig;

/**
 * The always-present providers (password + magic-link Credentials). Derived from
 * the static config by IDENTITY — every provider that is NOT the Google OAuth
 * provider — so they are defined exactly once and a future provider inserted
 * ahead of Google can never be silently dropped (a positional slice would).
 * The function-form config below reuses these and decides whether to append a
 * freshly-credentialled Google provider per request.
 */
const GOOGLE_PROVIDER_ID = "google";
const baseProviders = authConfig.providers.filter(
  (provider) => (provider as { id?: string }).id !== GOOGLE_PROVIDER_ID,
);

/**
 * Request-scoped NextAuth config (#2087). The provider list is computed PER
 * REQUEST from the DB credential state: Google is appended only when its
 * credentials resolve, and OMITTED otherwise — no ghost "Continue with Google"
 * button, no direct-URL provider error (observable at `/api/auth/providers`).
 *
 * FAIL-OPEN (epic decision 7): because this single config is shared by EVERY
 * sign-in method, resolution must never throw. `getGoogleOAuthConfig` already
 * fails open to `null`; the extra try/catch here is defence in depth so a DB or
 * decrypt failure can only ever DROP Google, never break credentials/magic-link/
 * 2FA sign-in. Exported for tests (the fail-open acceptance test asserts the
 * base providers survive while the resolver throws).
 */
export async function buildRequestAuthConfig(): Promise<NextAuthConfig> {
  let google: Awaited<ReturnType<typeof getGoogleOAuthConfig>> = null;
  try {
    google = await getGoogleOAuthConfig();
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.name : "unknown" },
      "Google OAuth resolver threw — omitting the Google provider (fail-open)",
    );
    google = null;
  }
  return {
    ...authConfig,
    providers: google
      ? [...baseProviders, buildGoogleProvider(google)]
      : baseProviders,
  };
}

// v5 request-scoped function form: the config (hence the provider list) is
// recomputed per request from live DB credential state. next-auth@5.0.0-beta.31
// supports `NextAuth((request) => Awaitable<NextAuthConfig>)`; the request arg is
// unused (the only per-request input is the DB credential state).
const nextAuth = NextAuth(buildRequestAuthConfig);

export const { handlers, signIn, signOut, unstable_update: updateSession } =
  nextAuth;

export async function auth() {
  const session = await nextAuth.auth();

  if (session?.user?.sessionInvalidated) {
    return null;
  }

  return session;
}

/**
 * Diagnostics-only raw session probe (#1669). Returns the UNWRAPPED
 * next-auth session, bypassing the sessionInvalidated null-gate that the
 * public auth() above applies. NEVER use this for authorization decisions —
 * its sole caller is the auth-bounce classifier, which needs to tell "no
 * decodable session at all" apart from "session revoked by a password
 * change" after auth() has already returned null.
 */
export async function getSessionForAuthDiagnostics() {
  return nextAuth.auth();
}
