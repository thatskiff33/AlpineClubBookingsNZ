import { NextResponse } from "next/server";
import { getAppVersion } from "@/lib/app-version";
import { getPublicHealthReport } from "@/lib/health-check";
import logger from "@/lib/logger";

export async function GET() {
  try {
    const { report, httpStatus } = await getPublicHealthReport();

    logger.debug({ health: report.status }, "Health check completed");

    return NextResponse.json(report, {
      status: httpStatus,
    });
  } catch (err) {
    logger.error({ err }, "Health check failed");
    return NextResponse.json(
      {
        status: "unhealthy",
        version: getAppVersion(),
        uptime: 0,
        checks: {},
      },
      { status: 503 }
    );
  }
}
