import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { BUILT_IN_DISPLAY_TEMPLATE_KEYS } from "@/lib/lodge-display/built-in-seeds";

// Issue hoppers99/AlpineClubBookingsNZ#79 (LTV-033): admin lobby-display TEMPLATE CRUD — admin guard on every
// method, save-contract validation on create/update (structural errors surface
// the contract's path+message against the BOUND LAYOUT; CSS-sanitiser warnings
// ride along on an accepted save), unique-key 409, immutable key + layout on
// update, and a device-bound-aware delete (a template with devices 409s; a clean
// one deletes). The real save contract runs (not mocked) so the surfaced errors
// are the ones the wall relies on.

const { mockPrisma, mockRequireAdmin } = vi.hoisted(() => ({
  mockPrisma: {
    displayLayout: { findUnique: vi.fn() },
    displayTemplate: {
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

// A layout whose single static area "hero" makes { hero: {...} } a valid slot.
const LAYOUT = {
  bodyHtml: "<main>{{area:hero}}</main>",
  areas: [{ key: "hero", description: "Hero panel", kind: "static" }],
};

const VALID_BODY = {
  key: "foyer",
  name: "Foyer board",
  layoutId: "layout-1",
  slotContent: { hero: { html: "<p>Welcome</p>" } },
  cssOverrides: ".hero { color: var(--brand-gold); }",
  footerHtml: "Wi-Fi: {{config:wifi-code}}",
};

const CREATED_ROW = { id: "tpl-1", key: "foyer", name: "Foyer board" };

async function jsonRequest(url: string, method: string, body?: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
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
  mockPrisma.displayLayout.findUnique.mockResolvedValue(LAYOUT);
  mockPrisma.displayTemplate.findMany.mockResolvedValue([
    {
      id: "tpl-1",
      key: "foyer",
      name: "Foyer board",
      updatedAt: new Date("2026-07-12T00:00:00Z"),
      layout: { id: "layout-1", key: "board", name: "Everyday board" },
      _count: { devices: 2 },
    },
  ]);
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
  mockPrisma.displayTemplate.create.mockResolvedValue(CREATED_ROW);
  mockPrisma.displayTemplate.update.mockResolvedValue(CREATED_ROW);
  mockPrisma.displayTemplate.delete.mockResolvedValue(CREATED_ROW);
});

describe("GET/POST /api/admin/display/templates", () => {
  it("requires an admin session on both methods", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { GET, POST } = await import("@/app/api/admin/display/templates/route");
    expect((await GET()).status).toBe(401);
    expect(
      (
        await POST(
          await jsonRequest("http://localhost/x", "POST", VALID_BODY)
        )
      ).status
    ).toBe(401);
    expect(mockPrisma.displayTemplate.create).not.toHaveBeenCalled();
  });

  it("returns the v2 template rows (with layout + deviceCount) and no built-ins group (LTV-038)", async () => {
    const { GET } = await import("@/app/api/admin/display/templates/route");
    const body = await (await GET()).json();
    // LTV-038 retired the separate built-ins group — the built-ins are seeded
    // v2 rows now, so they arrive in `templates`, not a `builtIns` array.
    expect(body.builtIns).toBeUndefined();
    expect(body.templates[0]).toMatchObject({
      id: "tpl-1",
      key: "foyer",
      layout: { id: "layout-1", name: "Everyday board" },
      deviceCount: 2,
    });
  });

  // #2247: the seven built-in KEYS are ordinary slugs — only the seeded ROW ID
  // carries the `builtin-` prefix — so on a never-seeded database (exactly the
  // population "Restore built-in boards" serves) an admin could author their
  // own template under one, and the restore would upsert BY KEY straight over
  // it while promising custom templates are untouched. The keys are reserved on
  // create; PUT already 409s on a built-in.
  it("refuses a reserved built-in key on create, without persisting", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    for (const key of BUILT_IN_DISPLAY_TEMPLATE_KEYS) {
      const res = await POST(
        await jsonRequest("http://localhost/x", "POST", { ...VALID_BODY, key })
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain(key);
      expect(body.error).toMatch(/reserved/i);
    }
    expect(mockPrisma.displayTemplate.create).not.toHaveBeenCalled();
  });

  it("creates a valid template (201) and passes warnings through", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", VALID_BODY)
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template).toEqual(CREATED_ROW);
    expect(body.warnings).toEqual([]);
    expect(mockPrisma.displayTemplate.create).toHaveBeenCalledTimes(1);
  });

  it("404s when the bound layout does not exist", async () => {
    mockPrisma.displayLayout.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", VALID_BODY)
    );
    expect(res.status).toBe(404);
    expect(mockPrisma.displayTemplate.create).not.toHaveBeenCalled();
  });

  it("surfaces a structural slot error with the contract's path, without persisting", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        ...VALID_BODY,
        slotContent: { ghost: { html: "x" } },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].path).toBe("slotContent");
    expect(body.errors[0].message).toMatch(/ghost/);
    expect(mockPrisma.displayTemplate.create).not.toHaveBeenCalled();
  });

  it("returns 409 on a duplicate key", async () => {
    mockPrisma.displayTemplate.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", VALID_BODY)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/);
  });

  it("accepts the save but warns when the CSS overrides are auto-sanitised", async () => {
    const { POST } = await import("@/app/api/admin/display/templates/route");
    const res = await POST(
      await jsonRequest("http://localhost/x", "POST", {
        ...VALID_BODY,
        cssOverrides: "@import url(https://evil.example/x.css); .hero { color: red; }",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings[0].path).toBe("cssOverrides");
    expect(mockPrisma.displayTemplate.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET/PUT /api/admin/display/templates/[id]", () => {
  beforeEach(() => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      id: "tpl-1",
      key: "foyer",
      name: "Foyer board",
      layoutId: "layout-1",
      slotContent: { hero: { html: "<p>Welcome</p>" } },
      cssOverrides: "",
      footerHtml: "",
      createdAt: new Date("2026-07-12T00:00:00Z"),
      updatedAt: new Date("2026-07-12T00:00:00Z"),
      layout: {
        id: "layout-1",
        key: "board",
        name: "Everyday board",
        bodyHtml: LAYOUT.bodyHtml,
        areas: LAYOUT.areas,
      },
      _count: { devices: 0 },
    });
  });

  it("returns the full row plus its layout's areas for the slot boxes", async () => {
    const { GET } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await GET(
      await jsonRequest("http://localhost/x", "GET"),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.layout.areas[0].key).toBe("hero");
    expect(body.template.slotContent.hero.html).toBe("<p>Welcome</p>");
  });

  it("re-validates on update and refuses an unknown slot key", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        ...VALID_BODY,
        slotContent: { ghost: { html: "x" } },
      }),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe("slotContent");
    expect(mockPrisma.displayTemplate.update).not.toHaveBeenCalled();
  });

  it("rejects a key change (immutable after creation)", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", { ...VALID_BODY, key: "renamed" }),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/key cannot be changed/i);
    expect(mockPrisma.displayTemplate.update).not.toHaveBeenCalled();
  });

  it("rejects a layout change (immutable after creation)", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", {
        ...VALID_BODY,
        layoutId: "layout-2",
      }),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/layout cannot be changed/i);
    expect(mockPrisma.displayTemplate.update).not.toHaveBeenCalled();
  });

  it("updates a valid template (200)", async () => {
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.displayTemplate.update).toHaveBeenCalledTimes(1);
  });

  // §S1: built-in rows are code-managed and read-only — a PUT is refused
  // server-side (duplicate-to-customise, ADR-004), not just hidden in the UI.
  it("refuses a PUT to a built-in template (409, read-only — duplicate to customise)", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      id: "builtin-template-everyday-board",
      key: "everyday-board",
      name: "Everyday board",
      layoutId: "layout-1",
      layout: { bodyHtml: LAYOUT.bodyHtml, areas: LAYOUT.areas },
    });
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("builtin-template-everyday-board")
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/read-only — duplicate to customise/i);
    expect(mockPrisma.displayTemplate.update).not.toHaveBeenCalled();
  });

  it("404s an unknown template", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { PUT } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await PUT(
      await jsonRequest("http://localhost/x", "PUT", VALID_BODY),
      routeParams("ghost")
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/display/templates/[id]", () => {
  it("409s a template still bound to a device, without deleting", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      id: "tpl-1",
      key: "foyer",
      name: "Foyer board",
      _count: { devices: 3 },
    });
    const { DELETE } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot be deleted/i);
    expect(mockPrisma.displayTemplate.delete).not.toHaveBeenCalled();
  });

  it("deletes a template with no devices (200)", async () => {
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      id: "tpl-1",
      key: "foyer",
      name: "Foyer board",
      _count: { devices: 0 },
    });
    const { DELETE } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.displayTemplate.delete).toHaveBeenCalledTimes(1);
  });

  it("requires an admin session", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { DELETE } = await import("@/app/api/admin/display/templates/[id]/route");
    const res = await DELETE(
      await jsonRequest("http://localhost/x", "DELETE"),
      routeParams("tpl-1")
    );
    expect(res.status).toBe(401);
  });
});
