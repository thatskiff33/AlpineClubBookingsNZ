import { NextResponse } from "next/server";
import { getReadinessHealthReport } from "@/lib/health-check";
import logger from "@/lib/logger";

export async function GET() {
  try {
    const { report, httpStatus } = await getReadinessHealthReport();

    logger.debug(
      { health: report.status, role: report.runtime.role },
      "Readiness check completed"
    );

    return NextResponse.json(report, {
      status: httpStatus,
    });
  } catch (err) {
    logger.error({ err }, "Readiness check failed");
    return NextResponse.json(
      {
        status: "unhealthy",
        version: process.env.npm_package_version || "0.1.0",
        uptime: 0,
        checks: {},
        runtime: {
          cronEnabled: (process.env.CRON_ENABLED ?? "true").toLowerCase() === "true",
          role: process.env.APP_RUNTIME_ROLE ?? "unknown",
        },
      },
      { status: 503 }
    );
  }
}
