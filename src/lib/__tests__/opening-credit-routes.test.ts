// #4988: the opening-credit routes. Posting and reversing need finance:edit and
// a recent sign-in; the list needs finance:view. Refusals reach the officer as
// the writer's own status and message.
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({ requireAdmin: vi.fn(), requireRecentAuth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: guards.requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth: guards.requireRecentAuth }));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: vi.fn().mockReturnValue({}) }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const writer = vi.hoisted(() => ({ preview: vi.fn(), post: vi.fn(), reverse: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/opening-credit-batch", () => ({
  buildOpeningCreditPreview: writer.preview,
  postOpeningCreditBatch: writer.post,
  reverseOpeningCreditBatch: writer.reverse,
  listOpeningCreditBatches: writer.list,
}));

import { ApiError } from "@/lib/api-error";
import { GET as listBatches } from "@/app/api/admin/opening-credits/route";
import { POST as previewBatch } from "@/app/api/admin/opening-credits/preview/route";
import { POST as confirmBatch } from "@/app/api/admin/opening-credits/confirm/route";
import { POST as reverseBatch } from "@/app/api/admin/opening-credits/[id]/reverse/route";

const KEY = "a".repeat(64);

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const reverseParams = { params: Promise.resolve({ id: "batch-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  guards.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  guards.requireRecentAuth.mockResolvedValue({ ok: true });
});

describe("opening-credit routes (#4988)", () => {
  it("asks for finance:edit to preview, post and reverse, and finance:view to list", async () => {
    writer.preview.mockResolvedValue({ ok: true, preview: { totalCents: 1 } });
    writer.post.mockResolvedValue({ batchId: "batch-1" });
    writer.reverse.mockResolvedValue({ batchId: "batch-1" });
    writer.list.mockResolvedValue([]);
    await previewBatch(post("/api/admin/opening-credits/preview", { csvText: "x" }));
    await confirmBatch(post("/api/admin/opening-credits/confirm", { csvText: "x", batchKey: KEY, totalCents: 1 }));
    await reverseBatch(post("/api/admin/opening-credits/batch-1/reverse", { reason: "r" }), reverseParams);
    await listBatches();
    expect(guards.requireAdmin.mock.calls.map(([options]) => options.permission)).toEqual([
      { area: "finance", level: "edit" },
      { area: "finance", level: "edit" },
      { area: "finance", level: "edit" },
      { area: "finance", level: "view" },
    ]);
    expect(guards.requireRecentAuth).toHaveBeenCalledTimes(3);
  });

  it("stops at the permission guard and the recent-sign-in guard before reading the body", async () => {
    guards.requireAdmin.mockResolvedValueOnce({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const denied = await confirmBatch(post("/api/admin/opening-credits/confirm", { csvText: "x", batchKey: KEY, totalCents: 1 }));
    expect(denied.status).toBe(403);
    guards.requireRecentAuth.mockResolvedValueOnce({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const stale = await reverseBatch(post("/api/admin/opening-credits/batch-1/reverse", { reason: "r" }), reverseParams);
    expect(stale.status).toBe(403);
    expect(writer.post).not.toHaveBeenCalled();
    expect(writer.reverse).not.toHaveBeenCalled();
  });

  it("refuses a confirm without a previewed key and positive whole total", async () => {
    for (const body of [
      { csvText: "x", batchKey: "short", totalCents: 1 },
      { csvText: "x", batchKey: KEY, totalCents: 0 },
      { csvText: "x", batchKey: KEY, totalCents: 1.5 },
      { csvText: "", batchKey: KEY, totalCents: 1 },
    ]) {
      expect((await confirmBatch(post("/api/admin/opening-credits/confirm", body))).status).toBe(400);
    }
    expect(writer.post).not.toHaveBeenCalled();
  });

  it("posts with the signed-in officer and answers 201", async () => {
    writer.post.mockResolvedValue({ batchId: "batch-1", totalCents: 1, rowCount: 1 });
    const res = await confirmBatch(post("/api/admin/opening-credits/confirm", { csvText: "x", batchKey: KEY, totalCents: 1 }));
    expect(res.status).toBe(201);
    expect(writer.post).toHaveBeenCalledWith(
      expect.objectContaining({ csvText: "x", expectedBatchKey: KEY, expectedTotalCents: 1, adminId: "officer-1" }),
    );
  });

  it("returns the writer's refusal as its status and message", async () => {
    writer.post.mockRejectedValue(new ApiError("already posted", 409));
    const posted = await confirmBatch(post("/api/admin/opening-credits/confirm", { csvText: "x", batchKey: KEY, totalCents: 1 }));
    expect(posted.status).toBe(409);
    await expect(posted.json()).resolves.toEqual({ error: "already posted" });

    writer.reverse.mockRejectedValue(new ApiError("some credit is spent", 409));
    const reversed = await reverseBatch(post("/api/admin/opening-credits/batch-1/reverse", { reason: "r" }), reverseParams);
    expect(reversed.status).toBe(409);
  });

  it("answers a preview parse failure with 400", async () => {
    writer.preview.mockResolvedValue({ ok: false, error: "The CSV needs a Member ID or an Email column" });
    const res = await previewBatch(post("/api/admin/opening-credits/preview", { csvText: "x" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "The CSV needs a Member ID or an Email column" });
  });

  it("needs a reason to reverse", async () => {
    const res = await reverseBatch(post("/api/admin/opening-credits/batch-1/reverse", { reason: "   " }), reverseParams);
    expect(res.status).toBe(400);
    expect(writer.reverse).not.toHaveBeenCalled();
  });
});
