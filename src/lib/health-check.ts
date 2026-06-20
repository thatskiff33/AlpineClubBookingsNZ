import { prisma } from "@/lib/prisma";
import { getRuntimeConfigCheck } from "@/lib/runtime-config";
import { resolveEmailDeliveryConfig } from "@/lib/email-delivery";
import { countExhaustedPaymentRecoveryOperations } from "@/lib/payment-recovery-health";

export interface CheckResult {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

export interface DetailedHealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  checks: {
    db: CheckResult;
    config?: CheckResult;
    stripe: CheckResult;
    xero: CheckResult;
    smtp: CheckResult;
    paymentRecovery: CheckResult;
  };
}

export interface PublicHealthReport {
  status: "healthy" | "unhealthy";
  version: string;
  uptime: number;
  checks: {
    db: Omit<CheckResult, "error">;
  };
}

export interface ReadinessHealthReport {
  status: "healthy" | "unhealthy";
  version: string;
  uptime: number;
  checks: {
    db: Omit<CheckResult, "error">;
    config: Omit<CheckResult, "error">;
  };
}

export interface RuntimeStatusReport {
  cronEnabled: boolean;
  role: string;
}

const CHECK_TIMEOUT_MS = 3000;
const processStartTime = Date.now();

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeoutMs),
    ),
  ]);
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
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
      return {
        status: "error",
        latencyMs: 0,
        error: "STRIPE_SECRET_KEY not configured",
      };
    }
    if (
      !key.startsWith("sk_test_") &&
      !key.startsWith("sk_live_") &&
      !key.startsWith("rk_")
    ) {
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
      CHECK_TIMEOUT_MS,
    );
    if (!token) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        error: "Not connected",
      };
    }
    if (token.expiresAt < new Date()) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        error: "Token expired",
      };
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
    const config = resolveEmailDeliveryConfig();
    if (!config.ok || !config.transportOptions) {
      return {
        status: "error",
        latencyMs: 0,
        error: `Email delivery config invalid: ${config.issues.join("; ")}`,
      };
    }

    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport(
      config.transportOptions,
    );
    await transporter.verify();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

const PAYMENT_RECOVERY_STALE_THRESHOLD_MS = 15 * 60 * 1000;

async function checkPaymentRecoveryQueue(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const staleThreshold = new Date(
      Date.now() - PAYMENT_RECOVERY_STALE_THRESHOLD_MS,
    );
    const [stale, exhausted] = await withTimeout(
      Promise.all([
        prisma.paymentRecoveryOperation.count({
          where: {
            status: "PENDING",
            createdAt: { lt: staleThreshold },
          },
        }),
        countExhaustedPaymentRecoveryOperations(),
      ]),
      CHECK_TIMEOUT_MS,
    );

    const problems: string[] = [];
    if (stale > 0) {
      problems.push(
        `${stale} payment recovery operation(s) pending > 15 minutes; check /api/cron/payments scheduler`,
      );
    }
    if (exhausted > 0) {
      problems.push(
        `${exhausted} payment recovery operation(s) exhausted retries and need manual reconciliation`,
      );
    }

    if (problems.length > 0) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        error: problems.join("; "),
      };
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

function getBaseMetadata() {
  return {
    version: process.env.npm_package_version || "0.1.0",
    uptime: Math.floor((Date.now() - processStartTime) / 1000),
  };
}

function toPublicCheckResult(check: CheckResult) {
  return {
    status: check.status,
    latencyMs: check.latencyMs,
  };
}

export function getRuntimeStatus(): RuntimeStatusReport {
  return {
    cronEnabled: (process.env.CRON_ENABLED ?? "true").toLowerCase() === "true",
    role: process.env.APP_RUNTIME_ROLE ?? "unknown",
  };
}

export async function getDetailedHealthReport(): Promise<{
  httpStatus: number;
  report: DetailedHealthReport;
}> {
  const [db, stripe, xero, smtp, paymentRecovery] = await Promise.all([
    checkDatabase(),
    checkStripe(),
    checkXero(),
    checkSmtp(),
    checkPaymentRecoveryQueue(),
  ]);
  const config = getRuntimeConfigCheck();

  const isUnhealthy = db.status === "error";
  const isDegraded =
    !isUnhealthy &&
    (config.status === "error" ||
      stripe.status === "error" ||
      xero.status === "error" ||
      smtp.status === "error" ||
      paymentRecovery.status === "error");

  return {
    httpStatus: isUnhealthy ? 503 : 200,
    report: {
      ...getBaseMetadata(),
      status: isUnhealthy ? "unhealthy" : isDegraded ? "degraded" : "healthy",
      checks: { db, config, stripe, xero, smtp, paymentRecovery },
    },
  };
}

export async function getPublicHealthReport(): Promise<{
  httpStatus: number;
  report: PublicHealthReport;
}> {
  const db = await checkDatabase();
  const publicDbCheck = toPublicCheckResult(db);

  return {
    httpStatus: db.status === "ok" ? 200 : 503,
    report: {
      ...getBaseMetadata(),
      status: db.status === "ok" ? "healthy" : "unhealthy",
      checks: { db: publicDbCheck },
    },
  };
}

export async function getReadinessHealthReport(): Promise<{
  httpStatus: number;
  report: ReadinessHealthReport;
}> {
  const db = await checkDatabase();
  const config = getRuntimeConfigCheck();
  const isHealthy = db.status === "ok" && config.status === "ok";

  return {
    httpStatus: isHealthy ? 200 : 503,
    report: {
      ...getBaseMetadata(),
      status: isHealthy ? "healthy" : "unhealthy",
      checks: {
        db: toPublicCheckResult(db),
        config: toPublicCheckResult(config),
      },
    },
  };
}
