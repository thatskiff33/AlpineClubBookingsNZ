import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #121: the Food Orders settings card's API and the settings reader.
 *
 * - Any valid email address saves; an invalid one is refused; an empty one
 *   clears it (ordering then reads as not set up). It is never checked against
 *   members (fork #121 owner decision 10).
 * - Lodge Operations view reads, edit saves; the module being off is a 404.
 * - Every failure of the reader is closed: no row, a bad stored value or a
 *   database error reads as "no officer email".
 */

const mocks = vi.hoisted(() => ({
  modules: { foodOrders: true } as Record<string, boolean>,
  allowedLevel: "edit" as "none" | "view" | "edit",
  stored: null as null | { officerEmail: string | null; officerLabel: string },
  findThrows: false,
  upsert: vi.fn(),
  logAudit: vi.fn(),
  transactionError: null as null | { code: string },
  transactionOptions: [] as unknown[],
}));

vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    foodOrderSettings: {
      findUnique: async () => {
        if (mocks.findThrows) throw new Error("relation does not exist");
        return mocks.stored;
      },
      upsert: async (args: { update: { officerEmail: string | null; officerLabel: string } }) => {
        mocks.upsert(args);
        mocks.stored = {
          officerEmail: args.update.officerEmail,
          officerLabel: args.update.officerLabel,
        };
        return mocks.stored;
      },
    },
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
  prisma.$transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
    options: unknown,
  ) => {
    mocks.transactionOptions.push(options);
    if (mocks.transactionError) throw mocks.transactionError;
    return fn(prisma);
  };
  return { prisma };
});
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: async () => mocks.modules,
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async ({ permission }: { permission: { level: "view" | "edit" } }) => {
    const rank = { none: 0, view: 1, edit: 2 };
    return rank[mocks.allowedLevel] >= rank[permission.level]
      ? { ok: true, session: { user: { id: "admin-1" } } }
      : { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  },
}));
// The settings save audits with the awaited writer inside its transaction.
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, PUT } from "@/app/api/admin/food-orders/settings/route";
import { foodOfficerEmail, loadFoodOrderSettings } from "@/lib/food-order-settings";

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/admin/food-orders/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  mocks.modules = { foodOrders: true };
  mocks.allowedLevel = "edit";
  mocks.stored = null;
  mocks.findThrows = false;
  mocks.upsert.mockReset();
  mocks.logAudit.mockReset();
  mocks.transactionError = null;
  mocks.transactionOptions.length = 0;
});

describe("Food Orders settings API", () => {
  it("saves any valid email address and the label, and audits the change", async () => {
    const res = await put({ officerEmail: " catering@example.org ", officerLabel: "Catering officer" });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({
      officerEmail: "catering@example.org",
      officerLabel: "Catering officer",
    });
    expect(mocks.logAudit).toHaveBeenCalledOnce();
    // Read, write and audit in one Serializable transaction, the audit on its client.
    expect(mocks.transactionOptions).toEqual([{ isolationLevel: "Serializable" }]);
    expect(mocks.logAudit.mock.calls[0]![1]).toBeDefined();
    const audit = mocks.logAudit.mock.calls[0]![0] as { action: string; details: string };
    expect(audit.action).toBe("food_order.settings.updated");
    expect(JSON.parse(audit.details).officerEmail).toEqual({
      from: null,
      to: "catering@example.org",
    });
  });

  for (const bad of ["not-an-email", "a@", "@b.c", "two words@example.org"]) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      const res = await put({ officerEmail: bad, officerLabel: "Food officer" });
      expect(res.status).toBe(400);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  }

  it("refuses an empty or over-long label", async () => {
    expect((await put({ officerEmail: "a@b.co", officerLabel: "  " })).status).toBe(400);
    expect((await put({ officerEmail: "a@b.co", officerLabel: "x".repeat(61) })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("an empty address clears it, which reads as not set up", async () => {
    mocks.stored = { officerEmail: "old@example.org", officerLabel: "Food officer" };
    const res = await put({ officerEmail: "", officerLabel: "Food officer" });
    expect(res.status).toBe(200);
    expect(await foodOfficerEmail()).toBeNull();
  });

  it("records the value actually replaced as the audit's from", async () => {
    mocks.stored = { officerEmail: "old@example.org", officerLabel: "Food officer" };
    await put({ officerEmail: "new@example.org", officerLabel: "Catering officer" });
    const details = JSON.parse(
      (mocks.logAudit.mock.calls[0]![0] as { details: string }).details,
    );
    expect(details).toEqual({
      officerEmail: { from: "old@example.org", to: "new@example.org" },
      officerLabel: { from: "Food officer", to: "Catering officer" },
    });
  });

  for (const code of ["P2034", "P2028", "P2002"]) {
    it(`answers 503 and audits nothing when a concurrent save aborts it (${code})`, async () => {
      mocks.transactionError = { code };
      const res = await put({ officerEmail: "a@b.co", officerLabel: "Food officer" });
      expect(res.status).toBe(503);
      expect(mocks.logAudit).not.toHaveBeenCalled();
    });
  }

  it("view access reads but cannot save", async () => {
    mocks.allowedLevel = "view";
    expect((await GET()).status).toBe(200);
    expect((await put({ officerEmail: "a@b.co", officerLabel: "Food officer" })).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("no Lodge Operations access cannot read", async () => {
    mocks.allowedLevel = "none";
    expect((await GET()).status).toBe(403);
  });

  it("answers 404 for both methods while the module is off", async () => {
    mocks.modules = { foodOrders: false };
    expect((await GET()).status).toBe(404);
    expect((await put({ officerEmail: "a@b.co", officerLabel: "Food officer" })).status).toBe(404);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("the food-order settings reader fails closed", () => {
  it("no row: no officer email and the default label", async () => {
    expect(await loadFoodOrderSettings()).toEqual({
      officerEmail: null,
      officerLabel: "Food officer",
    });
  });

  it("a stored value that is not a valid address reads as unset", async () => {
    mocks.stored = { officerEmail: "garbage", officerLabel: "" };
    expect(await loadFoodOrderSettings()).toEqual({
      officerEmail: null,
      officerLabel: "Food officer",
    });
  });

  it("a database error reads as unset", async () => {
    mocks.findThrows = true;
    expect(await foodOfficerEmail()).toBeNull();
  });
});
