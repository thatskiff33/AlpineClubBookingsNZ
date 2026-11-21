import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The tax category mapping API (#5209; INV-CONFIG-008), proved against the REAL
  authorisation guard, as the club tax route's test is: a mocked
  `requireAdmin` cannot tell `{ permission: false }` (Full Admin only) from an
  area permission, so a widened write would still pass. GET is
  `finance:view`; PUT and DELETE are Full Admin. The writer behind them is the
  real one (`xero-tax-category-write.test.ts` owns its rules); only Prisma and
  Xero's tax-rate read are doubles. The frozen clock's club today is 2026-07-01.
*/

const h = vi.hoisted(() => {
  const delegates = ["clubTaxSettings", "auditLog", "member", "xeroConnection", "xeroTaxCategoryMapping", "xeroAccountMapping"];
  const methods = ["findUnique", "findFirst", "findMany", "create", "update", "upsert", "delete", "deleteMany", "count"];

  function makeClient() {
    const behaviour = new Map<string, (args: unknown) => unknown>();
    const client: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
    for (const delegate of delegates) {
      const bag: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const method of methods) {
        bag[method] = vi.fn(async (args: unknown) => {
          const impl = behaviour.get(`${delegate}.${method}`);
          return impl ? impl(args) : method === "findMany" ? [] : null;
        });
      }
      client[delegate] = bag;
    }
    return { client, behaviour };
  }

  const root = makeClient();
  const tx = makeClient();
  return {
    root,
    tx,
    prisma: {
      ...root.client,
      $transaction: vi.fn<(callback: (client: unknown) => unknown, options?: unknown) => Promise<unknown>>(
        async (callback) => callback(tx.client),
      ),
    },
    auth: vi.fn(),
    requestMethod: { value: "GET" },
    readXeroTaxRates: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/xero-tax-rates", () => ({
  readXeroTaxRates: h.readXeroTaxRates,
  readXeroTaxRatesOrNull: async () => h.readXeroTaxRates().catch(() => null),
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-pathname": "/api/admin/xero/tax-categories", "x-request-method": h.requestMethod.value }),
}));

import { DELETE, GET, PUT } from "@/app/api/admin/xero/tax-categories/route";

const ACTOR = "member-full-admin";
const TENANT = "tenant-connected";
const RATES = [
  { taxType: "EXEMPTOUTPUT", name: "Exempt Income", rateBasisPoints: 0, active: true, revenue: true, expenses: false },
  { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false },
];
const MAP_EXEMPT = { category: "EXEMPT", taxType: "EXEMPTOUTPUT" };

type Level = "NONE" | "VIEW" | "EDIT";
const AREAS = ["overview", "bookings", "membership", "finance", "lodge", "content", "support"] as const;

function setGuardMember(accessRoles: unknown[]) {
  h.root.behaviour.set("member.findUnique", () => ({
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles,
  }));
}

function signInAsFullAdmin() {
  h.auth.mockResolvedValue({ user: { id: ACTOR, role: "ADMIN", accessRoles: ["ADMIN"] } });
  setGuardMember([{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }]);
}

/** A custom access-role grid with no `ADMIN` token: never Full Admin, whatever its levels. */
function signInWithGrid(levels: Partial<Record<(typeof AREAS)[number], Level>>) {
  h.auth.mockResolvedValue({ user: { id: "member-scoped-admin", role: "ADMIN", accessRoles: [] } });
  const grid = Object.fromEntries(AREAS.map((area) => [`${area}Level`, levels[area] ?? "NONE"]));
  setGuardMember([{ role: "ADMIN_CUSTOM", roleDefinitionId: "ardef_custom", roleDefinition: grid }]);
}

