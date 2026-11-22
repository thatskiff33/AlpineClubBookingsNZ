import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue hoppers99/AlpineClubBookingsNZ#52 (LTV-013): the /api/display/state auth matrix. The route serves
// two callers — a paired device (whose poll doubles as the heartbeat) and an
// admin preview (?previewDevice / ?preview) which must be read-only: it never
// stamps lastSeenAt and is honoured only for a full-admin session.

const {
  mockPrisma,
  mockAuth,
  mockCheckDisplayAuth,
  mockDecodeGrant,
  mockBuildDisplayState,
  mockResolveTemplate,
  mockResolveForDevice,
  mockGetDefaultLodgeId,
  mockResolveOptionalLodge,
  mockGetWebsiteTheme,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrisma: {
    member: { findUnique: vi.fn() },
    lodgeDisplayDevice: { findUnique: vi.fn(), update: vi.fn() },
    displayTemplate: { findUnique: vi.fn() },
    $queryRaw: vi.fn().mockRejectedValue(new Error("no shared store in tests")),
    $executeRaw: vi
      .fn()
      .mockRejectedValue(new Error("no shared store in tests")),
  },
  mockAuth: vi.fn(),
  mockCheckDisplayAuth: vi.fn(),
  mockDecodeGrant: vi.fn(),
  mockBuildDisplayState: vi.fn(),
  mockResolveTemplate: vi.fn(),
  mockResolveForDevice: vi.fn(),
  mockGetDefaultLodgeId: vi.fn(),
  mockResolveOptionalLodge: vi.fn(),
  mockGetWebsiteTheme: vi.fn(),
  mockLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The layoutRender path (LTV-027) exercises the REAL layout validator +
// sanitiser (page-content-html), so it is not mocked — but page-content-html
// pulls in `server-only`, which throws outside an RSC context; stub it.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/lodge-display-auth", () => ({
  checkDisplayAuth: (...args: unknown[]) => mockCheckDisplayAuth(...args),
  decodePreviewGrant: (...args: unknown[]) => mockDecodeGrant(...args),
}));
vi.mock("@/lib/lodge-display-state", () => ({
  buildDisplayState: (...args: unknown[]) => mockBuildDisplayState(...args),
}));
vi.mock("@/lib/lodge-display/template-resolution", () => ({
  resolveDisplayTemplate: (...args: unknown[]) => mockResolveTemplate(...args),
  resolveDisplayTemplateForDevice: (...args: unknown[]) =>
    mockResolveForDevice(...args),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...args: unknown[]) => mockGetDefaultLodgeId(...args),
  resolveOptionalActiveLodgeId: (...args: unknown[]) =>
    mockResolveOptionalLodge(...args),
}));
// The v2 layoutRender path (LTV-029) reads the club theme for the read-only
// `themeCss` variable block; mock it so no DB is touched.
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: () => mockGetWebsiteTheme(),
}));
// LTV-030: a broken v2 binding logs at warn level; assert against the mock.
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

const STATE = { lodge: { name: "Silverpeak Lodge" }, rooms: [] };
const TEMPLATE = { key: "everyday-board", definition: { regions: [] } };
const ADMIN_MEMBER = {
  id: "admin-1",
  active: true,
  canLogin: true,
  accessRoles: [{ role: "ADMIN" }],
};
const PLAIN_MEMBER = {
  id: "member-1",
  active: true,
  canLogin: true,
  accessRoles: [{ role: "USER" }],
};
// #2383: cancellation, archive, deletion and bulk deactivate all leave the
// ADMIN row in place and none of them invalidates the session, so an ex-admin's
// live JWT still presents the role. Account state, not the rows, is what must
// stop them — and the two flags are separable, so both are pinned.
const DEACTIVATED_ADMIN = {
  id: "admin-2",
  active: false,
  canLogin: true,
  accessRoles: [{ role: "ADMIN" }],
};
const DELOGINED_ADMIN = {
  id: "admin-3",
  active: true,
  canLogin: false,
  accessRoles: [{ role: "ADMIN" }],
};
const DEVICE_AUTH = {
  device: {
    id: "dev-1",
    lodgeId: "lodge-a",
    name: "Lobby TV",
    templateId: null,
    pollSeconds: null,
  },
};

