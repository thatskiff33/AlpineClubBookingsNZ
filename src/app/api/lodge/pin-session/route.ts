import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import {
  clearLodgePinSessionCookie,
  renewLodgePinSessionForRequest,
  setLodgePinSessionCookie,
} from "@/lib/lodge-pin-session";
import {
  applyMemberScopedRateLimit,
  applyRateLimit,
  rateLimiters,
} from "@/lib/rate-limit";

/**
 * The lifetime of a hut leader's kiosk PIN session (#3228).
 *
 * ## What this route is for
 *
 * A lodge wall tablet is signed in as the lodge's own kiosk account and is an
 * ordinary viewer. A hut leader types their PIN on that same shared screen to
 * mark attendance or edit the roster — the intended workflow — and for as long
 * as that PIN session is live the screen shows a hut leader's view to whoever
 * is standing in front of it. It used to show it for TWELVE HOURS, because the
 * cookie was minted with a twelve-hour deadline and nothing in the tree could
 * end it early.
 *
 * It now ends after ten minutes with nobody touching the screen, and there is a
 * **Lock** control that ends it at once. This route is those two operations:
 *
 * - `POST` slides the idle window forward. The kiosk calls it when a person
 *   taps, types, or scrolls with a wheel — never on a data refresh.
 * - `DELETE` is **Lock**: it ends the session immediately.
 *
 * ## Why the server is the one deciding
 *
 * The deadline lives inside the HMAC-signed cookie payload as `exp`, so the
 * browser cannot edit it, and `getActiveLodgePinSessionForDate` refuses an
 * expired payload before it looks anything up. A client that stops sending
 * renewals — or is switched off, or loses its network — simply lapses to the
 * `lodge` tier on the next request. Renewal is not a claim the client makes
 * about elapsed time; it is a request for a NEW cookie that the server mints,
 * from the server's own clock, only for a session that is still valid.
 *
 * ## What that does and does not prevent
 *
 * It closes the case this issue is about: an unattended tablet. Nobody touches
 * it, nothing renews, the window closes. The kiosk's own two-minute data
 * refresh cannot hold it open, because the polled routes have no code path that
 * writes this cookie — renewal exists in exactly one place, here.
 *
 * It does NOT prevent somebody who is physically at the tablet from keeping the
 * session open: they can tap the screen every few minutes, and from the
 * browser's console they can call this endpoint on a timer. No signal a browser
 * can send is beyond the reach of somebody holding the device, so that is a
 * limit of the mechanism rather than a gap in it — the control against a person
 * standing at an unlocked kiosk is the **Lock** button and the ten-minute
 * window, not authentication of their taps.
 *
 * ## Cross-site
 *
 * `POST` needs the very cookie it renews, and that cookie is `SameSite=Lax`, so
 * a cross-site POST arrives without it and renews nothing. `DELETE` is not a
 * CORS-safelisted method, so a cross-site caller has to pass a preflight this
 * application does not answer; and its only effect is to REMOVE privilege
 * anyway.
 */

/**
 * `POST /api/lodge/pin-session` — a person interacted with the kiosk, so slide
 * the idle window forward.
 *
 * Refuses anything that is not already a live PIN session, so it can neither
 * create a session nor bring an expired one back: the PIN is the only way in.
 */
export async function POST(req: NextRequest) {
  // The full kiosk auth check, not a bare cookie read: the account must still
  // be an active lodge account, the cookie must still be bound to THIS signed-in
  // account, the PIN must not have been reset, and the assignment must still
  // cover the club's day. All of that is `checkLodgeAuth`'s job, and reaching
  // the `hut-leader` tier is the proof it passed.
  const authResult = await checkLodgeAuth(undefined, { request: req });
  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status }
    );
  }

  /*
    RATE LIMITED BY ACCOUNT, WITH A LARGER SHARED-ADDRESS BACKSTOP, and not by
    address alone — `applyMemberScopedRateLimit`'s own docblock is the argument
    and it applies exactly here. A lodge can run two or three tablets on one
    connection, so an address-keyed budget is shared by devices that are all
    behaving correctly; worse, anybody else on that connection could hold the
    budget spent for ten minutes and time a working hut leader out mid-roster.
    Keyed on the kiosk account, a flood from elsewhere on the network cannot
    reach the key the tablet is judged on. It runs AFTER the auth check because
    the account is what it keys on, which is also why an unauthenticated caller
    never reaches the member budget at all.
  */
  const kioskAccountId = authResult.session?.user?.id;
  if (kioskAccountId) {
    const limited = await applyMemberScopedRateLimit(
      rateLimiters.lodgePinSession,
      req,
      kioskAccountId
    );
    if (limited) {
      return limited;
    }
  }

  const hasPinSession =
    authResult.tier === "hut-leader" &&
    "pinSession" in authResult &&
    Boolean(authResult.pinSession);
  const renewed = hasPinSession ? renewLodgePinSessionForRequest(req) : null;
  if (!renewed) {
    // Includes the ordinary-tier case (no PIN session on this device) and a
    // hut leader signed in with their own account, which has no PIN session to
    // renew and is not governed by this window at all. Nothing is disclosed
    // either way: the caller already knows its own tier.
    return NextResponse.json(
      { error: "No PIN session to renew" },
      { status: 403 }
    );
  }

  // Deliberately minimal: `{ renewed: true }` and a fresh cookie. The kiosk
  // needs no deadline to display, and a body with nothing in it has nothing to
  // leak.
  const response = NextResponse.json({ renewed: true });
  setLodgePinSessionCookie(response.cookies, renewed);
  return response;
}

/**
 * `DELETE /api/lodge/pin-session` — **Lock**: end the PIN session now.
 *
 * **Deliberately unconditional, and deliberately unguarded.** It clears the
 * cookie and answers 200 whether or not there was a session to clear and
 * whether or not the caller is signed in. Two reasons, and both are about
 * failing in the safe direction:
 *
 * - A lock only ever REMOVES privilege. Making it depend on a check means
 *   inventing ways for it to fail, and a lock that refuses because the
 *   NextAuth session lapsed thirty seconds ago would leave a signed PIN cookie
 *   sitting on a shared tablet, ready to take effect again the moment that
 *   account signed back in.
 * - There is nothing here to protect. It reads nothing, reveals nothing, and
 *   mutates no stored state; the worst a caller achieves is making somebody
 *   re-enter a PIN. It is not reachable cross-site either: `DELETE` is not a
 *   CORS-safelisted method, so a cross-origin caller needs a preflight this
 *   application does not answer.
 *
 * The route's lodge boundary is `POST`'s `checkLodgeAuth` above; this method has
 * no gate on purpose, which is pinned by a test rather than left to a reader to
 * infer.
 */
export async function DELETE(req: NextRequest) {
  const limited = await applyRateLimit(rateLimiters.lodgePinSession, req);
  if (limited) {
    return limited;
  }

  const response = NextResponse.json({ locked: true });
  clearLodgePinSessionCookie(response.cookies);
  return response;
}
