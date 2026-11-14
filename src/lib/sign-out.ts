import { signOut } from "next-auth/react";

/**
 * The standard Log out: end the session and land on the sign-in page. The nav
 * bar and the onboarding gate both call this so they cannot drift to different
 * redirects. The family-invite control signs out to a different destination on
 * purpose (it returns the member to the invite), so it calls `signOut` itself.
 */
export function signOutToLogin() {
  return signOut({ callbackUrl: "/login" });
}
