/**
 * THE ADMIN SECURITY PREAMBLE, IN ONE PLACE (AID-7, #2378).
 *
 * Every admin-side layout must clear the same gauntlet before it renders anything:
 * a real session, a member row read FRESH from the database rather than trusted from
 * the JWT, an active account, no forced password change outstanding, no two-factor
 * gate outstanding, and area permission for the route actually being requested. Only
 * then may chrome appear.
 *
 * WHY THIS IS A MODULE AND NOT A COPIED BLOCK. It was extracted when #2378 was going
 * to add a second admin-side layout (owner decision Q4: a Diagnostics workspace
 * without the admin sidebar), where a second copy of this sequence would be a second
 * place for it to drift. THE OWNER SUPERSEDED Q4 ON 12 AUG 2026 — Diagnostics is
 * asked from the Help bubble and its page lives under `/admin/*` — so `(admin)` is
 * once again the only group layout, and the extraction survives for the opposite
 * reason: the diagnostics page re-runs this ONE guard itself instead of trusting its
 * parent layout, which only a module makes possible. The drift risk it was built
 * against is unchanged: an `active` check that stops being re-read, or a two-factor
 * gate a new layout forgets, does not break a page. It quietly admits somebody.
 *
 * SO THE ORDER IS PART OF THE CONTRACT, not an implementation detail:
 *
 *   1. session — no session bounces to login, with a durable reference code
 *   2. member  — re-read from the database, because the JWT can be stale
 *   3. active  — a deactivated account is bounced even with a valid session
 *   4. password — a forced change is completed before anything else is reachable
 *   5. 2FA     — the gate is cleared before any admin surface renders
 *   6. area    — permission for the REQUESTED path, not for "admin" in general
 *
 * Nothing here may be reordered by a caller, and nothing may be skipped, which is why
 * this returns an opaque result rather than a set of pieces to assemble. A caller
 * gets an admitted member or a redirect; there is no third shape and no way to ask
 * for "just the session part".
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It performs no `redirect()` itself. `redirect`
 * throws, and a helper that throws control flow makes the calling layout's behaviour
 * depend on where in its body the call sits — including whether a `try/catch` added
 * later swallows it. The caller redirects, in one line, at the top; the destination
 * is computed here so the decision stays with the rule rather than with the caller.
 *
 * IT IS NOT THE CSP BOUNDARY EITHER, and #2378 is explicit that a route group must
 * not be mistaken for one. The nonce is read here for convenience because every
 * caller needs it; the actual response boundary is middleware's.
 */

import { headers } from "next/headers";

import { isFullAdmin } from "@/lib/access-roles";
import {
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  getFirstAccessibleAdminHref,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  hasFinanceViewerAccess,
  isConsolidatedFeesPath,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { recordAuthBounce } from "@/lib/auth-diagnostics";
import { buildLoginPath } from "@/lib/auth-redirect";
import { auth } from "@/lib/auth";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";
import {
  MEMBER_ONBOARDING_GATE_SELECT,
  shouldShowMemberOnboarding,
} from "@/lib/member-onboarding";
import { prisma } from "@/lib/prisma";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

/** The member shape this guard reads. Exactly the onboarding gate's select. */
type GuardedMember = NonNullable<
  Awaited<ReturnType<typeof readMemberForGuard>>
>;

async function readMemberForGuard(memberId: string) {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: MEMBER_ONBOARDING_GATE_SELECT,
  });
}

/** What an admitted caller gets. Assembled once, so no layout re-derives it. */
export interface AdmittedAdmin {
  outcome: "admitted";
  member: GuardedMember;
  /** The nav-bar user shape both admin layouts render. */
  user: {
    name: string;
    email: string;
    role: GuardedMember["role"];
    canAccessAdmin: boolean;
    canAccessFinance: boolean;
    isHutLeader: boolean;
    isStayingGuest: boolean;
  };
  /**
   * Precomputed server-side: the sidebar and command palette are client
   * components and cannot resolve database-backed role definitions themselves.
   */
  permissionMatrix: AdminPermissionMatrix;
  isFullAdmin: boolean;
  /** CSP nonce for this response, or undefined when middleware set none. */
  nonce: string | undefined;
  /** Whether the onboarding wizard should open for this member. */
  showOnboardingWizard: boolean;
  /** The path the guard admitted, for a caller that needs to echo it. */
  requestedPath: string;
}

