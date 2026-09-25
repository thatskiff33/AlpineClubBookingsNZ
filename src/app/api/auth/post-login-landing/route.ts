import { NextRequest, NextResponse } from "next/server";
import { readFamilyInviteReturnCookieValue } from "@/lib/family-invite-return-address-cookie";
import {
  FAMILY_INVITE_RETURN_PARAM,
  serialiseFamilyInviteReturnCookie,
} from "@/lib/family-invite-return-address";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { requireActiveSession } from "@/lib/session-guards";

// Post-auth landing resolver (#2090). The credential and magic-link login
// clients call this after a successful sign-in — once the session cookie
// exists — to learn where to navigate, honouring the member's landing
// preference and admin role default. Precedence and open-redirect safety live
// entirely in resolvePostLoginLandingPath; this route only supplies the
// session-derived preference + permission matrix (both refreshed per request by
// the auth jwt callback) and the caller's explicit callbackUrl, if any.
// A guard failure (deactivated member, forced password change) is harmless
// here: the login client falls back to its sanitized redirect and the
// change-password/self-heal flows take over.
export async function GET(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  const { user } = guard.session;

  const explicitCallbackUrl = req.nextUrl.searchParams.get("callbackUrl");
  // #2827: the family-invite return address, carried in an HttpOnly cookie so the
  // invite token never has to be rendered into the sign-in link's href. This route
  // is the TERMINAL consumer for the credential and magic-link flows — the client
  // navigates to whatever it answers — and it is the only one of the four
  // resolution sites that can clear the cookie, `cookies()` being writable in a
  // route handler and not in a server component. Which is why it is NOT where the
  // address is retired on use: the redirect it hands back lands on the invite page,
  // whose own GET used to restore the value this route had just cleared, and the
  // Google and 2FA flows never call this route at all. The proxy retires it on the
  // signed-in GET of the invite page instead (`syncFamilyInviteReturnAddress()`),
  // which covers all four flows. The clear below is still needed for the one case
  // that never lands on the page — see the comment on it.
  // #2974: the raw cookie value is paired with the tab-binding nonce the caller
  // presented, and `resolvePostLoginLandingPath` honours the address only if the
  // two agree. The login form forwards the nonce it was rendered with, so the
  // password flow still returns to the invitation; a magic-link sign-in, whose
  // navigation came from an email in some other tab, presents none and lands on
  // the member's ordinary home.
  const familyInviteReturnCookie = await readFamilyInviteReturnCookieValue();
  const path = resolvePostLoginLandingPath({
    explicitCallbackUrl,
    familyInviteReturn: {
      cookieValue: familyInviteReturnCookie,
      presentedNonce: req.nextUrl.searchParams.get(FAMILY_INVITE_RETURN_PARAM),
    },
    landingPreference: user.postLoginLanding,
    permissionInput: {
      adminPermissionMatrix: user.adminPermissionMatrix,
      canLogin: user.canLogin,
    },
  });

  const response = NextResponse.json({ path });

  // Cleared whenever an address was present, not only when it won — and this is
  // the case the proxy's retire cannot reach: an explicit callbackUrl outranks the
  // address, so the member never lands on the invite page, and leaving the cookie
  // behind would then steer their NEXT sign-in somewhere they did not ask for.
  // Deliberately keyed on the cookie EXISTING rather than on it matching this
  // tab's nonce (#2974): a successful sign-in that did not consume the address
  // should still tidy it away, and clearing something this request was not
  // entitled to use is the fail-safe direction. Expiry is a past-dated overwrite
  // with the same attributes, never a bare delete.
  if (familyInviteReturnCookie) {
    response.headers.append(
      "Set-Cookie",
      serialiseFamilyInviteReturnCookie("", 0),
    );
  }

  return response;
}
