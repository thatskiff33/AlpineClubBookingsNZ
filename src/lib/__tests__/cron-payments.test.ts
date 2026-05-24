import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockProcessPaymentRecoveryOperations,
  mockReapStaleWaitingPaymentXeroOutboxOperations,
  mockCronJobRunCreate,
} = vi.hoisted(() => ({
  mockProcessPaymentRecoveryOperations: vi.fn(),
  mockReapStaleWaitingPaymentXeroOutboxOperations: vi.fn(),
  mockCronJobRunCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cronJobRun: {
      create: (...args: unknown[]) => mockCronJobRunCreate(...args),
    },
  },
}));

vi.mock("@/lib/payment-recovery", () => ({
  processPaymentRecoveryOperations: (...args: unknown[]) =>
    mockProcessPaymentRecoveryOperations(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  reapStaleWaitingPaymentXeroOutboxOperations: (...args: unknown[]) =>
    mockReapStaleWaitingPaymentXeroOutboxOperations(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const CRON_SECRET = "test-cron-secret-with-padding";

function authorisedRequest(url: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-cron-secret": CRON_SECRET },
  });
}

describe("POST /api/cron/payments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    mockProcessPaymentRecoveryOperations.mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
    });
    mockReapStaleWaitingPaymentXeroOutboxOperations.mockResolvedValue({
      reaped: 0,
      queueOperationIds: [],
    });
    mockCronJobRunCreate.mockResolvedValue(undefined);
  });

  it("returns 401 when the cron secret header is missing", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const request = new NextRequest(
      "http://localhost/api/cron/payments?task=recovery",
      { method: "POST" }
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("accepts the recovery task and records a successful run", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments?task=recovery")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task).toBe("recovery");
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledOnce();
    expect(mockCronJobRunCreate).toHaveBeenCalledOnce();
  });

  it("defaults to the recovery task when no task is supplied", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.task).toBe("recovery");
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledOnce();
  });

  it("returns 400 when task is not a known enum value", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest("http://localhost/api/cron/payments?task=bogus")
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid task parameter");
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("returns 400 when task is supplied more than once", async () => {
    const { POST } = await import("@/app/api/cron/payments/route");
    const response = await POST(
      authorisedRequest(
        "http://localhost/api/cron/payments?task=recovery&task=recovery"
      )
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid task parameter");
    expect(data.details).toEqual({
      task: ["task may only be provided once"],
    });
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });
});
