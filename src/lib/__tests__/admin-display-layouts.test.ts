import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { BUILT_IN_DISPLAY_LAYOUT_KEYS } from "@/lib/lodge-display/built-in-seeds";

// Issue hoppers99/AlpineClubBookingsNZ#78 (LTV-032): admin lobby-display LAYOUT CRUD — admin guard on every
// method, save-contract validation on create/update (structural errors surface
// the contract's path+message; CSS-sanitiser warnings ride along on an accepted
// save), unique-key 409, immutable key on update, and Restrict-FK-aware delete
// (a layout with templates 409s; a clean one deletes). The real save contract
// runs (not mocked) so the surfaced errors are the ones the wall relies on.

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    displayLayout: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockRequireAdmin: vi.fn(),
}));

// The routes call the server-only save contract; neutralise the client-boundary
// guard so the real contract runs in the node test env.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

const VALID_BODY = {
  key: "board",
  name: "Everyday board",
  description: "The default board",
  bodyHtml: "<main>{{area:hero}}</main>",
  defaultCss: ".hero { color: var(--display-ink); }",
  areas: [{ key: "hero", description: "Hero panel", kind: "static" }],
};

const CREATED_ROW = { id: "layout-1", key: "board", name: "Everyday board" };

async function jsonRequest(url: string, method: string, body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mockPrisma.displayLayout.findMany.mockResolvedValue([
    {
      id: "layout-1",
      key: "board",
      name: "Everyday board",
      description: "The default board",
      updatedAt: new Date("2026-07-12T00:00:00Z"),
      _count: { templates: 2 },
    },
  ]);
  mockPrisma.displayLayout.findUnique.mockResolvedValue(null);
  mockPrisma.displayLayout.create.mockResolvedValue(CREATED_ROW);
  mockPrisma.displayLayout.update.mockResolvedValue(CREATED_ROW);
  mockPrisma.displayLayout.delete.mockResolvedValue(CREATED_ROW);
});

describe("GET/POST /api/admin/display/layouts", () => {
  it("requires an admin session on both methods", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET, POST } = await import("@/app/api/admin/display/layouts/route");
    expect((await GET()).status).toBe(401);
    expect(
      (
        await POST(
          await jsonRequest("http://localhost/api/admin/display/layouts", "POST", VALID_BODY)
        )
      ).status
    ).toBe(401);
    expect(mockPrisma.displayLayout.create).not.toHaveBeenCalled();
  });

  it("lists layouts with a templateCount for the delete-guard UI", async () => {
    const { GET } = await import("@/app/api/admin/display/layouts/route");
    const body = await (await GET()).json();
    expect(body.layouts[0]).toMatchObject({
      id: "layout-1",
      key: "board",
      templateCount: 2,
    });
  });

  it("creates a valid layout (201) and passes warnings through", async () => {
    const { POST } = await import("@/app/api/admin/display/layouts/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", VALID_BODY)
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.layout).toEqual(CREATED_ROW);
    expect(body.warnings).toEqual([]);
    expect(mockPrisma.displayLayout.create).toHaveBeenCalledTimes(1);
  });

  // #2247: the seven built-in KEYS are ordinary slugs — only the seeded ROW ID
  // carries the `builtin-` prefix — so on a never-seeded database (exactly the
  // population "Restore built-in boards" serves) an admin could author their
  // own layout under one, and the restore would upsert BY KEY straight over it
  // while promising custom layouts are untouched. The keys are reserved on
  // create; PUT already 409s on a built-in.
  it("refuses a reserved built-in key on create, without persisting", async () => {
    const { POST } = await import("@/app/api/admin/display/layouts/route");
    for (const key of BUILT_IN_DISPLAY_LAYOUT_KEYS) {
      const res = await POST(
        await jsonRequest("http://localhost/x", "POST", { ...VALID_BODY, key })
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain(key);
      expect(body.error).toMatch(/reserved/i);
    }
    expect(mockPrisma.displayLayout.create).not.toHaveBeenCalled();
  });

  it("surfaces a structural error with the contract's path + message, without persisting", async () => {
    const { POST } = await import("@/app/api/admin/display/layouts/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        ...VALID_BODY,
        bodyHtml: "<main>{{area:missing}}</main>",
        areas: [],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].path).toBe("layout");
    expect(body.errors[0].message).toMatch(/missing/);
    expect(mockPrisma.displayLayout.create).not.toHaveBeenCalled();
  });

  it("returns 409 on a duplicate key", async () => {
    mockPrisma.displayLayout.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    const { POST } = await import("@/app/api/admin/display/layouts/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", VALID_BODY)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/);
  });

  it("accepts the save but warns when the default CSS is auto-sanitised", async () => {
    const { POST } = await import("@/app/api/admin/display/layouts/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        ...VALID_BODY,
        defaultCss: "@import url(https://evil.example/x.css); .hero { color: red; }",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings[0].path).toBe("defaultCss");
    expect(mockPrisma.displayLayout.create).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/admin/display/layouts/[id]", () => {
  beforeEach(() => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue({
      id: "layout-1",
      key: "board",
      name: "Everyday board",
    });
  });

  it("re-validates on update and refuses a broken definition", async () => {
    const { PUT } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        ...VALID_BODY,
        areas: [{ key: "hero", description: "Hero", kind: "rotator" }],
      }),
      routeParams("layout-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe("layout");
    expect(mockPrisma.displayLayout.update).not.toHaveBeenCalled();
  });

  it("rejects a key change (immutable after creation)", async () => {
    const { PUT } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", { ...VALID_BODY, key: "renamed" }),
      routeParams("layout-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/key cannot be changed/i);
    expect(mockPrisma.displayLayout.update).not.toHaveBeenCalled();
  });

  it("updates a valid layout (200)", async () => {
    const { PUT } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("layout-1")
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.displayLayout.update).toHaveBeenCalledTimes(1);
  });

  // §S1: built-in rows are code-managed and read-only — a PUT is refused
  // server-side (duplicate-to-customise, ADR-004), not just hidden in the UI.
  it("refuses a PUT to a built-in layout (409, read-only — duplicate to customise)", async () => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue({
      id: "builtin-layout-everyday-board",
      key: "everyday-board",
      name: "Everyday board",
    });
    const { PUT } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("builtin-layout-everyday-board")
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/read-only — duplicate to customise/i);
    expect(mockPrisma.displayLayout.update).not.toHaveBeenCalled();
  });

  it("404s an unknown layout", async () => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue(null);
    const { PUT } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("ghost")
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/display/layouts/[id]", () => {
  it("409s a layout still used by templates, without deleting", async () => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue({
      id: "layout-1",
      key: "board",
      name: "Everyday board",
      _count: { templates: 3 },
    });
    const { DELETE } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("layout-1")
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot be deleted/i);
    expect(mockPrisma.displayLayout.delete).not.toHaveBeenCalled();
  });

  it("deletes a layout with no templates (200)", async () => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue({
      id: "layout-1",
      key: "board",
      name: "Everyday board",
      _count: { templates: 0 },
    });
    const { DELETE } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("layout-1")
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.displayLayout.delete).toHaveBeenCalledTimes(1);
  });

  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { DELETE } = await import("@/app/api/admin/display/layouts/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("layout-1")
    );
    expect(res.status).toBe(401);
  });
});
