import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { redactExpiredIssueReportSensitiveData } from "@/lib/issue-report-retention";
import logger from "@/lib/logger";

function isAuthorisedCronRequest(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;

  return Boolean(
    cronSecret &&
      expected &&
      cronSecret.length === expected.length &&
      timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected))
  );
}

export async function POST(request: NextRequest) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await redactExpiredIssueReportSensitiveData();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Issue report retention cron failed");
    return NextResponse.json(
      { error: "Failed to redact expired issue report data" },
      { status: 500 }
    );
  }
}
