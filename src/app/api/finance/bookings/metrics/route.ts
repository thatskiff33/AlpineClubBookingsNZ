import { NextRequest, NextResponse } from "next/server";
import { FINANCE_BOOKING_METRICS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-reports";
import { requireFinanceViewerApiAccess } from "@/lib/finance-api-auth";
import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";
import { financeBookingMetricsQuerySchema } from "@/lib/finance-booking-metrics-query";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function GET(request: NextRequest) {
  const authResult = await requireFinanceViewerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  const { searchParams } = new URL(request.url);
  const parsed = financeBookingMetricsQuerySchema.safeParse({
    realizedFrom: searchParams.get("realizedFrom") ?? undefined,
    realizedTo: searchParams.get("realizedTo") ?? undefined,
    realizedCutoff: searchParams.get("realizedCutoff") ?? undefined,
    forwardFrom: searchParams.get("forwardFrom") ?? undefined,
    forwardTo: searchParams.get("forwardTo") ?? undefined,
    forwardAsOf: searchParams.get("forwardAsOf") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Invalid finance booking metrics query. Use paired realizedFrom/realizedTo and/or forwardFrom/forwardTo dates in YYYY-MM-DD format.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const metrics = await getFinanceBookingMetrics({
      // #3372: one request, one window set - so it carries the owed figures.
      includeRefundsAndCreditsOwed: true,
      ...(parsed.data.realizedFrom && parsed.data.realizedTo
        ? {
            realized: {
              from: parsed.data.realizedFrom,
              to: parsed.data.realizedTo,
              cutoffDate: parsed.data.realizedCutoff,
            },
          }
        : {}),
      ...(parsed.data.forwardFrom && parsed.data.forwardTo
        ? {
            forward: {
              from: parsed.data.forwardFrom,
              to: parsed.data.forwardTo,
              asOfDate: parsed.data.forwardAsOf,
            },
          }
        : {}),
    });

    return connectionJson(request, metrics, FINANCE_BOOKING_METRICS_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load finance booking metrics");
    return NextResponse.json(
      { error: "Failed to load finance booking metrics" },
      { status: 500 }
    );
  }
}
