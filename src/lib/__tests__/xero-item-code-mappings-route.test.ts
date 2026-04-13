import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    xeroItemCodeMapping: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  GET as getItemCodeMappings,
  PUT as putItemCodeMappings,
} from "@/app/api/admin/xero/item-code-mappings/route";

const mockPrisma = prisma as unknown as {
  member: {
    count: ReturnType<typeof vi.fn>;
  };
  xeroItemCodeMapping: {
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;

function adminSession() {
  return { user: { id: "admin-1", role: "ADMIN" } };
}

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/xero/item-code-mappings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Xero item-code mappings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession());
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.xeroItemCodeMapping.upsert.mockResolvedValue({});
    mockPrisma.xeroItemCodeMapping.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([]);
  });

  it("returns entrance fee mappings with null item codes", async () => {
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([
      {
        category: "ENTRANCE_FEE",
        entranceFeeCategory: "ADULT",
        itemCode: null,
        amountCents: 5000,
      },
    ]);

    const res = await getItemCodeMappings();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entranceFees.ADULT).toEqual({ itemCode: null, amountCents: 5000 });
  });

  it("accepts entrance fee updates with a null item code", async () => {
    mockPrisma.xeroItemCodeMapping.findMany.mockResolvedValue([
      {
        category: "ENTRANCE_FEE",
        entranceFeeCategory: "ADULT",
        itemCode: null,
        amountCents: 5000,
      },
    ]);

    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: null, amountCents: 5000 },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category_entranceFeeCategory: {
            category: "ENTRANCE_FEE",
            entranceFeeCategory: "ADULT",
          },
        },
        update: { itemCode: null, amountCents: 5000 },
      })
    );
  });

  it("deletes an entrance fee row when both item code and amount are cleared", async () => {
    const res = await putItemCodeMappings(
      makePutRequest({
        entranceFees: {
          ADULT: { itemCode: null, amountCents: null },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.xeroItemCodeMapping.deleteMany).toHaveBeenCalledWith({
      where: { category: "ENTRANCE_FEE", entranceFeeCategory: "ADULT" },
    });
    expect(mockPrisma.xeroItemCodeMapping.upsert).not.toHaveBeenCalled();
  });
});
