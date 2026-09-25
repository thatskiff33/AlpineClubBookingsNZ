import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getExplicitCallbackUrl,
  isValidAuthBounceRef,
  resolvePostLoginPath,
} from "@/lib/auth-redirect";
import { readFamilyInviteReturnCookieValue } from "@/lib/family-invite-return-address-cookie";
import {
  appendFamilyInviteReturnParam,
  getFamilyInviteReturnNonce,
} from "@/lib/family-invite-return-address";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { googleCredentialsConfigured } from "@/lib/google-oauth";
import { getCachedEffectiveModuleFlags } from "@/lib/public-layout-config";
import { LoginForm } from "./login-form";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

// Server component: resolve the login query params here so the client form
// never needs useSearchParams(). Reading them client-side forced the form into
// a Suspense boundary whose hard-load hydration is the suspected cause of the
// #email double-render E2E flake (#1207/#1140).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    verified?: string | string[];
    verifyError?: string | string[];
    emailChanged?: string | string[];
    callbackUrl?: string | string[];
    ref?: string | string[];
    error?: string | string[];
    inviteReturn?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const verified = singleSearchParam(params.verified) === "true";
  const emailChanged = singleSearchParam(params.emailChanged) === "true";
  const verifyError = singleSearchParam(params.verifyError);
  const oauthError = singleSearchParam(params.error);
  const rawCallbackUrl = singleSearchParam(params.callbackUrl);
  const redirectTo = resolvePostLoginPath(rawCallbackUrl);
  // A genuinely user/deep-link-supplied callbackUrl (null when absent/unsafe).
  // It always wins over the landing preference (D-D4); when absent the client
  // and the authenticated self-heal below fall back to the preference / role
  // default. Never treat a flow-materialised default as explicit.
  const explicitCallbackUrl = getExplicitCallbackUrl(rawCallbackUrl) ?? undefined;
  const refCandidate = singleSearchParam(params.ref);
  const authBounceRef = isValidAuthBounceRef(refCandidate) ? refCandidate : undefined;
  // #2974: the tab-binding nonce the family-invite page put on its sign-in
  // anchor. Tokenless and worthless on its own — it only tells the landing
  // resolver that THIS tab is the one that opened the invitation. Shape-checked
  // here so nothing malformed is forwarded into a detour URL or a client prop;
  // an absent or bad value simply means the invite address is not honoured.
  const familyInviteReturnNonce =
    getFamilyInviteReturnNonce(params.inviteReturn) ?? undefined;

  // An already-authenticated visitor must never be shown the sign-in form —
  // a bounced tab would otherwise strand on /login with no error and no way
  // to self-heal. Mirror login/verify's session-aware gates so the redirect
  // still honours a forced password change and the two-factor funnel.
  const session = await auth();
  if (session?.user) {
    if (session.user.forcePasswordChange) {
      redirect("/change-password");
    }
    // When a 2FA challenge is still open, hand off to the verify/enroll detour.
    // Determinism (#2090): the detour's callbackUrl carries ONLY a genuinely
    // explicit deep link — never the resolved default landing. The default is
    // re-resolved at /login/verify and /login/enroll from the fully-authed
    // session, so every entry into the detour resolves the default the SAME way
    // and a flow-materialised default is never re-read as explicit (D-D4).
    if (session.user.twoFactorRequired && !session.user.twoFactorVerified) {
      const query = new URLSearchParams();
      if (explicitCallbackUrl) {
        query.set("callbackUrl", explicitCallbackUrl);
      }
      // #2974: the detour hop carries the tab-binding nonce so the verify/enroll
      // page can still honour the family-invite address. Only the nonce travels —
      // never the invite path, which is what would put the token back in a URL.
      appendFamilyInviteReturnParam(query, familyInviteReturnNonce);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      redirect(
        session.user.twoFactorEnrolled && session.user.twoFactorMethod
          ? `/login/verify${suffix}`
          : `/login/enroll${suffix}`,
      );
    }
    // No detour: resolve the landing from the live session so an admin's
    // preference / role default is honoured on this self-heal path (and,
    // notably, this is where a Google sign-in with no explicit deep link lands
    // to be resolved).
    // #2827: honour the family-invite return address here too. This branch is
    // where a Google sign-in from an invite comes back (the provider callbackUrl
    // is "/login?inviteReturn=<nonce>" whenever there is no explicit deep link),
    // so without this read the one flow that has no client post-auth seam would
    // land on the dashboard. Deliberately NOT folded into `explicitCallbackUrl`
    // above: that value is forwarded to the client form and into the 2FA detour's
    // query string, and the whole point of this fix is that the invite token stops
    // appearing in the login page's own output. It is read only on this
    // redirect-only path.
    // #2974: the raw cookie value goes in with the nonce this request presented,
    // and the resolver honours the address only if they agree — so a member who
    // simply navigated to /login gets their ordinary landing even when somebody
    // else's invitation cookie is still alive in this browser.
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
    redirect(landing);
  }

  // Only needed on the form-render path (an authenticated visitor redirects
  // above). Mirrors the public layout's cached read of effective module flags.
  const modules = await getCachedEffectiveModuleFlags();
  // DB-only Google credential resolution (#2087). Fail-open: resolves to false
  // (no button) rather than throwing if the store is unavailable.
  const googleConfigured = modules.googleLogin
    ? await googleCredentialsConfigured()
    : false;

  return (
    <LoginForm
      verified={verified}
      verifyError={verifyError}
      emailChanged={emailChanged}
      redirectTo={redirectTo}
      explicitCallbackUrl={explicitCallbackUrl}
      familyInviteReturnNonce={familyInviteReturnNonce}
      authBounceRef={authBounceRef}
      magicLinkEnabled={modules.magicLink}
      googleLoginEnabled={modules.googleLogin && googleConfigured}
      oauthError={oauthError}
    />
  );
}
