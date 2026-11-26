import { getAppBaseUrl } from "@/lib/app-url";
import { NextResponse } from "next/server";
import { buildLoginPath } from "@/lib/auth-redirect";
import { auth } from "@/lib/auth";
import { hasFinanceViewerAccess } from "@/lib/admin-permissions";
import { loadFinanceAccessMember } from "@/lib/finance-auth";
import { hasLodgeAccess } from "@/lib/access-roles";
import { factorGateRedirect } from "@/lib/two-factor-gate";

const LEGACY_DASHBOARD_CALLBACK_PATH = "/finance-legacy/";

function buildAbsoluteUrl(path: string) {
  return new URL(path, getAppBaseUrl());
}

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.redirect(
      buildAbsoluteUrl(buildLoginPath(LEGACY_DASHBOARD_CALLBACK_PATH))
    );
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member || !member.active) {
    return NextResponse.redirect(
      buildAbsoluteUrl(buildLoginPath(LEGACY_DASHBOARD_CALLBACK_PATH))
    );
  }

  if (member.forcePasswordChange) {
    return NextResponse.redirect(buildAbsoluteUrl("/change-password"));
  }

  const factorGate = factorGateRedirect({
    sessionUser: session.user,
    member,
    callbackPath: LEGACY_DASHBOARD_CALLBACK_PATH,
    pathname: LEGACY_DASHBOARD_CALLBACK_PATH,
  });
  if (factorGate) {
    return NextResponse.redirect(buildAbsoluteUrl(factorGate));
  }

  if (!hasFinanceViewerAccess(member)) {
    if (hasLodgeAccess(member)) {
      return NextResponse.redirect(buildAbsoluteUrl("/lodge/kiosk"));
    }
    return NextResponse.redirect(buildAbsoluteUrl("/dashboard"));
  }

  return new NextResponse(null, { status: 204 });
}
