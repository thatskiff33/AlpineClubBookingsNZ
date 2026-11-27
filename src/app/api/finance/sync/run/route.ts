import { getAppBaseUrl } from "@/lib/app-url";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { FINANCE_SYNC_RUN_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-reports";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { runManualFinanceSync } from "@/lib/finance-sync-manual";
import logger from "@/lib/logger";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";

const FINANCE_REVALIDATE_PATHS = ["/finance"] as const;

function buildFinanceRedirectUrl(params: Record<string, string>) {
  const baseUrl = getAppBaseUrl();
  const url = new URL("/finance", baseUrl);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

/**
 * The browser's form post is answered with a redirect back to `/finance`
 * carrying the outcome. An AI app connection cannot follow one (ALP-721), so
 * it is answered with the same outcome as JSON: `completed` or `partial` with
 * the run's figures, `already-running` (409) or `failed` (500), and a refused
 * sign-in as the guard's own JSON refusal.
 */
export async function POST(request: NextRequest) {
  const viaConnection = arrivesAsMcpConnection(request);
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    if (viaConnection) return authResult.response;
    const baseUrl = getAppBaseUrl();
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
      if (viaConnection) {
        return NextResponse.json(
          {
            error: "A finance sync run is already in progress",
            outcome: "already-running",
            runId: result.runId,
            startedAt: result.startedAt.toISOString(),
          },
          { status: 409 }
        );
      }
      return NextResponse.redirect(
        buildFinanceRedirectUrl({ sync: "running" }),
        303
      );
    }

    for (const path of FINANCE_REVALIDATE_PATHS) {
      revalidatePath(path);
    }

    const sync = result.execution.status === "SUCCEEDED" ? "completed" : "partial";
    if (viaConnection) {
      const { execution } = result;
      return connectionJson(
        request,
        {
          outcome: sync,
          runId: execution.runId,
          status: execution.status,
          startedAt: execution.startedAt.toISOString(),
          completedAt: execution.completedAt.toISOString(),
          snapshotCount: execution.snapshotCount,
          totalRowCount: execution.totalRowCount,
          datasetResults: execution.datasetResults,
        },
        FINANCE_SYNC_RUN_CONNECTION_SHAPE
      );
    }

    return NextResponse.redirect(
      buildFinanceRedirectUrl({ sync }),
      303
    );
  } catch (error) {
    logger.error({ err: error }, "Manual finance sync failed");

    if (viaConnection) {
      return NextResponse.json(
        { error: "Manual finance sync failed", outcome: "failed" },
        { status: 500 }
      );
    }

    return NextResponse.redirect(
      buildFinanceRedirectUrl({
        sync: "failed",
      }),
      303
    );
  }
}
