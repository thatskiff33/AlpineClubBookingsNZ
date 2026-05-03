import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getLegacyDashboardBookingExport } from "@/lib/finance-legacy-dashboard-export";

const DEFAULT_HISTORY_START_DATE = "2020-04-01";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const exportQuerySchema = z.object({
  historyStartDate: z.string().regex(ISO_DATE_PATTERN).optional(),
  asOfDate: z.string().regex(ISO_DATE_PATTERN).optional(),
});

function readLegacyDashboardExportToken() {
  const token = process.env.LEGACY_DASHBOARD_EXPORT_TOKEN?.trim();
  return token ? token : null;
}

function readBearerToken(request: NextRequest) {
  const header = request.headers.get("authorization");

  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function getCurrentIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const expectedToken = readLegacyDashboardExportToken();

  if (!expectedToken) {
    return NextResponse.json(
      { error: "Legacy dashboard export token is not configured" },
      { status: 503 }
    );
  }

  const providedToken = readBearerToken(request);
  if (!providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = exportQuerySchema.safeParse({
    historyStartDate: searchParams.get("historyStartDate") ?? undefined,
    asOfDate: searchParams.get("asOfDate") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Invalid legacy dashboard export query. Use YYYY-MM-DD for historyStartDate and asOfDate.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const exportPayload = await getLegacyDashboardBookingExport({
      historyStartDate:
        parsed.data.historyStartDate ?? DEFAULT_HISTORY_START_DATE,
      asOfDate: parsed.data.asOfDate ?? getCurrentIsoDate(),
    });

    return NextResponse.json(exportPayload);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load legacy dashboard bookings export";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
