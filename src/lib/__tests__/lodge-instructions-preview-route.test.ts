import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verifyHutLeaderPinForAssignment: vi.fn(),
  getLodgePinLockout: vi.fn(),
  recordLodgePinFailure: vi.fn(),
  clearLodgePinFailures: vi.fn(),
  applyRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
  getSanitizedLodgeInstructions: vi.fn(),
  lodgeInstructionFindMany: vi.fn(),
}));

vi.mock("@/lib/lodge-pin-session", () => ({
  verifyHutLeaderPinForAssignment: mocks.verifyHutLeaderPinForAssignment,
  getLodgePinLockout: mocks.getLodgePinLockout,
  recordLodgePinFailure: mocks.recordLodgePinFailure,
  clearLodgePinFailures: mocks.clearLodgePinFailures,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  getClientIp: mocks.getClientIp,
  rateLimiters: { lodgePinLogin: { id: "lodge-pin-login" } },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/lodge-instructions", () => ({
  getSanitizedLodgeInstructions: mocks.getSanitizedLodgeInstructions,
}));
// Read only by the one case that lets the real reader run (#5345).
vi.mock("@/lib/prisma", () => ({
  prisma: { lodgeInstruction: { findMany: mocks.lodgeInstructionFindMany } },
}));

import { POST } from "@/app/api/lodge/instructions/preview/route";
import {
  expectStoredHeadingOneDemoted,
  storedInstructionWithH1,
} from "./support/stored-heading-one";

const DOCS = [
  { key: "OPEN", title: "Opening the Lodge", description: "", contentHtml: "<p>Turn on the gas</p>", updatedAt: null },
];

function req(body: unknown) {
  return new NextRequest("http://localhost/api/lodge/instructions/preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClientIp.mockReturnValue("1.2.3.4");
  mocks.getAuditRequestContext.mockReturnValue({ ipAddress: "1.2.3.4", id: "req-1", userAgent: "test" });
  mocks.getLodgePinLockout.mockReturnValue({ locked: false, retryAfter: 0 });
  mocks.applyRateLimit.mockResolvedValue(null);
  mocks.recordLodgePinFailure.mockReturnValue({ locked: false, count: 1, retryAfter: 0 });
  mocks.getSanitizedLodgeInstructions.mockResolvedValue(DOCS);
});

describe("POST /api/lodge/instructions/preview (#1642)", () => {
  it("returns only the sanitised instructions for the assignment's lodge on a correct PIN", async () => {
    mocks.verifyHutLeaderPinForAssignment.mockResolvedValue({
      id: "assign-1",
      memberId: "mem-1",
      lodgeId: "lodge-b",
    });

    const res = await POST(req({ assignmentId: "assign-1", pin: "123456" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ documents: DOCS });
    // Scoped strictly to the assignment's own lodge.
    expect(mocks.getSanitizedLodgeInstructions).toHaveBeenCalledWith({ lodgeId: "lodge-b" });
    // Success clears the IP failure counter.
    expect(mocks.clearLodgePinFailures).toHaveBeenCalledWith("1.2.3.4");
    // Nothing but documents in the payload.
    expect(Object.keys(body)).toEqual(["documents"]);
  });

  it("returns an author's h1 demoted, through the real reader (#5345)", async () => {
    // Every other case stubs the reader. This one runs the real one over a
    // stored row, so the route cannot start serving the stored HTML unnoticed.
    const reader = (await vi.importActual(
      "@/lib/lodge-instructions",
    )) as typeof import("@/lib/lodge-instructions");
    mocks.getSanitizedLodgeInstructions.mockImplementation(reader.getSanitizedLodgeInstructions);
    mocks.lodgeInstructionFindMany.mockResolvedValue([storedInstructionWithH1()]);
    mocks.verifyHutLeaderPinForAssignment.mockResolvedValue({
      id: "assign-1",
      memberId: "mem-1",
      lodgeId: "lodge-b",
    });

    const res = await POST(req({ assignmentId: "assign-1", pin: "123456" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: { key: string; contentHtml: string }[] };
    expectStoredHeadingOneDemoted(
      body.documents.find((doc) => doc.key === "OPEN")?.contentHtml ?? "",
    );
  });

  it("rejects a wrong PIN with 401 and records an IP failure", async () => {
    mocks.verifyHutLeaderPinForAssignment.mockResolvedValue(null);

    const res = await POST(req({ assignmentId: "assign-1", pin: "000000" }));
    expect(res.status).toBe(401);
    expect(mocks.recordLodgePinFailure).toHaveBeenCalledWith("1.2.3.4");
    expect(mocks.getSanitizedLodgeInstructions).not.toHaveBeenCalled();
  });

  it("returns 429 when the failure that just happened triggers the lockout", async () => {
    mocks.verifyHutLeaderPinForAssignment.mockResolvedValue(null);
    mocks.recordLodgePinFailure.mockReturnValue({ locked: true, count: 10, retryAfter: 900 });

    const res = await POST(req({ assignmentId: "assign-1", pin: "000000" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
  });

  it("blocks up front with 429 when the IP is already locked out (no PIN check)", async () => {
    mocks.getLodgePinLockout.mockReturnValue({ locked: true, retryAfter: 600 });

    const res = await POST(req({ assignmentId: "assign-1", pin: "123456" }));
    expect(res.status).toBe(429);
    expect(mocks.verifyHutLeaderPinForAssignment).not.toHaveBeenCalled();
  });

  it("honours the rate limiter", async () => {
    mocks.applyRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })
    );
    const res = await POST(req({ assignmentId: "assign-1", pin: "123456" }));
    expect(res.status).toBe(429);
    expect(mocks.verifyHutLeaderPinForAssignment).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 before any verification", async () => {
    const res = await POST(req({ assignmentId: "assign-1", pin: "12" }));
    expect(res.status).toBe(400);
    expect(mocks.verifyHutLeaderPinForAssignment).not.toHaveBeenCalled();
  });
});