/** What a refused caller gets: exactly where to send them, and nothing else. */
export interface RefusedAdmin {
  outcome: "redirect";
  destination: string;
}

export type AdminLayoutGuardResult = AdmittedAdmin | RefusedAdmin;

/**
 * Run the admin security preamble for the path currently being requested.
 *
 * The caller's whole obligation is two lines:
 *
 *   const guard = await guardAdminLayout();
 *   if (guard.outcome === "redirect") redirect(guard.destination);
 *
 * `fallbackPath` exists for the one caller that needs it: the request path header
 * is set by middleware, and a layout rendered outside that path (a not-found, a
 * direct render in a test) would otherwise be admitted against `undefined`. It
 * defaults to the admin dashboard, which is the most RESTRICTIVE sensible choice —
 * it requires overview access rather than admitting anyone.
 */
export async function guardAdminLayout(
  fallbackPath = "/admin/dashboard",
): Promise<AdminLayoutGuardResult> {
  const session = await auth();
  const requestHeaders = await headers();
  const requestedPath = requestHeaders.get(REQUEST_PATH_HEADER);

  // 1. SESSION.
  if (!session?.user) {
    // `recordAuthBounce` (#1669) classifies WHY auth() nulled and returns a
    // reference code for durable bounces; it never throws, and the extra `.catch`
    // guarantees the redirect even if that contract ever regresses. Anonymous
    // visits keep the historical bare /login target.
    const authBounceRef = await recordAuthBounce({
      layout: "admin",
      requestedPath,
    }).catch(() => null);
    return {
      outcome: "redirect",
      destination: authBounceRef
        ? buildLoginPath(null, authBounceRef)
        : "/login",
    };
  }

  // 2. MEMBER, read fresh. The JWT can be stale about everything below.
  const member = await readMemberForGuard(session.user.id);

  // 3. ACTIVE.
  if (!member || !member.active) {
    return { outcome: "redirect", destination: "/login" };
  }

  // 4. FORCED PASSWORD CHANGE.
  if (member.forcePasswordChange) {
    return { outcome: "redirect", destination: "/change-password" };
  }

  // 5. TWO-FACTOR GATE.
  if (isTwoFactorSessionBlocked({ sessionUser: session.user, member })) {
    return {
      outcome: "redirect",
      destination: buildTwoFactorGatePath({
        sessionUser: session.user,
        member,
        callbackPath: requestedPath,
      }),
    };
  }

  // 6. AREA PERMISSION FOR THE REQUESTED PATH.
  const requestedForGuard = requestedPath ?? fallbackPath;
  const adminRequirement = getAdminRouteRequirement(requestedForGuard, "GET") ?? {
    area: "overview" as const,
    level: "view" as const,
  };

  // /admin/fees admits on view of EITHER bookings or finance (#1933, E7); its
  // prefix resolves to bookings for the single-area drift guard, so the generic
  // check would wrongly lock out a finance-only editor. Short-circuit here.
  const admitted = isConsolidatedFeesPath(requestedForGuard)
    ? hasAdminAreaAccess(member, { area: "bookings", level: "view" }) ||
      hasAdminAreaAccess(member, { area: "finance", level: "view" })
    : hasAdminAreaAccess(member, adminRequirement);

  if (!admitted) {
    return {
      outcome: "redirect",
      destination: getFirstAccessibleAdminHref(member) ?? "/dashboard",
    };
  }

  return {
    outcome: "admitted",
    member,
    user: {
      name: session.user.name ?? "Admin",
      email: session.user.email ?? "",
      role: member.role,
      canAccessAdmin: hasAdminPortalAccess(member),
      canAccessFinance: hasFinanceViewerAccess(member),
      isHutLeader: false,
      isStayingGuest: false,
    },
    permissionMatrix: getAdminPermissionMatrix(member),
    isFullAdmin: isFullAdmin(member),
    nonce: requestHeaders.get(CSP_NONCE_HEADER) ?? undefined,
    showOnboardingWizard: shouldShowMemberOnboarding(member),
    requestedPath: requestedForGuard,
  };
}
