import { beforeEach, describe, expect, it, vi } from "vitest";

// The route now also imports the draft-render path (ADR-004 §7), which pulls in
// `server-only` (via buildLayoutRender / the save contract / the draft store);
// stub it so the route module evaluates in the test's node context.
vi.mock("server-only", () => ({}));

// LTV-036 (ADR-003 §5): the admin-only preview-grant endpoint mints the
// short-lived, signed capability the sandboxed preview iframe carries in place
// of a session. Admin guard, lodge validation (explicit or default), template
// existence, and a real signed token that the state route's decoder accepts.

const { mockPrisma, mockRequireAdmin, mockResolveOptionalLodge } = vi.hoisted(
  () => ({
    mockPrisma: {
      displayTemplate: { findUnique: vi.fn() },
      lodge: { findUnique: vi.fn() },
    },
    mockRequireAdmin: vi.fn(),
    mockResolveOptionalLodge: vi.fn(),
  })
);

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: (...args: unknown[]) =>
    mockResolveOptionalLodge(...args),
}));

async function jsonRequest(body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest("http://localhost/api/admin/display/preview-grant", {
    method: "POST",
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-display-secret";
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mockResolveOptionalLodge.mockResolvedValue("lodge-b");
  mockPrisma.displayTemplate.findUnique.mockResolvedValue({ id: "tpl-1" });
  mockPrisma.lodge.findUnique.mockResolvedValue({ id: "lodge-b", name: "Ruapehu Lodge" });
});

describe("POST /api/admin/display/preview-grant", () => {
  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const res = await POST(await jsonRequest({ templateId: "tpl-1" }));
    expect(res.status).toBe(401);
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });

  it("mints a grant the state route's decoder accepts, echoing the lodge", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const { decodePreviewGrant } = await import("@/lib/lodge-display-auth");

    const res = await POST(
      await jsonRequest({ templateId: "tpl-1", previewLodge: "lodge-b" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      lodgeId: string;
      lodgeName: string;
    };
    expect(body.lodgeId).toBe("lodge-b");
    expect(body.lodgeName).toBe("Ruapehu Lodge");

    const decoded = decodePreviewGrant(body.token);
    expect(decoded).toMatchObject({ templateId: "tpl-1", lodgeId: "lodge-b" });
    // Five-minute horizon.
    expect(decoded!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(decoded!.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });

  it("carries an optional simulated date into the grant", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const { decodePreviewGrant } = await import("@/lib/lodge-display-auth");
    const res = await POST(
      await jsonRequest({ templateId: "tpl-1", previewDate: "2026-08-01", previewLodge: "lodge-b" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(decodePreviewGrant(body.token)).toMatchObject({
      windowStart: "2026-08-01",
    });
  });

  it("400s a simulated date that is not a real calendar day", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const res = await POST(
      await jsonRequest({ templateId: "tpl-1", previewDate: "2026-02-30", previewLodge: "lodge-b" })
    );
    expect(res.status).toBe(400);
    expect(mockResolveOptionalLodge).not.toHaveBeenCalled();
  });

  it("404s an unknown template", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const res = await POST(await jsonRequest({ templateId: "ghost", previewLodge: "lodge-b" }));
    expect(res.status).toBe(404);
  });

  it("400s an unknown or inactive lodge", async () => {
    mockResolveOptionalLodge.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const res = await POST(
      await jsonRequest({ templateId: "tpl-1", previewLodge: "ghost" })
    );
    expect(res.status).toBe(400);
  });

  it("mints a template-less grant (lodge board) when templateId is omitted", async () => {
    const { POST } = await import("@/app/api/admin/display/preview-grant/route");
    const { decodePreviewGrant } = await import("@/lib/lodge-display-auth");
    const res = await POST(await jsonRequest({ previewLodge: "lodge-b" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(decodePreviewGrant(body.token)).toMatchObject({
      templateId: null,
      lodgeId: "lodge-b",
    });
    // No template lookup when none was requested.
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });
});
