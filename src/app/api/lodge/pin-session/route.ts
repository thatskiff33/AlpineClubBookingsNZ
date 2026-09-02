import { NextRequest, NextResponse } from "next/server";
import { noStoreLodgeResponse } from "@/lib/lodge-cache-headers";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import {
  clearLodgePinSessionCookie,
  renewLodgePinSessionForRequest,
  setLodgePinSessionCookie,
} from "@/lib/lodge-pin-session";
import {
  applyRateLimit,
  checkRateLimit,
  rateLimitedResponse,
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
 * browser's console they can call this endpoint on a timer. Nor does it tell a
 * person's finger from an injected tap: kiosk anti-sleep tooling, condensation,
 * or a failing digitiser all produce **trusted** touch events, and a screen
 * touching itself reads exactly like somebody working. No signal a browser can
 * send is beyond the reach of somebody holding the device, so that is a limit of
 * the mechanism rather than a gap in it — the controls against a person standing
 * at an unlocked kiosk are the **Lock** button and the ten-minute window, and
 * the bound on all three of those cases is the absolute ceiling
 * (`HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS`): twelve hours from the PIN entry,
 * judged from `iat`, which renewal carries through unchanged. Past it this route
 * refuses and the PIN has to be typed again.
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
 *
 * **The 403 is load-bearing for the browser, not only a refusal.** It is the
 * server saying "there is no session here", and the client treats it as the
 * authoritative end of the window — it stops showing a hut leader's view at once
 * rather than waiting for its own estimate to run out. A 429 or a network
 * failure says nothing of the kind and must never be read that way, which is why
 * the client distinguishes them.
 */
export async function POST(req: NextRequest) {
  // #3228 — nothing here may be cached; `src/lib/lodge-cache-headers.ts` says why.
  return noStoreLodgeResponse(await handlePost(req));
}

async function handlePost(req: NextRequest) {
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
    RATE LIMITED BY ACCOUNT ONLY, WITH NO ADDRESS BACKSTOP AT ALL, and that
    omission is deliberate rather than an oversight.

    `applyMemberScopedRateLimit` would be the obvious helper, and on this route
    its shared-address backstop is a LOCKOUT LEVER rather than a protection. It
    checks `ip:<addr>` first, at ten times the per-account budget, and that key
    is reachable by any caller who gets past `checkLodgeAuth` with a tier — which
    on a lodge kiosk includes a guest staying the night, on the lodge's own wifi.
    Ten requests a second from anywhere on that connection would answer the
    tablet's renewals with 429 until the window rolled, and the browser's renewal
    is a fire-and-forget call whose throttle is already spent, so nothing would
    retry for a minute. The consequence is a hut leader timed out mid-roster by a
    stranger's phone: the exact outcome the ten-minute window was chosen to
    avoid.

    Nothing is lost by dropping it. The reason `applyMemberScopedRateLimit`
    exists is enumeration — a caller rotating addresses to get fresh budgets —
    and there is nothing here to enumerate: this route reads nothing, reveals
    nothing, and refuses everything that does not already hold a valid signed
    session cookie for the signed-in account. The account key alone bounds cost,
    which is all this limiter was ever for.

    ONE BUDGET PER KIOSK ACCOUNT, WHICH IS SHARED BY EVERY TABLET AT THAT LODGE,
    because they are all signed in as the same account. Sixty a minute against
    one renewal a minute per device leaves room for far more tablets than any
    lodge runs. It runs AFTER the auth check because the account is what it keys
    on, which is also why an unauthenticated caller never reaches it.
  */
  const kioskAccountId = authResult.session?.user?.id;
  if (kioskAccountId) {
    const limit = await checkRateLimit(
      rateLimiters.lodgePinSession,
      `member:${kioskAccountId}`
    );
    if (!limit.success) {
      return rateLimitedResponse(limit);
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
  // #3228 — nothing here may be cached; `src/lib/lodge-cache-headers.ts` says why.
  return noStoreLodgeResponse(await handleDelete(req));
}

async function handleDelete(req: NextRequest) {
  const limited = await applyRateLimit(rateLimiters.lodgePinSession, req);
  if (limited) {
    return limited;
  }

  const response = NextResponse.json({ locked: true });
  clearLodgePinSessionCookie(response.cookies);
  return response;
}
