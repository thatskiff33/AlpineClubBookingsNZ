import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** #5066 slice 1: the invoice route's guards and its answer for each download outcome. */
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
  rateLimiters: { bookingQuery: { id: "booking-query" } },
}));
vi.mock("@/app/(authenticated)/bookings/[id]/_lib/booking-invoice-download", () => ({
  prepareBookingInvoiceDownload: mocks.prepare,
}));

import { GET } from "../route";

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
    expect(mocks.checkRateLimit).toHaveBeenCalledWith({ id: "booking-query" }, "booking-invoice:member-1");
  });

  it("serves the PDF privately, uncached, as an attachment", async () => {
    mocks.prepare.mockResolvedValue({ kind: "PDF", body: Buffer.from("%PDF"), fileName: "Invoice-INV-0042.pdf" });
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="Invoice-INV-0042.pdf"');
  });

  it("passes no caller-supplied invoice id through: only the booking id and the session", async () => {
    mocks.prepare.mockResolvedValue({ kind: "NOT_FOUND" });
    await call("?invoiceId=someone-elses-invoice");
    expect(mocks.prepare).toHaveBeenCalledWith("b1", { user: { id: "member-1" } }, { ipAddress: "203.0.113.9" });
  });

  it.each([
    ["NOT_FOUND", 404],
    ["XERO_NOT_CONNECTED", 503],
    ["XERO_UNAVAILABLE", 502],
    ["AUDIT_FAILED", 503],
  ])("answers %s with %i", async (kind, status) => {
    mocks.prepare.mockResolvedValue({ kind });
    expect((await call()).status).toBe(status);
  });
});
