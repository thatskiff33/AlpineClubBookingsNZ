// #5005 (child C): the paid-booking import routes. Confirming, reversing and
// the dry run need ONE officer holding finance edit AND bookings edit (O4);
// the reads need view on both. The route map files the paths under finance
// (the inferred side), each handler passes finance to requireAdmin (the
// declared side) and checks bookings itself. A dry run never reaches the
// writer, and a stale digest writes nothing and returns the fresh preview.
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({ requireAdmin: vi.fn(), requireRecentAuth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: guards.requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: guards.requireRecentAuth }));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockResolvedValue(null), getClientIp: vi.fn().mockReturnValue("127.0.0.1") }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/club-time/server", () => ({ clubTime: vi.fn().mockResolvedValue({ today: () => "2026-07-01" }) }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn().mockResolvedValue({ locale: "en-NZ", currency: "NZD" }) }));

const engine = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn(), reverse: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/booking-import/batches", () => ({
  previewBookingImport: engine.preview,
  listBookingImportBatches: engine.list,
  getBookingImportBatch: engine.get,
}));
vi.mock("@/lib/booking-import/write", () => ({ confirmBookingImport: engine.confirm }));
vi.mock("@/lib/booking-import/reverse", () => ({ reverseBookingImport: engine.reverse }));

import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { GET as listBatches } from "@/app/api/admin/bookings/import/batches/route";
import { GET as getBatch } from "@/app/api/admin/bookings/import/batches/[id]/route";
import { POST as reverseBatch } from "@/app/api/admin/bookings/import/batches/[id]/reverse/route";
import { POST as confirmImport } from "@/app/api/admin/bookings/import/confirm/route";
import { POST as previewImport } from "@/app/api/admin/bookings/import/preview/route";

