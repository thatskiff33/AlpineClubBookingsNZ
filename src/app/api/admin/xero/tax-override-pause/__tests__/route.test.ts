import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The GST-override pause API (#5208), proved against the REAL authorisation
  guard: `GET` is `finance:view`, `POST ./clear` is `finance:edit`. The
  safeguard behind them is the real one; only Prisma is a double.
*/

const h = vi.hoisted(() => {
  const tx = {
    xeroTaxOverrideMismatch: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      member: { findUnique: vi.fn() },
      xeroTaxOverrideMismatch: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
    auth: vi.fn(),
    request: { method: "GET", path: "/api/admin/xero/tax-override-pause" },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-pathname": h.request.path, "x-request-method": h.request.method }),
}));

import { GET } from "@/app/api/admin/xero/tax-override-pause/route";
import { POST } from "@/app/api/admin/xero/tax-override-pause/clear/route";

type Level = "NONE" | "VIEW" | "EDIT";
const AREAS = ["overview", "bookings", "membership", "finance", "lodge", "content", "support"] as const;

function signInWithFinance(level: Level) {
  h.auth.mockResolvedValue({ user: { id: "member-finance", role: "ADMIN", accessRoles: [] } });
  const grid = Object.fromEntries(AREAS.map((area) => [`${area}Level`, area === "finance" ? level : "NONE"]));
  h.prisma.member.findUnique.mockResolvedValue({
    active: true, forcePasswordChange: false, twoFactorEnabled: false,
    accessRoles: [{ role: "ADMIN_CUSTOM", roleDefinitionId: "ardef_custom", roleDefinition: grid }],
  });
}

const row = { id: "m1", createdAt: new Date("2026-07-01T00:00:00.000Z"), bookingId: "b1", providerInvoiceId: "inv_1", invoiceNumber: "INV-1",
  documentKind: "CREATE", lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }] };

const get = () => {
  h.request.method = "GET";
  h.request.path = "/api/admin/xero/tax-override-pause";
  return GET();
};
const clear = (body: unknown) => {
  h.request.method = "POST";
  h.request.path = "/api/admin/xero/tax-override-pause/clear";
  return POST(new Request("https://club.example.com/api/admin/xero/tax-override-pause/clear", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.xeroTaxOverrideMismatch.findMany.mockResolvedValue([row]);
  h.tx.xeroTaxOverrideMismatch.updateMany.mockResolvedValue({ count: 1 });
  signInWithFinance("EDIT");
});

describe("the GST-override pause API (#5208)", () => {
  it("lists the flagged invoices and the one problem sentence to a finance viewer", async () => {
    signInWithFinance("VIEW");
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoices).toEqual([expect.objectContaining({ id: "m1", invoiceNumber: "INV-1", lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }] })]);
    expect(body.problem).toMatch(/^Xero changed the GST on 1 invoice after the app sent it/);
  });

  it("refuses a finance viewer the clear, and anyone without finance the list", async () => {
    signInWithFinance("VIEW");
    expect((await clear({ ids: ["m1"], note: "checked", confirmed: true })).status).toBe(403);
    signInWithFinance("NONE");
    expect((await get()).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("clears the named rows for a finance editor, with the note, and answers what is still open", async () => {
    h.prisma.xeroTaxOverrideMismatch.findMany.mockResolvedValueOnce([]);
    const response = await clear({ ids: ["m1"], note: "  checked in Xero  ", confirmed: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cleared: 1, invoices: [], problem: null });
    expect(h.tx.xeroTaxOverrideMismatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["m1"] }, clearedAt: null },
      data: expect.objectContaining({ clearedByMemberId: "member-finance", clearNote: "checked in Xero" }),
    }));
  });

  it.each([
    ["no confirmation", { ids: ["m1"], note: "checked" }],
    ["a blank note", { ids: ["m1"], note: "   ", confirmed: true }],
    ["no ids", { ids: [], note: "checked", confirmed: true }],
  ])("refuses a clear with %s", async (_label, body) => {
    expect((await clear(body)).status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers a body that is not JSON with the shared invalid-JSON 400 and clears nothing", async () => {
    h.request.method = "POST";
    h.request.path = "/api/admin/xero/tax-override-pause/clear";
    const response = await POST(new Request("https://club.example.com/api/admin/xero/tax-override-pause/clear", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON",
      details: { body: ["Request body must be valid JSON"] },
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
