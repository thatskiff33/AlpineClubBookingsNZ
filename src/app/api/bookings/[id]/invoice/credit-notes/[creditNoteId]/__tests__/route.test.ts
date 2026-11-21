import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026): one credit note's download,
 * under the invoice's own guards, budgets and answers.
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActive: vi.fn(),
  checkRateLimit: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: mocks.requireActive }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => "203.0.113.9",
  rateLimitedResponse: () => new Response(null, { status: 429 }),
}));
vi.mock("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download", () => ({
  prepareBookingInvoiceDownload: mocks.prepare,
}));

import { GET } from "../route";
import { BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT } from "@/lib/booking-invoice-rate-limits";

const call = (creditNoteId = "xero-cn-1") =>
  GET(new NextRequest(`http://localhost/api/bookings/b1/invoice/credit-notes/${creditNoteId}`), {
    params: Promise.resolve({ id: "b1", creditNoteId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActive.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true });
});

describe("GET /api/bookings/[id]/invoice/credit-notes/[creditNoteId]", () => {
  it("refuses a signed-out caller, an inactive account and a throttled member before any read", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(401);
    mocks.requireActive.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await call()).status).toBe(403);
    mocks.checkRateLimit.mockResolvedValueOnce({ success: false });
    expect((await call()).status).toBe(429);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("asks the download for that credit note of that booking, charging per member first and per booking only once on offer", async () => {
    mocks.prepare.mockResolvedValue({ kind: "NOT_FOUND" });
    await call("xero-cn-1");
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT, "member-1");
    expect(mocks.prepare).toHaveBeenCalledWith(
      "b1",
      { user: { id: "member-1" } },
      { kind: "CREDIT_NOTE", creditNoteId: "xero-cn-1" },
      { ipAddress: "203.0.113.9", chargeBookingLimit: expect.any(Function) },
    );
    await mocks.prepare.mock.calls[0][3].chargeBookingLimit();
    expect(mocks.checkRateLimit).toHaveBeenLastCalledWith(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, "b1");
  });

  it("answers a credit note not on this booking with the same 404 as any refusal", async () => {
    mocks.prepare.mockResolvedValue({ kind: "NOT_FOUND" });
    const response = await call("someone-elses-note");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Booking not found" });
  });

  it("serves the PDF privately, uncached, under the club-named file", async () => {
    mocks.prepare.mockResolvedValue({ kind: "PDF", body: Buffer.from("%PDF"), fileName: "tac-credit-note-CN-0007.pdf" });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="tac-credit-note-CN-0007.pdf"');
  });

  it.each([
    ["RATE_LIMITED", 429],
    ["XERO_NOT_CONNECTED", 503],
    ["XERO_UNAVAILABLE", 502],
    ["AUDIT_FAILED", 503],
  ])("answers %s with %i, naming the credit note", async (kind, status) => {
    mocks.prepare.mockResolvedValue({ kind, limit: { success: false } });
    const response = await call();
    expect(response.status).toBe(status);
    if (status !== 429) expect((await response.json()).error).toMatch(/credit note/);
  });
});
