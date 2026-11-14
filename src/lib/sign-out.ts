import { signOutMember } from "@/lib/member-sign-out";

/**
 * The standard Log out: end the session and land on the sign-in page. The nav
 * bar and the onboarding gate both call this so they cannot drift to different
 * redirects. The family-invite control signs out to a different destination on
 * purpose (it returns the member to the invite), so it calls `signOutMember`
 * itself. Both go through `signOutMember`, the one client-side sign-out, so the
 * work this tab keeps for the member is forgotten at the same moment (#4950).
 */
export function signOutToLogin() {
  return signOutMember({ callbackUrl: "/login" });
}
