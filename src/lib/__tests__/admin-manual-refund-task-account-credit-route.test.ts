/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/account-credit (#5005 child D): how the route answers. What
 * the credit writes, and which tasks qualify, is `booking-import.realdb.test.ts`; here, the gate, the confirmed
 * amount it passes on, the writer's refusals as the officer's sentence, and the lock(1) budget's contention answer
 * (`INV-LOCK-006`).
 */
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSACTION_CONTENDED_CODE } from "@/lib/transaction-contended-response";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireRecentAuth: vi.fn(),
  giveImportedRefundAsCredit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin-page-revalidation", () => ({ revalidateAdminPage: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: mocks.requireRecentAuth }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => CLUB_FORMAT_TEST) }));
vi.mock("@/lib/booking-import/refund-credit", () => ({ giveImportedRefundAsCredit: mocks.giveImportedRefundAsCredit }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/payments/manual-refund-tasks/[id]/account-credit/route";

const params = Promise.resolve({ id: "task_1" });

function request(body: unknown = { confirmed: true, expectedAmountCents: 43_200, note: "Asked for credit" }) {
  return new NextRequest("http://localhost/api/admin/payments/manual-refund-tasks/task_1/account-credit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer_1" } } });
  mocks.requireRecentAuth.mockResolvedValue({ ok: true });
  mocks.giveImportedRefundAsCredit.mockResolvedValue({
    taskId: "task_1", bookingId: "booking_1", amountCents: 43_200, memberCreditId: "credit_1", xeroOperationId: null,
  });
});

describe("account-credit route", () => {
  it("gives the refund as credit at the amount the officer confirmed, and says so", async () => {
    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.giveImportedRefundAsCredit).toHaveBeenCalledExactlyOnceWith(
      { taskId: "task_1", actingMemberId: "officer_1", expectedAmountCents: 43_200, note: "Asked for credit" },
      CLUB_FORMAT_TEST,
    );
    expect((await response.json()).message).toMatch(/given as account credit/);
  });

  it("asks for a recent sign-in before writing anything", async () => {
    mocks.requireRecentAuth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Confirm it's you" }, { status: 401 }) });

    expect((await POST(request(), { params })).status).toBe(401);
    expect(mocks.giveImportedRefundAsCredit).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed request or one with no amount", async () => {
    expect((await POST(request({ confirmed: false, expectedAmountCents: 43_200 }), { params })).status).toBe(400);
    expect((await POST(request({ confirmed: true }), { params })).status).toBe(400);
    expect(mocks.giveImportedRefundAsCredit).not.toHaveBeenCalled();
  });

  it("answers the writer's refusal in its own words and status", async () => {
    mocks.giveImportedRefundAsCredit.mockRejectedValue(new ManualBookingPaymentError("This refund task has already been closed.", 409));

    const response = await POST(request(), { params });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This refund task has already been closed." });
  });

  it.each(["P2028", "P2034"])("answers %s contention with a retryable 503 saying nothing was saved", async (code) => {
    mocks.giveImportedRefundAsCredit.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test" }));

    const response = await POST(request(), { params });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe(TRANSACTION_CONTENDED_CODE);
  });
});