function call(handler: (request: Request) => Promise<Response>, method: string, body?: unknown) {
  h.requestMethod.value = method;
  return handler(
    new Request("https://club.example.com/api/admin/xero/tax-categories", {
      method,
      headers: { "content-type": "application/json", "user-agent": "vitest" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const get = () => call(() => GET(), "GET");
const put = (body: unknown) => call(PUT, "PUT", body);
const del = (body: unknown) => call(DELETE, "DELETE", body);

beforeEach(() => {
  vi.clearAllMocks();
  h.root.behaviour.clear();
  h.tx.behaviour.clear();
  h.prisma.$transaction.mockImplementation(async (callback) => callback(h.tx.client));
  h.readXeroTaxRates.mockResolvedValue(RATES);
  const connection = () => ({ tenantId: TENANT, expiresAt: new Date() });
  h.root.behaviour.set("xeroConnection.findUnique", connection);
  h.tx.behaviour.set("xeroConnection.findUnique", connection);
  signInAsFullAdmin();
});

describe("who may read and who may change", () => {
  it("a Full Admin: reads 200, maps 200, clears a mapping 200", async () => {
    expect((await get()).status).toBe(200);
    expect((await put(MAP_EXEMPT)).status).toBe(200);
    h.tx.behaviour.set("xeroTaxCategoryMapping.findUnique", () => ({ taxType: "EXEMPTOUTPUT" }));
    expect((await del({ category: "EXEMPT" })).status).toBe(200);
  });

  it("a finance viewer, and a finance editor: read 200, cannot map or clear", async () => {
    for (const finance of ["VIEW", "EDIT"] as const) {
      signInWithGrid({ finance });
      expect((await get()).status).toBe(200);
      expect((await put(MAP_EXEMPT)).status).toBe(403);
      expect((await del({ category: "EXEMPT" })).status).toBe(403);
    }
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an admin without finance cannot read it", async () => {
    signInWithGrid({ bookings: "EDIT" });
    expect((await get()).status).toBe(403);
  });

  it("a signed-out caller is refused every verb, with the Xero module gate's frozen 404", async () => {
    h.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect((await put(MAP_EXEMPT)).status).toBe(404);
    expect((await del({ category: "EXEMPT" })).status).toBe(404);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("serves the four categories: income from the schedule, the rest from this organisation's mappings", async () => {
    h.root.behaviour.set("xeroTaxCategoryMapping.findMany", () => [
      { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT },
      { category: "ZERO_RATED", taxType: "ZERORATED", xeroTenantId: "tenant-before" },
    ]);
    const { state } = (await (await get()).json()) as { state: Record<string, unknown> & { categories: Record<string, unknown>[] } };
    expect(state).toMatchObject({ connected: true, registeredToday: true, registeredNowOrLater: true, rates: RATES });
    expect(state.categories.map(({ key, source, taxType, otherOrganisation }) => ({ key, source, taxType, otherOrganisation }))).toEqual([
      { key: "SALES_TAX_ON_INCOME", source: "tax-treatment", taxType: "OUTPUT2", otherOrganisation: false },
      { key: "SALES_TAX_ON_EXPENSES", source: "mapping", taxType: null, otherOrganisation: false },
      { key: "EXEMPT", source: "mapping", taxType: "EXEMPTOUTPUT", otherOrganisation: false },
      { key: "ZERO_RATED", source: "mapping", taxType: null, otherOrganisation: true },
    ]);
  });
});

describe("PUT and DELETE", () => {
  it("refuse income, an unknown category, a blank code and an unknown field", async () => {
    expect((await put({ category: "SALES_TAX_ON_INCOME", taxType: "OUTPUT2" })).status).toBe(400);
    expect((await put({ category: "CAPITAL", taxType: "X" })).status).toBe(400);
    expect((await put({ category: "EXEMPT", taxType: "  " })).status).toBe(400);
    expect((await put({ ...MAP_EXEMPT, xeroTenantId: "x" })).status).toBe(400);
    expect((await del({ category: "SALES_TAX_ON_INCOME" })).status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answer the writer's refusals", async () => {
    expect((await put({ category: "EXEMPT", taxType: "OUTPUT2" })).status).toBe(400);
    h.readXeroTaxRates.mockRejectedValue(new Error("down"));
    expect((await put(MAP_EXEMPT)).status).toBe(503);
    expect((await del({ category: "EXEMPT" })).status).toBe(404);
  });

  it("refuse to clear Exempt while the Opening Credits account is mapped, with the writer's own sentence (#4988)", async () => {
    h.tx.behaviour.set("xeroTaxCategoryMapping.findUnique", () => ({ taxType: "EXEMPTOUTPUT" }));
    h.root.behaviour.set("xeroAccountMapping.findUnique", () => ({ code: "2100" }));
    h.root.behaviour.set("xeroTaxCategoryMapping.findMany", () => [
      { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT },
    ]);
    const response = await del({ category: "EXEMPT" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/Unmap the Opening Credits account/);
    expect(h.tx.client.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
    // Unmapped, the same request clears it.
    h.root.behaviour.set("xeroAccountMapping.findUnique", () => null);
    expect((await del({ category: "EXEMPT" })).status).toBe(200);
  });

  it("answer write contention with a retryable 503", async () => {
    h.prisma.$transaction.mockRejectedValue(Object.assign(new Error("conflict"), { code: "P2034" }));
    expect((await put(MAP_EXEMPT)).status).toBe(503);
    h.prisma.$transaction.mockRejectedValue(Object.assign(new Error("race"), { code: "P2002" }));
    expect((await del({ category: "EXEMPT" })).status).toBe(503);
  });
});