const CSV = [
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid",
  "B1,ann@example.invalid,Ann,Owner,Member,ann@example.invalid,Ann,Owner,,2026-08-10,2026-08-12,100",
].join("\n");
const DIGEST = "d".repeat(64);
const FILE = { lodgeId: "lodge-1", csvText: CSV, dateFormat: "yyyy-MM-dd" };
const batchParams = { params: Promise.resolve({ id: "batch-1" }) };

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function officer(matrix: Record<string, string>) {
  return { ok: true, session: { user: { id: "officer-1", adminPermissionMatrix: matrix } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  guards.requireAdmin.mockResolvedValue(officer({ finance: "edit", bookings: "edit" }));
  guards.requireRecentAuth.mockResolvedValue({ ok: true });
});

describe("paid-booking import routes (#5005 child C)", () => {
  it("files every import path under finance, at edit for a write and view for a read (the inferred side)", () => {
    expect(getAdminRouteRequirement("/api/admin/bookings/import/preview", "POST")).toEqual({ area: "finance", level: "edit" });
    expect(getAdminRouteRequirement("/api/admin/bookings/import/confirm", "POST")).toEqual({ area: "finance", level: "edit" });
    expect(getAdminRouteRequirement("/api/admin/bookings/import/batches/b/reverse", "POST")).toEqual({ area: "finance", level: "edit" });
    expect(getAdminRouteRequirement("/api/admin/bookings/import/batches", "GET")).toEqual({ area: "finance", level: "view" });
    expect(getAdminRouteRequirement("/api/admin/bookings/import/batches/b", "GET")).toEqual({ area: "finance", level: "view" });
    // An ordinary booking route stays bookings.
    expect(getAdminRouteRequirement("/api/admin/bookings/b1/copy", "POST")).toEqual({ area: "bookings", level: "edit" });
  });

  it("passes finance to requireAdmin (the declared side) and asks for a recent sign-in on every write", async () => {
    engine.preview.mockResolvedValue({ plan: {}, existingBatch: null });
    engine.confirm.mockResolvedValue({ outcome: "completed", batchId: "batch-1", rows: [], remaining: 0 });
    engine.reverse.mockResolvedValue({ outcome: "reversed", batchId: "batch-1", rows: [], remaining: 0 });
    engine.list.mockResolvedValue([]);
    engine.get.mockResolvedValue({ batch: {}, reversal: {} });
    await previewImport(post("/api/admin/bookings/import/preview", FILE));
    await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: DIGEST }));
    await reverseBatch(post("/api/admin/bookings/import/batches/batch-1/reverse", {}), batchParams);
    await listBatches();
    await getBatch(new NextRequest("http://localhost/api/admin/bookings/import/batches/batch-1"), batchParams);
    expect(guards.requireAdmin.mock.calls.map(([options]) => options.permission)).toEqual([
      { area: "finance", level: "edit" },
      { area: "finance", level: "edit" },
      { area: "finance", level: "edit" },
      { area: "finance", level: "view" },
      { area: "finance", level: "view" },
    ]);
    expect(guards.requireRecentAuth).toHaveBeenCalledTimes(3);
  });

  it("refuses an officer with finance edit but only bookings view, before reading the body (O4)", async () => {
    guards.requireAdmin.mockResolvedValue(officer({ finance: "edit", bookings: "view" }));
    for (const response of [
      await previewImport(post("/api/admin/bookings/import/preview", FILE)),
      await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: DIGEST })),
      await reverseBatch(post("/api/admin/bookings/import/batches/batch-1/reverse", {}), batchParams),
    ]) {
      expect(response.status).toBe(403);
    }
    guards.requireAdmin.mockResolvedValue(officer({ finance: "view" }));
    expect((await listBatches()).status).toBe(403);
    expect(engine.preview).not.toHaveBeenCalled();
    expect(engine.confirm).not.toHaveBeenCalled();
    expect(engine.reverse).not.toHaveBeenCalled();
    expect(engine.list).not.toHaveBeenCalled();
  });

  it("stops at requireAdmin's refusal", async () => {
    guards.requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    expect((await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: DIGEST }))).status).toBe(403);
    expect(engine.confirm).not.toHaveBeenCalled();
  });

  it("previews without ever reaching the writer, on the club's day", async () => {
    engine.preview.mockResolvedValue({ plan: { digest: DIGEST }, existingBatch: null });
    const res = await previewImport(post("/api/admin/bookings/import/preview", FILE));
    expect(res.status).toBe(200);
    expect(engine.preview).toHaveBeenCalledWith(expect.objectContaining({
      lodgeId: "lodge-1",
      today: new Date("2026-07-01T00:00:00.000Z"),
      bookings: [expect.objectContaining({ bookingRef: "B1", totalCents: 10_000 })],
    }));
    expect(engine.confirm).not.toHaveBeenCalled();
    expect(engine.reverse).not.toHaveBeenCalled();
  });

  it("reads the officer's column mapping and refuses a file it cannot read", async () => {
    engine.preview.mockResolvedValue({ plan: {}, existingBatch: null });
    // The mapping moves Booking Ref onto a column the file does not have.
    const bad = await previewImport(post("/api/admin/bookings/import/preview", { ...FILE, columnMapping: { bookingRef: 40 } }));
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual({ error: '"Booking Ref" is mapped to a column the file does not have' });
    const unknownColumn = await previewImport(post("/api/admin/bookings/import/preview", { ...FILE, columnMapping: { nickname: 1 } }));
    expect(unknownColumn.status).toBe(400);
    expect(engine.preview).not.toHaveBeenCalled();
  });

  it("returns a stale confirm as 409 with the fresh preview, and confirms in bounded slices", async () => {
    engine.confirm.mockResolvedValueOnce({ outcome: "stale", plan: { digest: "e".repeat(64) } });
    const stale = await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: DIGEST }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ plan: { digest: "e".repeat(64) } });

    engine.confirm.mockResolvedValueOnce({
      outcome: "completed",
      batchId: "batch-1",
      remaining: 3,
      rows: [
        { bookingRef: "B1", outcome: "IMPORTED", bookingId: "b1" },
        { bookingRef: "B2", outcome: "REFUSED", refusals: [] },
        { bookingRef: "B3", outcome: "REFUSED", refusals: [] },
        { bookingRef: "B4", outcome: "REFUSED", refusals: [] },
        { bookingRef: "B5", outcome: "REFUSED", refusals: [] },
      ],
    });
    const slice = await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: DIGEST }));
    await expect(slice.json()).resolves.toEqual({ batchId: "batch-1", remaining: 3, imported: 1, refused: 1 });
    expect(engine.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ digest: DIGEST, officerMemberId: "officer-1", maxBookings: 20 }));
  });

  it("refuses a confirm without a preview digest", async () => {
    expect((await confirmImport(post("/api/admin/bookings/import/confirm", FILE))).status).toBe(400);
    expect((await confirmImport(post("/api/admin/bookings/import/confirm", { ...FILE, digest: "short" }))).status).toBe(400);
    expect(engine.confirm).not.toHaveBeenCalled();
  });

  it("answers a reversal's refusals plainly", async () => {
    engine.reverse.mockResolvedValueOnce({ outcome: "not_completed" });
    expect((await reverseBatch(post("/api/admin/bookings/import/batches/batch-1/reverse", {}), batchParams)).status).toBe(409);
    engine.reverse.mockResolvedValueOnce({ outcome: "not_found" });
    expect((await reverseBatch(post("/api/admin/bookings/import/batches/batch-1/reverse", {}), batchParams)).status).toBe(404);
    expect(engine.reverse).toHaveBeenLastCalledWith(expect.objectContaining({ batchId: "batch-1", officerMemberId: "officer-1", maxBookings: 20 }));
  });
});
