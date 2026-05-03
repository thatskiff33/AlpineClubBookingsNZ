import { NextRequest, NextResponse } from "next/server";
import { buildLoginPath } from "@/lib/auth-redirect";
import { auth } from "@/lib/auth";
import {
  hasFinanceViewerAccess,
  loadFinanceAccessMember,
} from "@/lib/finance-auth";

const LEGACY_DASHBOARD_CALLBACK_PATH = "/finance-legacy/";

function buildAbsoluteUrl(request: NextRequest, path: string) {
  return new URL(path, process.env.NEXTAUTH_URL || request.url);
}

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.redirect(
      buildAbsoluteUrl(
        request,
        buildLoginPath(LEGACY_DASHBOARD_CALLBACK_PATH)
      )
    );
  }

  if (session.user.role === "LODGE") {
    return NextResponse.redirect(buildAbsoluteUrl(request, "/lodge/kiosk"));
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member || !member.active) {
    return NextResponse.redirect(
      buildAbsoluteUrl(
        request,
        buildLoginPath(LEGACY_DASHBOARD_CALLBACK_PATH)
      )
    );
  }

  if (member.forcePasswordChange) {
    return NextResponse.redirect(buildAbsoluteUrl(request, "/change-password"));
  }

  if (!hasFinanceViewerAccess(member.financeAccessLevel)) {
    return NextResponse.redirect(buildAbsoluteUrl(request, "/dashboard"));
  }

  return new NextResponse(null, { status: 204 });
}
