import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroContactGroups } from "@/lib/xero";
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
    // Check by name to avoid instanceof issues across module boundaries
    if (error instanceof Error && error.name === "XeroDailyLimitError") {
      return NextResponse.json(
        { error: "Xero daily API limit reached. Please try again tomorrow." },
        { status: 429 }
      );
    }

    // Detect 429 from raw Xero SDK errors that bypassed withXeroRetry
    const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
    const rateLimitProblem = (error as { response?: { headers?: Record<string, string> } })?.response?.headers?.["x-rate-limit-problem"];

    if (statusCode === 429) {
      const message = rateLimitProblem === "day"
        ? "Xero daily API limit reached. Please try again tomorrow."
        : "Xero rate limit hit. Please wait a moment and try again.";
      return NextResponse.json({ error: message }, { status: 429 });
    }

    if (statusCode === 401 || statusCode === 403) {
      return NextResponse.json(
        { error: "Xero connection expired. Please reconnect Xero from the admin panel." },
        { status: 401 }
      );
    }

    logger.error({ err: error }, "Failed to fetch Xero contact groups");
    const message =
      error instanceof Error ? error.message : "Failed to fetch contact groups";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
