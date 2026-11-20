/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/reduce-by-lost-dispute
 * (#4998): how the route answers. The reduction's rules are the service's
 * (`manual-refund-task-dispute-reduction.test.ts`); here, the lock(1) budget's
 * contention answer (`INV-LOCK-006`). The reduction writes in one transaction
 * and moves no money outside it, so a contended one saved nothing and answers
 * the same one-step 503 as the dismissal door beside it.
 */
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRANSACTION_CONTENDED_CODE,
  TRANSACTION_CONTENDED_MESSAGE,
} from "@/lib/transaction-contended-response";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireRecentAuth: vi.fn(),
  reduceDisputedHandBack: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin-page-revalidation", () => ({ revalidateAdminPage: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: mocks.requireRecentAuth }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/manual-refund-task-dispute-reduction", () => ({
  reduceDisputedHandBack: mocks.reduceDisputedHandBack,
  disputedHandBackReductionMessage: () => "Refund reduced.",
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/payments/manual-refund-tasks/[id]/reduce-by-lost-dispute/route";
import { DISPUTED_HAND_BACK_REDUCTION_FAILED } from "@/lib/manual-refund-task-copy";

const params = Promise.resolve({ id: "task_1" });

function request() {
  return new NextRequest(
    "http://localhost/api/admin/payments/manual-refund-tasks/task_1/reduce-by-lost-dispute",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, expectedAmountCents: 10_000, expectedReducedByCents: 3_000 }),
    },
  );
}

const contention = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer_1" } } });
  mocks.requireRecentAuth.mockResolvedValue({ ok: true });
  mocks.reduceDisputedHandBack.mockResolvedValue({
    taskId: "task_1", wasCents: 10_000, reducedByCents: 3_000, stillOwedCents: 7_000,
  });
});

describe("reduce-by-lost-dispute route", () => {
  it("reduces with the figures the officer confirmed", async () => {
    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    expect(mocks.reduceDisputedHandBack).toHaveBeenCalledExactlyOnceWith({
      taskId: "task_1", actingMemberId: "officer_1", expectedAmountCents: 10_000, expectedReducedByCents: 3_000,
    });
  });

  it.each(["P2028", "P2034"])(
    "answers %s contention with a retryable 503 saying nothing was saved",
    async (code) => {
      mocks.reduceDisputedHandBack.mockRejectedValue(contention(code));

      const response = await POST(request(), { params });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("2");
      await expect(response.json()).resolves.toEqual({
        error: TRANSACTION_CONTENDED_MESSAGE,
        code: TRANSACTION_CONTENDED_CODE,
      });
    },
  );

  it("keeps an unrelated Prisma error on the generic 500, without its message", async () => {
    mocks.reduceDisputedHandBack.mockRejectedValue(contention("P2002"));

    const response = await POST(request(), { params });

    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: DISPUTED_HAND_BACK_REDUCTION_FAILED });
  });
});
