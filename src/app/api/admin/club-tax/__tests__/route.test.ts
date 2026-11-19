import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The club tax treatment API (#4632; INV-CONFIG-007), proved against the REAL
  authorisation guard, for the reason the club-format route's test records: a
  mocked `requireAdmin` cannot tell `{ permission: false }` (Full Admin only)
  from an area permission, so a widened write would still pass. GET is
  `finance:view`; PUT and DELETE are Full Admin (the #3596 precedent). The
  writer behind them is the real one (`club-tax-settings-write.test.ts` owns its
  rules); only Prisma and Xero's tax-rate read are doubles. The frozen clock's
  club today is 2026-07-01.
*/

const h = vi.hoisted(() => {
  const delegates = ["clubTaxSettings", "auditLog", "member", "booking"];
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
    new Headers({ "x-pathname": "/api/admin/club-tax", "x-request-method": h.requestMethod.value }),
}));

import { DELETE, GET, PUT } from "@/app/api/admin/club-tax/route";

const ACTOR = "member-full-admin";
const RATES = [
  { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true },
  { taxType: "INPUT2", name: "15% GST on Expenses", rateBasisPoints: 1500, active: true, revenue: false },
];
const UNREGISTER = { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: "2026-08-01", confirmed: true };

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

function call(handler: (request: Request) => Promise<Response>, method: string, body?: unknown, query = "") {
  h.requestMethod.value = method;
  return handler(
    new Request(`https://club.example.com/api/admin/club-tax${query}`, {
      method,
      headers: { "content-type": "application/json", "user-agent": "vitest" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const get = (query = "") => call(GET, "GET", undefined, query);
const put = (body: unknown) => call(PUT, "PUT", body);
const del = (body: unknown) => call(DELETE, "DELETE", body);

beforeEach(() => {
  vi.clearAllMocks();
  h.root.behaviour.clear();
  h.tx.behaviour.clear();
  h.prisma.$transaction.mockImplementation(async (callback) => callback(h.tx.client));
  h.readXeroTaxRates.mockResolvedValue(RATES);
  signInAsFullAdmin();
});

describe("who may read and who may change", () => {
  it("a Full Admin: reads 200, schedules 200, cancels a scheduled change 200", async () => {
    expect((await get()).status).toBe(200);
    expect((await put(UNREGISTER)).status).toBe(200);
    h.tx.behaviour.set("clubTaxSettings.findMany", () => [
      { id: "later", gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: new Date("2026-08-01T00:00:00.000Z") },
    ]);
    expect((await del({ effectiveFrom: "2026-08-01", confirmed: true })).status).toBe(200);
  });

  it("a finance viewer: reads 200, cannot schedule or cancel", async () => {
    signInWithGrid({ finance: "VIEW" });
    expect((await get()).status).toBe(200);
    expect((await put(UNREGISTER)).status).toBe(403);
    expect((await del({ effectiveFrom: "2026-08-01", confirmed: true })).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an admin holding every area at edit is still not Full Admin, so cannot change it", async () => {
    signInWithGrid(Object.fromEntries(AREAS.map((area) => [area, "EDIT" as const])));
    expect((await get()).status).toBe(200);
    expect((await put(UNREGISTER)).status).toBe(403);
    expect((await del({ effectiveFrom: "2026-08-01", confirmed: true })).status).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an admin without finance cannot read it", async () => {
    signInWithGrid({ bookings: "EDIT" });
    expect((await get()).status).toBe(403);
  });

  it("a signed-out caller is refused every verb", async () => {
    h.auth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await put(UNREGISTER)).status).toBe(401);
    expect((await del({ effectiveFrom: "2026-08-01", confirmed: true })).status).toBe(401);
  });
});

describe("GET", () => {
  it("serves the schedule with each period's status, the earliest change date, and only Xero's revenue rates", async () => {
    h.root.behaviour.set("clubTaxSettings.findMany", () => [
      { id: "later", gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: new Date("2026-08-01T00:00:00.000Z") },
    ]);
    const body = (await (await get()).json()) as Record<string, unknown>;
    expect(body).toEqual({
      state: {
        periods: [
          { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: "2010-10-01", status: "current" },
          { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: "2026-08-01", status: "scheduled" },
        ],
        earliestChangeDate: "2026-07-02",
        xeroRevenueRates: [RATES[0]],
      },
      keepingOldTreatment: null,
    });
  });

  it("counts the bookings a change from ?from= leaves on the old treatment", async () => {
    h.root.behaviour.set("booking.count", () => 7);
    const body = (await (await get("?from=2026-08-01")).json()) as { keepingOldTreatment: number };
    expect(body.keepingOldTreatment).toBe(7);
    expect(h.root.client.booking.count.mock.calls[0][0]).toMatchObject({
      where: { checkOut: { gt: new Date("2026-08-01T00:00:00.000Z") } },
    });
    expect((await get("?from=tomorrow")).status).toBe(400);
  });
});

describe("PUT and DELETE", () => {
  it("refuse an unconfirmed change before anything is read", async () => {
    expect((await put({ ...UNREGISTER, confirmed: false })).status).toBe(400);
    expect((await put({ ...UNREGISTER, confirmed: undefined })).status).toBe(400);
    expect((await del({ effectiveFrom: "2026-08-01" })).status).toBe(400);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuse a registered change with no code, and an unknown field", async () => {
    expect((await put({ ...UNREGISTER, gstRegistered: true, taxRateBasisPoints: 1500 })).status).toBe(400);
    expect((await put({ ...UNREGISTER, id: "default" })).status).toBe(400);
  });

  it("map the writer's refusals", async () => {
    expect((await put({ ...UNREGISTER, effectiveFrom: "2026-07-01" })).status).toBe(400);
    expect((await put({ ...UNREGISTER, gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "INPUT2" })).status).toBe(400);
    h.readXeroTaxRates.mockRejectedValue(new Error("down"));
    expect((await put({ ...UNREGISTER, gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2" })).status).toBe(503);
    expect((await del({ effectiveFrom: "2026-08-01", confirmed: true })).status).toBe(404);
  });

  it.each(["P2002", "P2028", "P2034"])("answer %s contention with a retryable 503", async (code) => {
    h.prisma.$transaction.mockRejectedValue(Object.assign(new Error("contention"), { code }));
    expect((await put(UNREGISTER)).status).toBe(503);
  });
});
