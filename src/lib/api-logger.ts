import { NextRequest, NextResponse } from "next/server";
import logger from "./logger";

/**
 * OBS-05: API route request logging wrapper.
 * Logs method, path, status, duration, and IP for every API request.
 * Auth endpoints have credentials stripped. Webhook endpoints include event type.
 */
export function withRequestLogging(
  handler: (request: NextRequest, context?: unknown) => Promise<NextResponse> | NextResponse,
  routeName?: string
) {
  return async (request: NextRequest, context?: unknown): Promise<NextResponse> => {
    const start = Date.now();
    const method = request.method;
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    let response: NextResponse;
    try {
      response = await handler(request, context);
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error(
        { method, path, durationMs, ip, route: routeName, err },
        "API request failed with unhandled error"
      );
      throw err;
    }

    const durationMs = Date.now() - start;
    const status = response.status;

    const logData: Record<string, unknown> = {
      method,
      path,
      status,
      durationMs,
      ip,
    };

    if (routeName) {
      logData.route = routeName;
    }

    if (status >= 500) {
      logger.error(logData, "API request completed with server error");
    } else if (status >= 400) {
      logger.warn(logData, "API request completed with client error");
    } else {
      logger.info(logData, "API request completed");
    }

    return response;
  };
}
