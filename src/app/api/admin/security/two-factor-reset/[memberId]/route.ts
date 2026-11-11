import { NextResponse } from "next/server";

import { isFullAdmin } from "@/lib/access-roles";
import { getAuditRequestContext } from "@/lib/audit";
import { sendOfficerFactorResetEmail } from "@/lib/email/account";
import logger from "@/lib/logger";
import { clearMemberSecondFactors } from "@/lib/officer-factor-reset";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "@/lib/officer-sign-in-release";
import { requireRecentAuth } from "@/lib/require-recent-auth";
import { requireAdmin } from "@/lib/session-guards";

/**
 * A Full Admin resets another member's lost authenticator and passkeys (#4618).
 *
 * #4619 owns the closed step-up route list. This route calls
 * `requireRecentAuth` itself either way. When that list exists, add
 * `POST /api/admin/security/two-factor-reset/[memberId]` to it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ memberId: string }> },
) {
  if (!OFFICER_SIGN_IN_RELEASE_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const guard = await requireAdmin({ permission: { area: "support", level: "edit" } });
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;

  const { memberId } = await context.params;
  if (memberId === guard.session.user.id) {
    return NextResponse.json(
      { error: "You cannot reset your own second factor." },
      { status: 400 },
    );
  }

  const cleared = await clearMemberSecondFactors({
    memberId,
    actor: { kind: "admin", memberId: guard.session.user.id },
    request: getAuditRequestContext(request),
  });
  if (!cleared.ok) {
    const status = cleared.reason === "kiosk" ? 400 : 404;
    const error =
      cleared.reason === "kiosk"
        ? "The lodge kiosk has no second factor to reset."
        : "Member not found";
    return NextResponse.json({ error }, { status });
  }

  try {
    await sendOfficerFactorResetEmail(cleared.email, cleared.firstName);
  } catch (error) {
    logger.error(
      { err: error, memberId: cleared.memberId },
      "Officer factor reset committed but the email was not queued",
    );
  }

  return NextResponse.json({ ok: true });
}
