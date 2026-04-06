import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

interface CheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 3000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeoutMs)
    ),
  ]);
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await withTimeout(
      prisma.$queryRaw`SELECT 1`,
      CHECK_TIMEOUT_MS
    );
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkStripe(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      return { status: "error", latencyMs: 0, error: "STRIPE_SECRET_KEY not configured" };
    }
    // Validate key format without making an API call
    if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_") && !key.startsWith("rk_")) {
      return { status: "error", latencyMs: 0, error: "Invalid key format" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkXero(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const token = await withTimeout(
      prisma.xeroToken.findFirst({ orderBy: { updatedAt: "desc" } }),
      CHECK_TIMEOUT_MS
    );
    if (!token) {
      return { status: "error", latencyMs: Date.now() - start, error: "Not connected" };
    }
    if (token.expiresAt < new Date()) {
      return { status: "error", latencyMs: Date.now() - start, error: "Token expired" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

async function checkSmtp(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const host = process.env.SMTP_HOST;
    const user = process.env.AWS_SES_ACCESS_KEY_ID;
    if (!host || !user) {
      return { status: "error", latencyMs: 0, error: "SMTP not configured" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

const startTime = Date.now();

export async function GET() {
  try {
    const [db, stripe, xero, smtp] = await Promise.all([
      checkDatabase(),
      checkStripe(),
      checkXero(),
      checkSmtp(),
    ]);

    const checks = { db, stripe, xero, smtp };

    // DB is critical; stripe is critical; xero and smtp are non-critical
    const isUnhealthy = db.status === "error";
    const isDegraded =
      !isUnhealthy &&
      (stripe.status === "error" ||
        xero.status === "error" ||
        smtp.status === "error");

    const status = isUnhealthy
      ? "unhealthy"
      : isDegraded
        ? "degraded"
        : "healthy";

    const response = {
      status,
      version: process.env.npm_package_version || "0.1.0",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks,
    };

    logger.debug({ health: status }, "Health check completed");

    return NextResponse.json(response, {
      status: isUnhealthy ? 503 : 200,
    });
  } catch (err) {
    logger.error({ err }, "Health check failed");
    return NextResponse.json(
      {
        status: "unhealthy",
        version: process.env.npm_package_version || "0.1.0",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        checks: {},
      },
      { status: 503 }
    );
  }
}
