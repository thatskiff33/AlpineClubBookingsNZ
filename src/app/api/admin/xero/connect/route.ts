import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroConsentUrl } from "@/lib/xero";

/**
 * GET /api/admin/xero/connect
 * Redirects the admin to Xero's OAuth2 consent page.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const consentUrl = await getXeroConsentUrl();
    return NextResponse.redirect(consentUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate Xero consent URL";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
