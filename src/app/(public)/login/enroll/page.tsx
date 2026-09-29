import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildLoginPath, getExplicitCallbackUrl } from "@/lib/auth-redirect";
import { readFamilyInviteReturnCookieValue } from "@/lib/family-invite-return-address-cookie";
import {
  appendFamilyInviteReturnParam,
  getFamilyInviteReturnNonce,
} from "@/lib/family-invite-return-address";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { TwoFactorEnrollPanel } from "../two-factor-panels";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TwoFactorEnrollPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string | string[];
    inviteReturn?: string | string[];
  }>;
}) {
  const params = await searchParams;
  // A genuinely explicit deep link only (null when absent/unsafe/self-referential).
  // The detour never carries a flow-materialised default, so this is the sole
  // "user asked for a specific page" signal here (D-D4).
  const explicitCallbackUrl =
    getExplicitCallbackUrl(singleSearchParam(params.callbackUrl)) ?? undefined;
  // #2974: the tab-binding nonce the family-invite page minted, carried across
  // the detour hop that brought us here. Tokenless, and shape-checked before it
  // is forwarded anywhere; a missing or malformed value simply means the invite
  // address is not honoured and the member lands where they normally would.
  const familyInviteReturnNonce =
    getFamilyInviteReturnNonce(params.inviteReturn) ?? undefined;
  const session = await auth();

  if (!session?.user) {
    redirect(buildLoginPath(explicitCallbackUrl));
  }

  if (session.user.forcePasswordChange) {
    redirect("/change-password");
  }

  // Resolve the default landing here (#2090), from the live session's preference
  // + admin matrix (both refreshed by the auth jwt callback and unchanged by the
  // 2FA step), so post-enrollment navigation is deterministic — computed
  // server-side from the authoritative session, never a raced post-signIn fetch.
  // An explicit deep link still wins (D-D4). This is the single authoritative
  // resolution site for a member reaching enrollment via any entry point.
  // #2827: same as /login/verify — the family-invite return address is read from
  // the HttpOnly cookie so a member enrolling in 2FA on the way in still lands back
  // on the invite, without the invite token appearing in this page's query string.
  // #2974: and only when this request presents the invite tab's own nonce.
  const landing = resolvePostLoginLandingPath({
    explicitCallbackUrl,
    familyInviteReturn: {
      cookieValue: await readFamilyInviteReturnCookieValue(),
      presentedNonce: familyInviteReturnNonce,
    },
    landingPreference: session.user.postLoginLanding,
    permissionInput: {
      adminPermissionMatrix: session.user.adminPermissionMatrix,
      canLogin: session.user.canLogin,
    },
  });

  if (!session.user.twoFactorRequired || session.user.twoFactorVerified) {
    redirect(landing);
  }

  if (session.user.twoFactorEnrolled) {
    // Carry only the explicit deep link across to /login/verify; that page
    // re-resolves the default the same way, so the detour hop never bakes one in.
    // The #2974 tab-binding nonce rides along too, so the second hop can still
    // honour the family-invite address — it is the nonce, never the invite path.
    const query = new URLSearchParams();
    if (explicitCallbackUrl) {
      query.set("callbackUrl", explicitCallbackUrl);
    }
    appendFamilyInviteReturnParam(query, familyInviteReturnNonce);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    redirect(`/login/verify${suffix}`);
  }

  return <TwoFactorEnrollPanel callbackUrl={landing} />;
}
