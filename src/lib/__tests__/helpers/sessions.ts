/**
 * Typed test helpers for next-auth Session values.
 *
 * Use these instead of `as any` casts on auth() mock returns so that test
 * code keeps full type feedback when the Session interface changes.
 */
import type { Session } from "next-auth";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";

type SessionUser = Session["user"];

const DEFAULT_USER: SessionUser = {
  id: "test-user",
  email: "test-user@example.org",
  name: "Test User",
  role: "USER",
  accessRoles: ["USER"],
  // #3603: a live session belongs to a member who may sign in; the jwt
  // callback invalidates any session whose member has canLogin false.
  canLogin: true,
  // #1367: sessions always carry the merged admin-permission matrix; the
  // all-none default matches a plain member. Tests modelling scoped/custom
  // admins should override this rather than accessRoles.
  adminPermissionMatrix: emptyAdminPermissionMatrix(),
  // #2090: sessions carry the member's post-login landing preference; null =
  // follow the role default. Tests exercising the landing resolver override it.
  postLoginLanding: null,
  forcePasswordChange: false,
  isEmailVerified: true,
  twoFactorRequired: false,
  twoFactorVerified: false,
  twoFactorEnrolled: false,
  twoFactorMethod: null,
};

export function makeSession(user: Partial<SessionUser> = {}): Session {
  const merged = { ...DEFAULT_USER, ...user };
  // Mirror production (#1367): unless a test pins its own matrix, derive it
  // from the fixture's roles exactly as the jwt callback derives it from the
  // member's assignment rows — so adminSession() et al keep granting.
  if (user.adminPermissionMatrix === undefined) {
    merged.adminPermissionMatrix = getAdminPermissionMatrix({
      accessRoles: merged.accessRoles,
      canLogin: merged.canLogin,
    });
  }
  return {
    user: merged,
    expires: "2099-01-01T00:00:00.000Z",
  };
}

export function adminSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "admin-1",
    email: "admin@example.org",
    name: "Admin One",
    role: "ADMIN",
    accessRoles: ["ADMIN"],
    ...overrides,
  });
}

export function memberSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "member-1",
    email: "member@example.org",
    name: "Member One",
    role: "USER",
    accessRoles: ["USER"],
    ...overrides,
  });
}

export function lodgeSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "lodge-1",
    email: "lodge@example.org",
    name: "Lodge Account",
    role: "LODGE",
    accessRoles: ["LODGE"],
    ...overrides,
  });
}
