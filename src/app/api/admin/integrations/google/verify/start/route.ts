import "server-only";

import { NextResponse } from "next/server";

import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { getGoogleSetupState } from "@/lib/google-config";
import {
  GOOGLE_VERIFY_INTENT_COOKIE,
  GOOGLE_VERIFY_INTENT_TTL_SECONDS,
  buildGoogleVerifyIntentValue,
} from "@/lib/google-oauth";
import logger from "@/lib/logger";

// POST /api/admin/integrations/google/verify/start (#2087). A FULL ADMIN calls
// this before `signIn("google")` on the setup wizard's Verify step. It sets a
// short-lived, HttpOnly, HMAC-signed cookie binding this admin's id and marks
// the ensuing OAuth callback as a VERIFICATION (not a login or link). The signIn
// callback reads the cookie on `/api/auth/callback/google`, binds it to the
// current Full-Admin session, records the verified marker, and redirects back to
// the wizard — WITHOUT minting a session or linking anything. Never sets a
// session here; never records verification here (that requires the round-trip).
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) {
    return NextResponse.json(
      { error: "Full admin access is required." },
      { status: 403 },
    );
  }

  // Both credentials must be stored and readable before a round-trip can prove
  // anything. Fail-closed on an inability to confirm (a store error).
  let state;
  try {
    state = await getGoogleSetupState();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "Could not resolve Google setup state for verify-start",
    );
    return NextResponse.json(
      { error: "Could not start verification. Try again shortly." },
      { status: 500 },
    );
  }
  if (!state.clientIdSet || !state.clientSecretSet || state.needsReentry) {
    return NextResponse.json(
      { error: "Enter both the Client ID and Client secret before verifying." },
      { status: 400 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    GOOGLE_VERIFY_INTENT_COOKIE,
    buildGoogleVerifyIntentValue(guard.session.user.id),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Lax so the cookie is sent on Google's top-level GET redirect back to the
      // OAuth callback, but never on cross-site subrequests.
      sameSite: "lax",
      path: "/",
      maxAge: GOOGLE_VERIFY_INTENT_TTL_SECONDS,
    },
  );
  return res;
}
