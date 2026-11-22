import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** #5066: the invoice route's guards and its answer for each download outcome, Xero's PDF or the generated one. */
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

const call = (query = "") =>
  GET(new NextRequest(`http://localhost/api/bookings/b1/invoice${query}`), {
    params: Promise.resolve({ id: "b1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActive.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true });
});

describe("GET /api/bookings/[id]/invoice", () => {
  it("refuses a signed-out caller before any read", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("refuses an inactive account and a throttled caller before any read", async () => {
    mocks.requireActive.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await call()).status).toBe(403);
    mocks.checkRateLimit.mockResolvedValueOnce({ success: false });
    expect((await call()).status).toBe(429);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("throttles per member first, and hands the per-booking budget to the download to charge once on offer", async () => {
    mocks.prepare.mockResolvedValue({ kind: "NOT_FOUND" });
    await call();
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT, "member-1");
    const { chargeBookingLimit } = mocks.prepare.mock.calls[0][3];
    await chargeBookingLimit();
    expect(mocks.checkRateLimit).toHaveBeenLastCalledWith(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT, "b1");
  });

  it("answers a spent per-booking budget with 429", async () => {
    mocks.prepare.mockResolvedValue({ kind: "RATE_LIMITED", limit: { success: false } });
    expect((await call()).status).toBe(429);
  });

  it("gives the download budgets of its own, distinct from every shared limiter", async () => {
    const { rateLimiters } = (await vi.importActual("@/lib/rate-limit")) as typeof import("@/lib/rate-limit");
    expect(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT).toEqual({ id: "booking-invoice-download", limit: 10, windowSeconds: 3600 });
    expect(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT).toEqual({ id: "booking-invoice-download-booking", limit: 20, windowSeconds: 3600 });
    const sharedIds = new Set(Object.values(rateLimiters).map((config) => config.id));
    expect(sharedIds.has(BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT.id)).toBe(false);
    expect(sharedIds.has(BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT.id)).toBe(false);
  });

  it("serves the PDF privately, uncached, as an attachment", async () => {
    mocks.prepare.mockResolvedValue({ kind: "PDF", body: Buffer.from("%PDF"), fileName: "tac-invoice-INV-0042.pdf" });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="tac-invoice-INV-0042.pdf"');
  });

  it("serves the app's generated PDF (Xero off) with the same private headers", async () => {
    mocks.prepare.mockResolvedValue({ kind: "PDF", body: Buffer.from("%PDF-1.3"), fileName: "tac-invoice-CKBOOKIN.pdf" });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="tac-invoice-CKBOOKIN.pdf"');
  });

  it("passes no caller-supplied invoice id through: only the booking id and the session", async () => {
    mocks.prepare.mockResolvedValue({ kind: "NOT_FOUND" });
    await call("?invoiceId=someone-elses-invoice");
    expect(mocks.prepare).toHaveBeenCalledWith(
      "b1",
      { user: { id: "member-1" } },
      { kind: "INVOICE" },
      { ipAddress: "203.0.113.9", chargeBookingLimit: expect.any(Function) },
    );
  });

  it.each([
    ["NOT_FOUND", 404],
    ["XERO_NOT_CONNECTED", 503],
    ["XERO_UNAVAILABLE", 502],
    ["AUDIT_FAILED", 503],
    ["SETTINGS_UNAVAILABLE", 503],
  ])("answers %s with %i", async (kind, status) => {
    mocks.prepare.mockResolvedValue({ kind });
    expect((await call()).status).toBe(status);
  });
});