let nextIp = 1;
async function stateRequest(query = "") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://localhost/api/display/state${query}`, {
    headers: { "x-forwarded-for": `10.52.0.${(nextIp++ % 250) + 1}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckDisplayAuth.mockResolvedValue(null);
  mockDecodeGrant.mockReturnValue(null);
  mockResolveOptionalLodge.mockResolvedValue("lodge-default");
  mockAuth.mockResolvedValue(null);
  mockPrisma.member.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue(null);
  mockPrisma.lodgeDisplayDevice.update.mockResolvedValue({});
  mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
  mockBuildDisplayState.mockResolvedValue(STATE);
  // Template resolution is synchronous (LTV-024 — code built-ins, no DB).
  mockResolveTemplate.mockReturnValue(TEMPLATE);
  mockResolveForDevice.mockReturnValue(TEMPLATE);
  mockGetDefaultLodgeId.mockResolvedValue("lodge-default");
  mockGetWebsiteTheme.mockResolvedValue({
    css: ":root,.website-theme{--brand-gold:#8fa87c;}",
  });
});

describe("GET /api/display/state — device path", () => {
  it("serves the device's lodge and stamps lastSeenAt (the poll is the heartbeat)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-a", {
      days: null,
    });
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalledWith({
      where: { id: "dev-1" },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it("returns 401 without a token and updates nothing", async () => {
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest());
    expect(res.status).toBe(401);
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("serves the device's configured pollSeconds on the payload (LTV-039)", async () => {
    mockCheckDisplayAuth.mockResolvedValue({
      device: { ...DEVICE_AUTH.device, pollSeconds: 20 },
    });
    const { GET } = await import("@/app/api/display/state/route");
    const body = await (await GET(await stateRequest())).json();
    expect(body.pollSeconds).toBe(20);
  });

  it("defaults pollSeconds to 60 when the device has none", async () => {
    mockCheckDisplayAuth.mockResolvedValue({
      device: { ...DEVICE_AUTH.device, pollSeconds: null },
    });
    const { GET } = await import("@/app/api/display/state/route");
    const body = await (await GET(await stateRequest())).json();
    expect(body.pollSeconds).toBe(60);
  });

  it("clamps an out-of-range persisted pollSeconds into 15–600", async () => {
    const { GET } = await import("@/app/api/display/state/route");

    mockCheckDisplayAuth.mockResolvedValue({
      device: { ...DEVICE_AUTH.device, pollSeconds: 5 },
    });
    expect((await (await GET(await stateRequest())).json()).pollSeconds).toBe(15);

    mockCheckDisplayAuth.mockResolvedValue({
      device: { ...DEVICE_AUTH.device, pollSeconds: 9999 },
    });
    expect((await (await GET(await stateRequest())).json()).pollSeconds).toBe(600);
  });
});

describe("GET /api/display/state — admin preview (issue hoppers99/AlpineClubBookingsNZ#52)", () => {
  function loginAs(member: typeof ADMIN_MEMBER) {
    mockAuth.mockResolvedValue({ user: { id: member.id } });
    mockPrisma.member.findUnique.mockResolvedValue(member);
  }

  it("rejects a preview without a session", async () => {
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(401);
  });

  it("rejects a preview from a non-admin session", async () => {
    loginAs(PLAIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?previewDevice=dev-1"));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("rejects a preview from a deactivated admin who still holds the row (#2383)", async () => {
    // Every other auth()-using admin route re-reads `active`; this one did not,
    // and #2383 made the gap reachable by letting a member keep the ADMIN row
    // through cancellation. The row alone must not be enough.
    loginAs(DEACTIVATED_ADMIN);
    const { GET } = await import("@/app/api/display/state/route");
    // ?preview=1 needs no device row, so a 200 here would mean the auth gate
    // let them through — not that some later lookup happened to fail.
    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("rejects a preview from an admin whose login has been disabled (#2383)", async () => {
    // Only true if the query selects canLogin: hasAdminAccess is login-aware,
    // but an unselected field arrives undefined and resolves the full bundle.
    loginAs(DELOGINED_ADMIN);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
    // Prisma is mocked, so the fixture carries canLogin whatever the query
    // asks for; assert the query itself, since an unselected field arrives
    // undefined in production and hasAdminAccess then resolves the full bundle.
    expect(mockPrisma.member.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ active: true, canLogin: true }),
      }),
    );
  });

  it("previewDevice serves that device's lodge and template WITHOUT stamping lastSeenAt", async () => {
    loginAs(ADMIN_MEMBER);
    mockPrisma.lodgeDisplayDevice.findUnique.mockResolvedValue({
      lodgeId: "lodge-b",
      templateId: "tpl-1",
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDevice=dev-9"));
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-b", {
      days: null,
      windowStart: null,
    });
    // The legacy fallback `template` field always resolves to the club default
    // now (the device templateKey column is gone, hoppers99/AlpineClubBookingsNZ#86).
    expect(mockResolveForDevice).toHaveBeenCalledWith({ templateKey: null });
    // Read-only by construction: a preview must never look like a live screen.
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
    // A preview always gets the default cadence, never a device's custom one.
    const body = await res.json();
    expect(body.pollSeconds).toBe(60);
  });

  it("rejects a preview of an unknown device", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?previewDevice=missing"));
    expect(res.status).toBe(401);
  });

  it("?preview=1 serves the default lodge on the club-default fallback board", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-default", {
      days: null,
      windowStart: null,
    });
    // The legacy templateKey preview param was removed in hoppers99/AlpineClubBookingsNZ#86 (LTV-040); a
    // bare ?preview=1 always renders the club-default board.
    expect(mockResolveForDevice).toHaveBeenCalledWith({ templateKey: null });
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("a paired device wins over preview parameters (device path first)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDevice=dev-9"));
    expect(res.status).toBe(200);
    // The device cookie's lodge, not the preview target.
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-a", {
      days: null,
    });
  });

  it("?previewDate simulates the window start for an admin preview (issue hoppers99/AlpineClubBookingsNZ#60)", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&previewDate=2026-08-01"));
    expect(res.status).toBe(200);
    const [, options] = mockBuildDisplayState.mock.calls[0];
    expect(options.windowStart).toBeInstanceOf(Date);
    expect((options.windowStart as Date).toISOString().slice(0, 10)).toBe(
      "2026-08-01"
    );
  });

  it("a malformed previewDate falls back to today silently", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&previewDate=next-week"));
    expect(res.status).toBe(200);
    const [, options] = mockBuildDisplayState.mock.calls[0];
    expect(options.windowStart ?? null).toBeNull();
  });

  it("a right-shaped previewDate for a day that does not exist falls back to today (ALP-580)", async () => {
    loginAs(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    // The first two have the right pattern but no such day, and `parseDateOnly`
    // would turn them into an Invalid Date the serialiser then uses. The last two
    // are loose shapes, which were already refused.
    for (const previewDate of ["2026-02-30", "2026-02-29", "20260801", "2026-8-1"]) {
      mockBuildDisplayState.mockClear();
      const res = await GET(await stateRequest(`?preview=1&previewDate=${previewDate}`));
      expect(res.status, previewDate).toBe(200);
      const [, options] = mockBuildDisplayState.mock.calls[0];
      expect(options.windowStart ?? null, previewDate).toBeNull();
    }
  });

  it("never honours previewDate on a device-token fetch (device path is date-blind)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewDate=2026-08-01"));
    expect(res.status).toBe(200);
    const [lodgeId, options] = mockBuildDisplayState.mock.calls[0];
    expect(lodgeId).toBe("lodge-a");
    expect(options.windowStart ?? null).toBeNull();
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalled();
  });
});

describe("GET /api/display/state — authored template preview (LTV-036)", () => {
  function loginAsAdmin() {
    mockAuth.mockResolvedValue({ user: { id: ADMIN_MEMBER.id } });
    mockPrisma.member.findUnique.mockResolvedValue(ADMIN_MEMBER);
  }

  it("?preview=1&templateId renders that template against the EXPLICIT previewLodge", async () => {
    loginAsAdmin();
    mockResolveOptionalLodge.mockResolvedValue("lodge-b");
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(
      await stateRequest("?preview=1&templateId=tpl-7&previewLodge=lodge-b")
    );
    expect(res.status).toBe(200);
    // The lodge is validated, never a silent default (hoppers99/AlpineClubBookingsNZ#64).
    expect(mockResolveOptionalLodge).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-b"
    );
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-b", {
      days: null,
      windowStart: null,
    });
    // A templateId preview loads the v2 layout render (broken binding here → flag).
    expect(mockPrisma.displayTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl-7" } })
    );
    // Read-only: still never stamps lastSeenAt.
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });

  it("defaults the preview lodge when previewLodge is omitted", async () => {
    loginAsAdmin();
    mockResolveOptionalLodge.mockResolvedValue("lodge-default");
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1&templateId=tpl-7"));
    expect(res.status).toBe(200);
    expect(mockResolveOptionalLodge).toHaveBeenCalledWith(expect.anything(), null);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-default", {
      days: null,
      windowStart: null,
    });
  });

  it("rejects a template preview against an unknown/inactive previewLodge", async () => {
    loginAsAdmin();
    mockResolveOptionalLodge.mockResolvedValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(
      await stateRequest("?preview=1&templateId=tpl-7&previewLodge=ghost")
    );
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
  });

  it("a bare templateId (no session) is denied", async () => {
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?templateId=tpl-7"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/display/state — sandboxed preview grant (LTV-036, ADR-003 §5)", () => {
  it("a valid grant renders its template/lodge WITHOUT a session and never stamps lastSeenAt", async () => {
    // No session, no device cookie — exactly the sandboxed iframe's context.
    mockDecodeGrant.mockReturnValue({
      templateId: "tpl-9",
      lodgeId: "lodge-grant",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewGrant=signed.blob"));
    expect(res.status).toBe(200);
    expect(mockDecodeGrant).toHaveBeenCalledWith("signed.blob");
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-grant", {
      days: null,
      windowStart: null,
    });
    expect(mockPrisma.displayTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl-9" } })
    );
    // A grant is not a device credential: no session lookup, no heartbeat stamp.
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
    // Cross-origin (opaque) frame fetch needs the permissive CORS header.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("a signed windowStart wins: a conflicting ?previewDate does NOT shift the served window (issue hoppers99/AlpineClubBookingsNZ#176)", async () => {
    // The grant is a signed, single-purpose, per-preview capability. When it
    // carries a windowStart, that signed value is authoritative — an unsigned
    // ?previewDate on the (sandbox-rewritable) iframe URL must not widen/shift
    // the served window beyond it.
    mockDecodeGrant.mockReturnValue({
      templateId: null,
      lodgeId: "lodge-grant",
      windowStart: "2026-08-01",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const { GET } = await import("@/app/api/display/state/route");

    let res = await GET(await stateRequest("?previewGrant=signed.blob"));
    expect(res.status).toBe(200);
    let [, options] = mockBuildDisplayState.mock.calls[0];
    expect((options.windowStart as Date).toISOString().slice(0, 10)).toBe(
      "2026-08-01"
    );

    mockBuildDisplayState.mockClear();
    // A conflicting ?previewDate is ignored — the signed value still wins.
    res = await GET(
      await stateRequest("?previewGrant=signed.blob&previewDate=2026-09-15")
    );
    [, options] = mockBuildDisplayState.mock.calls[0];
    expect((options.windowStart as Date).toISOString().slice(0, 10)).toBe(
      "2026-08-01"
    );
  });

  it("with NO signed windowStart, ?previewDate drives the window (in-frame picker UX kept working)", async () => {
    // No signed date on the grant → the in-frame date picker's ?previewDate is
    // free to drive the simulated window; only a SIGNED windowStart is locked.
    mockDecodeGrant.mockReturnValue({
      templateId: null,
      lodgeId: "lodge-grant",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(
      await stateRequest("?previewGrant=signed.blob&previewDate=2026-09-15")
    );
    expect(res.status).toBe(200);
    const [, options] = mockBuildDisplayState.mock.calls[0];
    expect((options.windowStart as Date).toISOString().slice(0, 10)).toBe(
      "2026-09-15"
    );
  });

  it("rejects an invalid/expired/tampered grant with 401 and does not fall through to the session path", async () => {
    mockDecodeGrant.mockReturnValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewGrant=bad"));
    expect(res.status).toBe(401);
    expect(mockBuildDisplayState).not.toHaveBeenCalled();
    // A bad grant never consults the admin session (the iframe has none).
    expect(mockAuth).not.toHaveBeenCalled();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("a genuine device token still wins over a grant only when the grant is absent (grant checked first)", async () => {
    // With BOTH a device cookie and a grant, the grant path runs first and does
    // not stamp lastSeenAt — the grant is a read-only preview capability.
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    mockDecodeGrant.mockReturnValue({
      templateId: null,
      lodgeId: "lodge-grant",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?previewGrant=signed.blob"));
    expect(res.status).toBe(200);
    expect(mockBuildDisplayState).toHaveBeenCalledWith("lodge-grant", {
      days: null,
      windowStart: null,
    });
    expect(mockPrisma.lodgeDisplayDevice.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/display/state — Cache-Control: no-store on every payload path (issue hoppers99/AlpineClubBookingsNZ#176)", () => {
  // The payload is the privacy-reduced wall feed but can still carry guest names
  // and opted-in phone numbers, so no shared/browser cache may hold it.
  it("the device path sets no-store", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the admin-preview path sets no-store", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN_MEMBER.id } });
    mockPrisma.member.findUnique.mockResolvedValue(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the sandboxed grant path sets no-store (alongside the CORS header)", async () => {
    mockDecodeGrant.mockReturnValue({
      templateId: null,
      lodgeId: "lodge-grant",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const { GET } = await import("@/app/api/display/state/route");
    const res = await GET(await stateRequest("?previewGrant=signed.blob"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/display/state — v2 layoutRender path (LTV-027)", () => {
  const DEVICE_AUTH_V2 = {
    device: {
      id: "dev-2",
      lodgeId: "lodge-a",
      name: "Lobby TV",
      templateId: "tpl-42",
    },
  };

  // A valid stored Layout+Template with hostile HTML/CSS to prove serve-time
  // sanitisation + `</style` stripping.
  const VALID_TEMPLATE = {
    slotContent: { main: { html: "<p>Hi</p><script>steal()</script>" } },
    cssOverrides: ".x{color:blue;background:url(https://evil.example/x.png)}",
    footerHtml: "<b>Wi-Fi</b><script>evil()</script>",
    layout: {
      bodyHtml: "<h1>Wall</h1><script>alert(1)</script>{{area:main}}",
      defaultCss: "body{color:red}</style><script>y()</script>",
      areas: [{ key: "main", description: "Main", kind: "static" }],
    },
  };

  it("attaches a sanitised layoutRender for a device bound to a v2 template", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(VALID_TEMPLATE);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    expect(mockPrisma.displayTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tpl-42" } })
    );
    const body = await res.json();
    expect(body.layoutRender).toBeDefined();
    // Script tags stripped from every admin HTML field at serve time.
    expect(body.layoutRender.bodyHtml).not.toMatch(/<script/i);
    // LTV-041: the `{{area:main}}` placeholder is swapped for an inert marker the
    // client portals its Area into (the token itself never reaches the wire).
    expect(body.layoutRender.bodyHtml).toContain('<div data-display-area="main"></div>');
    expect(body.layoutRender.bodyHtml).not.toContain("{{area:main}}");
    expect(body.layoutRender.slotContent.main.html).not.toMatch(/<script/i);
    expect(body.layoutRender.footerHtml).not.toMatch(/<script/i);
    // `</style` stripped from CSS so authored CSS cannot break out of <style>.
    expect(body.layoutRender.defaultCss).not.toMatch(/<\/style/i);
    // LTV-029: authored CSS is scoped to the display authored root...
    expect(body.layoutRender.cssOverrides).toContain(".display-authored-root .x");
    // ...and the external url() exfiltration vector is removed.
    expect(body.layoutRender.cssOverrides).not.toContain("evil.example");
    expect(body.layoutRender.cssOverrides).toContain("/* blocked: external url */");
    // The read-only club theme variables ride along as non-authored themeCss.
    expect(body.layoutRender.themeCss).toContain("--brand-gold");
    // The legacy template still ships as the safe fallback.
    expect(body.template).toBeDefined();
    // A CLEAN render is never flagged as a broken binding, and never warns.
    expect(body.layoutRenderError).toBeUndefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    // The device heartbeat still stamps on the v2 path.
    expect(mockPrisma.lodgeDisplayDevice.update).toHaveBeenCalled();
  });

  it("falls back to the legacy template when the stored layout is invalid (broken binding: flag + warn)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    // areas do not match the body placeholder → buildLayoutRender throws.
    mockPrisma.displayTemplate.findUnique.mockResolvedValue({
      ...VALID_TEMPLATE,
      layout: { ...VALID_TEMPLATE.layout, areas: [] },
    });
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Silent legacy fallback for the wall, but flagged for the preview UI.
    expect(body.layoutRender).toBeUndefined();
    expect(body.template).toBeDefined();
    expect(body.layoutRenderError).toBe(true);
    // Logged at warn with the device/template ids so an operator can see it.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "tpl-42", deviceId: "dev-2" }),
      expect.stringContaining("failed to build")
    );
  });

  it("falls back to the legacy template when the template row is missing (broken binding: flag + warn)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH_V2);
    mockPrisma.displayTemplate.findUnique.mockResolvedValue(null);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(body.template).toBeDefined();
    expect(body.layoutRenderError).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "tpl-42", deviceId: "dev-2" }),
      expect.stringContaining("missing")
    );
  });

  it("a device without templateId never loads a layout (no binding: silent, no flag, no warn)", async () => {
    mockCheckDisplayAuth.mockResolvedValue(DEVICE_AUTH);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    // "No binding" is expected, not broken: no error flag and no warn log.
    expect(body.layoutRenderError).toBeUndefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });

  it("?preview=1 (no templateId) never loads a layout", async () => {
    mockAuth.mockResolvedValue({ user: { id: ADMIN_MEMBER.id } });
    mockPrisma.member.findUnique.mockResolvedValue(ADMIN_MEMBER);
    const { GET } = await import("@/app/api/display/state/route");

    const res = await GET(await stateRequest("?preview=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layoutRender).toBeUndefined();
    expect(mockPrisma.displayTemplate.findUnique).not.toHaveBeenCalled();
  });
});
