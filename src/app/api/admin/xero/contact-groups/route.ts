import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroContactGroups, XeroDailyLimitError } from "@/lib/xero";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/contact-groups
 * Returns available Xero contact groups for the import UI.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const groups = await getXeroContactGroups();
    return NextResponse.json({ groups });
  } catch (error) {
    if (error instanceof XeroDailyLimitError) {
      return NextResponse.json(
        { error: "Xero daily API limit reached. Please try again tomorrow." },
        { status: 429 }
      );
    }

    logger.error({ err: error }, "Failed to fetch Xero contact groups");

    // Extract meaningful message from Xero SDK errors
    const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
    if (statusCode === 401 || statusCode === 403) {
      return NextResponse.json(
        { error: "Xero connection expired. Please reconnect Xero from the admin panel." },
        { status: 401 }
      );
    }

    const message =
      error instanceof Error ? error.message : "Failed to fetch contact groups";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
