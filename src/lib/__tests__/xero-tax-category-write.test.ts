/**
 * THE ONE WRITER of the club's tax category mappings (#5209): Xero must carry
 * the rate, read fresh before the transaction; the mapping records the
 * organisation it was chosen in; a reconnect between the read and the write is
 * refused; and every change writes its audit row in the same Serializable
 * transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

const h = vi.hoisted(() => {
  const tx = {
    xeroConnection: { findUnique: vi.fn() },
    xeroTaxCategoryMapping: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      xeroConnection: { findUnique: vi.fn() },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown, _options?: unknown) => callback(tx)),
    },
    readXeroTaxRates: vi.fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.readXeroTaxRates }));

import { clearXeroTaxCategory, mapXeroTaxCategory } from "@/lib/xero-tax-category-write";

const ACTOR = "member-full-admin";
const TENANT = "tenant-connected";
const request = new Request("https://club.example.com/api/admin/xero/tax-categories", { method: "PUT" });
const RATES: XeroTaxRateOption[] = [
  { taxType: "EXEMPTOUTPUT", name: "Exempt Income", rateBasisPoints: 0, active: true, revenue: true, expenses: false },
  { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false },
];
const connected = (tenantId: string | null) => (tenantId === null ? null : { tenantId, expiresAt: new Date() });

function auditData(): Record<string, unknown> {
  expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  return (h.tx.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readXeroTaxRates.mockResolvedValue(RATES);
  h.prisma.xeroConnection.findUnique.mockResolvedValue(connected(TENANT));
  h.tx.xeroConnection.findUnique.mockResolvedValue(connected(TENANT));
  h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue(null);
});

describe("mapXeroTaxCategory", () => {
  it("saves the rate with the connected organisation and its audit row, Serializable, after a fresh Xero read", async () => {
    await expect(
      mapXeroTaxCategory({ category: "EXEMPT", taxType: " EXEMPTOUTPUT ", actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ changed: true });
    expect(h.readXeroTaxRates).toHaveBeenCalledWith({ fresh: true });
    expect(h.tx.xeroTaxCategoryMapping.upsert).toHaveBeenCalledWith({
      where: { category: "EXEMPT" },
      create: { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT, updatedByMemberId: ACTOR },
      update: { taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT, updatedByMemberId: ACTOR },
    });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
    expect(auditData()).toMatchObject({ action: "XERO_TAX_CATEGORY_MAPPED", category: "admin", severity: "important" });
  });

  it("refuses a rate Xero does not carry for the category, before any transaction", async () => {
    const outcome = await mapXeroTaxCategory({ category: "EXEMPT", taxType: "OUTPUT2", actingMemberId: ACTOR, request });
    expect(outcome).toEqual({ refused: "xero-code", message: expect.stringMatching(/not 0%/) });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses when Xero cannot be read, or is not connected", async () => {
    h.readXeroTaxRates.mockRejectedValue(new Error("down"));
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "xero-unreadable" });
    h.prisma.xeroConnection.findUnique.mockResolvedValue(null);
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-connected" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses when Xero was reconnected to another organisation after the rates were read", async () => {
    h.tx.xeroConnection.findUnique.mockResolvedValue(connected("tenant-other"));
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-connected" });
    expect(h.tx.xeroTaxCategoryMapping.upsert).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an unchanged save, but re-saves the same code chosen in another organisation", async () => {
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT });
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "unchanged" });
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT", xeroTenantId: "tenant-before" });
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ changed: true });
    expect(auditData()).toMatchObject({ metadata: expect.objectContaining({ tenantChanged: true }) });
  });
});

describe("clearXeroTaxCategory", () => {
  it("deletes the mapping with its audit row", async () => {
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT" });
    await expect(clearXeroTaxCategory({ category: "EXEMPT", actingMemberId: ACTOR, request })).resolves.toEqual({ changed: true });
    expect(h.tx.xeroTaxCategoryMapping.delete).toHaveBeenCalledWith({ where: { category: "EXEMPT" } });
    expect(auditData()).toMatchObject({ action: "XERO_TAX_CATEGORY_CLEARED", category: "admin" });
  });

  it("refuses a category that is not mapped", async () => {
    await expect(clearXeroTaxCategory({ category: "ZERO_RATED", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-found" });
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
