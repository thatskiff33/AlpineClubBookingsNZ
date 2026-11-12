import { signOut } from "next-auth/react";

/**
 * The app's one member-facing Log out action: end the session and land on the
 * sign-in page. Every Log out control (the nav bar, the onboarding gate) calls
 * this so they cannot drift to different redirects.
 */
export function signOutToLogin() {
  return signOut({ callbackUrl: "/login" });
}
