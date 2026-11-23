import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import {
  claimDisplayToken,
  decodePairingBlob,
  DISPLAY_PAIRING_COOKIE,
  DISPLAY_TOKEN_COOKIE,
  DISPLAY_TOKEN_MAX_AGE_SECONDS,
  encodePairingBlob,
  generatePairingCode,
  PAIRING_CODE_TTL_SECONDS,
} from "@/lib/lodge-display-auth";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// Lobby display pairing (fork issue hoppers99/AlpineClubBookingsNZ#27, ADR-001 §2). Two anonymous actions:
//
//  - "start": issue a fresh pairing code inside an HMAC-signed, httpOnly
//    cookie blob. Persists NOTHING — anonymous traffic cannot create rows.
//  - "claim": poll for an admin having bound this device's code. Only a code
//    the server itself signed for this browser can be presented, so a
//    shoulder-surfed code alone is unusable. Match → issue the display token
//    (hash at rest), clear the pairing fields (single-use).
//
// Unmatched claims return 200 { paired: false } — the display page polls this
// while showing the code, and a poll is not an error. Rate limiting bounds
// both actions per IP; the module flag gates the whole /api/display prefix at
// the proxy (404 when off).

const bodySchema = z.object({
  action: z.enum(["start", "claim"]),
});

const secureCookies = process.env.NODE_ENV === "production";

export async function POST(req: NextRequest) {
  let action: z.infer<typeof bodySchema>["action"];
  const jsonBody = await parseJsonRequestBody(req);
  if (!jsonBody.ok) return jsonBody.response;
  try {
    action = bodySchema.parse(jsonBody.body).action;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Start issues fresh codes (strict, auth-sensitive limit); claim is the
  // display page's poll while its code shows, bound to the signed blob it
  // already holds — poll-friendly limit, no guessable surface (ADR-001 §5).
  const rateLimited = await applyRateLimit(
    action === "start" ? rateLimiters.displayPairing : rateLimiters.displayClaim,
    req
  );
  if (rateLimited) return rateLimited;

  if (action === "start") {
    const code = generatePairingCode();
    const exp = Math.floor(Date.now() / 1000) + PAIRING_CODE_TTL_SECONDS;

    const response = NextResponse.json({
      code,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
    response.cookies.set(DISPLAY_PAIRING_COOKIE, encodePairingBlob({ code, exp }), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
      maxAge: PAIRING_CODE_TTL_SECONDS,
      path: "/",
    });
    return response;
  }

  // action === "claim"
  const rawBlob = req.cookies.get(DISPLAY_PAIRING_COOKIE)?.value;
  const blob = rawBlob ? decodePairingBlob(rawBlob) : null;
  if (!blob) {
    // Expired or missing blob: the display page restarts pairing for a
    // fresh code rather than treating this as an error state.
    return NextResponse.json({ paired: false, restart: true });
  }

  const claimed = await claimDisplayToken(blob.code);
  if (!claimed) {
    return NextResponse.json({ paired: false });
  }

  const response = NextResponse.json({ paired: true });
  response.cookies.set(DISPLAY_TOKEN_COOKIE, claimed.token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    maxAge: DISPLAY_TOKEN_MAX_AGE_SECONDS,
    path: "/",
  });
  response.cookies.set(DISPLAY_PAIRING_COOKIE, "", {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
