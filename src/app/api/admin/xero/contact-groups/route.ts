import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroContactGroups } from "@/lib/xero";
import logger from "@/lib/logger";

function isXeroDailyLimit(error: unknown): boolean {
  // Check by class name
  if (error instanceof Error && error.name === "XeroDailyLimitError") return true;

  // Check raw SDK error response object
  const resp = (error as { response?: { statusCode?: number; headers?: Record<string, string> } })?.response;
  if (resp?.statusCode === 429 && resp?.headers?.["x-rate-limit-problem"] === "day") return true;

  // Check stringified error (Xero SDK sometimes wraps errors oddly)
  const errStr = String(error);
  if (errStr.includes('"statusCode":429') && errStr.includes('"x-rate-limit-problem":"day"')) return true;

  return false;
}

function isXeroRateLimit(error: unknown): boolean {
  const resp = (error as { response?: { statusCode?: number } })?.response;
  if (resp?.statusCode === 429) return true;
  const errStr = String(error);
  if (errStr.includes('"statusCode":429')) return true;
  return false;
}

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
    if (isXeroDailyLimit(error)) {
      return NextResponse.json(
        { error: "Xero daily API limit reached. Please try again tomorrow." },
        { status: 429 }
      );
    }

    if (isXeroRateLimit(error)) {
      return NextResponse.json(
        { error: "Xero rate limit hit. Please wait a moment and try again." },
        { status: 429 }
      );
    }

    const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
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
