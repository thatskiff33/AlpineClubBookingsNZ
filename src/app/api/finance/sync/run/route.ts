import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { runManualFinanceSync } from "@/lib/finance-sync-manual";
import logger from "@/lib/logger";

const FINANCE_REVALIDATE_PATHS = ["/finance"] as const;

function buildFinanceRedirectUrl(
  request: NextRequest,
  params: Record<string, string>
) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const url = new URL("/finance", baseUrl);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

export async function POST(request: NextRequest) {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    const baseUrl = process.env.NEXTAUTH_URL || request.url;
    const destination =
      authResult.response.status === 401
        ? new URL("/login", baseUrl)
        : new URL("/finance", baseUrl);

    return NextResponse.redirect(destination, 303);
  }

  try {
    const result = await runManualFinanceSync({
      requestedByMemberId: authResult.member.id,
    });

    if (result.outcome === "already-running") {
      return NextResponse.redirect(
        buildFinanceRedirectUrl(request, { sync: "running" }),
        303
      );
    }

    for (const path of FINANCE_REVALIDATE_PATHS) {
      revalidatePath(path);
    }

    return NextResponse.redirect(
      buildFinanceRedirectUrl(request, {
        sync: result.execution.status === "SUCCEEDED" ? "completed" : "partial",
      }),
      303
    );
  } catch (error) {
    logger.error({ err: error }, "Manual finance sync failed");

    return NextResponse.redirect(
      buildFinanceRedirectUrl(request, {
        sync: "failed",
      }),
      303
    );
  }
}
