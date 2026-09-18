import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { PostLoginLanding } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  dedupeAccessRoles,
  hasAdminAccess,
  type AppAccessRole,
} from "@/lib/access-roles";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { getRequiredFeaturesForPath } from "@/config/feature-routes";
import {
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
} from "@/lib/internal-return-path";
import { prisma } from "@/lib/prisma";
import {
  isTwoFactorSessionBlocked,
  type TwoFactorSessionUser,
} from "@/lib/two-factor-gate";

type SessionUser = {
  id: string;
  role: string;
  accessRoles: AppAccessRole[];
  adminPermissionMatrix?: AdminPermissionMatrix;
  email?: string | null;
  twoFactorRequired?: boolean;
  twoFactorVerified?: boolean;
  twoFactorEnrolled?: boolean;
  twoFactorMethod?: "TOTP" | "EMAIL" | null;
  postLoginLanding?: PostLoginLanding | null;
};

type RequireAdminResult =
  | { ok: true; session: { user: SessionUser } }
  | { ok: false; response: NextResponse };

type RequireActiveSessionResult =
  | { ok: true; session: { user: SessionUser } }
  | { ok: false; response: NextResponse };

/**
 * `permission` has three shapes, and the difference between them is the whole
 * authorisation decision, so it is spelled out here rather than inferred:
 *
 * - an `AdminAccessRequirement` - admit a caller holding that area at that level;
 * - `false` - admit ONLY a full administrator (`hasAdminAccess`), not merely
 *   somebody admitted to the portal;
 * - `"any-admin"` - admit any caller admitted to the admin portal at all
 *   (`hasAdminPortalAccess`), whatever their grid says. Added for #2925.
 *
 * Omitting it infers the requirement from the request path, which is right for
 * the great majority of routes and is why it is the default.
 *
 * `"any-admin"` IS A DELIBERATE WIDENING and must not be reached for casually.
 * It exists for a read whose payload is safe for every admin, and the route
 * using it is expected to narrow what it returns by permission itself. Adding it
 * to a route that returns privileged detail hands that detail to every admin.
 * Its one current caller, `GET /api/admin/lodges`, returns only id, name, slug
 * and active to a caller without `lodge:view`.
 */
type RequireAdminOptions = {
  unauthenticatedResponse?: () => NextResponse;
  forbiddenResponse?: () => NextResponse;
  permission?: AdminAccessRequirement | false | "any-admin";
};

type RequireActiveSessionOptions = RequireActiveSessionUserOptions & {
  unauthenticatedResponse?: () => NextResponse;
};

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function unauthorisedResponse() {
  return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
}

/**
 * The reply an anonymous caller gets from a MODULE-GATED route — byte-identical
 * to what `getFeatureFlagBlockResponse()` in `src/proxy.ts` sends when the
 * module is switched off (#2404 re-review, owner decision 1 Aug 2026).
 *
 * Without this, one anonymous request read a club's configuration off any gated
 * `/api` address: `401` meant "the module is on and something asked me to sign
 * in", `404` meant "the module is off". Answering both with the same frozen
 * 404 removes that difference on the ~121 gated routes that authenticate
 * through the two guards below.
 *
 * Deliberately narrow. It applies ONLY when there is no session at all, so a
 * signed-in caller still gets the honest `403` for a permission or account
 * problem and nothing about ordinary admin work changes. Ungated routes keep
 * their `401` exactly, because a 404 there would be a lie with no secret behind
 * it. And a route that passes its own `unauthenticatedResponse` keeps that: a
 * login redirect or a deliberate 403 is a contract someone chose.
 */
function moduleGatedNotFoundResponse() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/**
 * Whether the path this request is being served under is module-gated.
 *
 * Reads the same `REQUEST_PATH_HEADER` the admin permission lookup already
 * trusts. It is trustworthy here for a reason worth stating rather than
 * assuming: `src/proxy.ts` OVERWRITES that header on every request it runs on,
 * and it necessarily runs on every gated path (a gated path the matcher misses
 * has a dead gate, which `csp-proxy.test.ts` fails on). So on a gated path the
 * value is the framework's, not the caller's. On an UNGATED path the proxy may
 * not run and a caller can supply any value it likes — but the only thing that
 * buys is turning its own `401` into a `404`, which tells the caller nothing it
 * did not already know. The lie can only go the harmless way.
 *
 * Fails OPEN (returns false, so the ordinary 401 is used) when the header is
 * absent or `headers()` throws, because a wrong 404 on an ungated route would
 * hide a real sign-in problem from a real member.
 */
async function isModuleGatedRequestPath(): Promise<boolean> {
  try {
    const requestHeaders = await headers();
    const value = requestHeaders.get(REQUEST_PATH_HEADER);
    if (!value) return false;

    // The header carries `${pathname}${search}`; the route rules match on the
    // pathname alone.
    // `split` always yields a first element, even for the empty string; an
    // absent one is an empty path, which matches no gated route (#2800).
    const pathname = value.split("?")[0] ?? "";
    return getRequiredFeaturesForPath(pathname).length > 0;
  } catch {
    return false;
  }
}

/** The anonymous-caller reply for a route, module-gated or not. */
async function unauthenticatedResponseFor(
  fallback: () => NextResponse,
  override?: () => NextResponse,
): Promise<NextResponse> {
  if (override) return override();
  return (await isModuleGatedRequestPath())
    ? moduleGatedNotFoundResponse()
    : fallback();
}

function forbiddenResponse() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function twoFactorRequiredResponse() {
  return NextResponse.json(
    { error: "Two-factor verification required" },
    { status: 403 },
  );
}

async function inferAdminAccessRequirement(
  options: RequireAdminOptions,
): Promise<AdminAccessRequirement | null> {
  if (options.permission === false) return null;
  // #2925: "any-admin" is decided at the call below, NOT by inferring a
  // requirement from the path. Returning null here is what stops it falling
  // through to `getAdminRouteRequirement`, which maps this route to
  // `area: "lodge"` and was exactly how PR #2885's bare `requireAdmin()`
  // reinstated the 403 it existed to remove.
  if (options.permission === "any-admin") return null;
  if (options.permission) return options.permission;

  try {
    const requestHeaders = await headers();
    const pathname = requestHeaders.get(REQUEST_PATH_HEADER);
    if (!pathname) return null;
    return getAdminRouteRequirement(
      pathname,
      requestHeaders.get(REQUEST_METHOD_HEADER),
    );
  } catch {
    return null;
  }
}

/**
 * Shared admin auth helper. Returns the session on success; otherwise
 * a NextResponse with the correct 401 vs 403 split and the active
 * session check applied — except on a module-gated path, where an anonymous
 * caller gets the module gate's own frozen 404 instead of the 401 (see
 * `moduleGatedNotFoundResponse`). Use at the top of admin route handlers:
 *
 *   const guard = await requireAdmin();
 *   if (!guard.ok) return guard.response;
 *   const session = guard.session;
 */
export async function requireAdmin(
  options: RequireAdminOptions = {}
): Promise<RequireAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: await unauthenticatedResponseFor(
        unauthorizedResponse,
        options.unauthenticatedResponse,
      ),
    };
  }

  const [member, requirement] = await Promise.all([
    prisma.member.findUnique({
      where: { id: session.user.id },
      select: {
        active: true,
        forcePasswordChange: true,
        twoFactorEnabled: true,
        // Joined definitions so area checks resolve definition-backed
        // (custom or edited) access roles.
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    }),
    inferAdminAccessRequirement(options),
  ]);

  if (!member?.active) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 }
      ),
    };
  }

  const hasRequiredAccess = requirement
    ? hasAdminAreaAccess(member, requirement)
    : options.permission === "any-admin"
      ? hasAdminPortalAccess(member)
      : hasAdminAccess(member);

  if (!hasRequiredAccess) {
    return {
      ok: false,
      response: options.forbiddenResponse?.() ?? forbiddenResponse(),
    };
  }

  if (member.forcePasswordChange) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Password change required" },
        { status: 403 }
      ),
    };
  }

  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    return { ok: false, response: twoFactorRequiredResponse() };
  }

  return {
    ok: true,
    session: {
      user: {
        ...(session.user as SessionUser),
        // DB-verified roles so downstream separation-of-duties checks
        // (issue #1012) never trust a stale JWT claim.
        accessRoles: dedupeAccessRoles(
          member.accessRoles.map(({ role }) => role),
        ),
        // DB-verified matrix for the same reason (#1367): downstream area
        // checks on this user resolve from the rows this guard just read
        // (definitions joined), not the JWT-carried snapshot.
        adminPermissionMatrix: getAdminPermissionMatrix(member),
      },
    },
  };
}

type RequireActiveSessionUserOptions = {
  allowForcePasswordChange?: boolean;
  sessionUser?: TwoFactorSessionUser | null;
};

/**
 * Shared active-session API helper for member-facing routes. A missing session
 * is 401 "Unauthorised" — or, on a module-gated path, the same frozen 404 the
 * module gate itself sends, so an anonymous caller cannot read the module state
 * off the auth failure (see `moduleGatedNotFoundResponse`). Active and
 * force-password-change checks are delegated to requireActiveSessionUser.
 */
export async function requireActiveSession(
  options: RequireActiveSessionOptions = {}
): Promise<RequireActiveSessionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: await unauthenticatedResponseFor(
        unauthorisedResponse,
        options.unauthenticatedResponse,
      ),
    };
  }

  const inactive = await requireActiveSessionUser(session.user.id, {
    allowForcePasswordChange: options.allowForcePasswordChange,
    sessionUser: session.user,
  });
  if (inactive) {
    return { ok: false, response: inactive };
  }

  return { ok: true, session: { user: session.user as SessionUser } };
}

export async function requireActiveSessionUser(
  userId: string,
  options: RequireActiveSessionUserOptions = {}
) {
  const member = await prisma.member.findUnique({
    where: { id: userId },
    select: {
      active: true,
      forcePasswordChange: true,
      twoFactorEnabled: true,
    },
  });

  if (!member?.active) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }

  if (member.forcePasswordChange && !options.allowForcePasswordChange) {
    return NextResponse.json(
      { error: "Password change required" },
      { status: 403 }
    );
  }

  const sessionUser = options.sessionUser ?? (await auth())?.user;
  if (
    sessionUser?.id === userId &&
    isTwoFactorSessionBlocked({
      sessionUser,
      member,
      allowForcePasswordChange: options.allowForcePasswordChange,
    })
  ) {
    return twoFactorRequiredResponse();
  }

  return null;
}
