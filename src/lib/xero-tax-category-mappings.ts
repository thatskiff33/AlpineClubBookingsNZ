import { prisma } from "@/lib/prisma";
import { readXeroConnection } from "@/lib/xero-connection";
import {
  XeroTaxCategoryUnavailableError,
  type MappedXeroTaxCategory,
  type XeroTaxCategoryKey,
} from "@/lib/xero-tax-categories";
import { resolveXeroTaxRendering, type XeroTaxAnchor } from "@/lib/xero-tax-anchors";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";
import { xeroCategoryLineTax } from "@/lib/xero-tax-rendering";

/**
 * THE CLUB'S TAX CATEGORY MAPPINGS, READ (#5209; `INV-CONFIG-007`). Each of
 * Sales tax on expenses, Exempt and Zero rated maps to a tax rate in the club's
 * own Xero organisation; Sales tax on income is the dated schedule and is never
 * stored here (`xero-tax-categories.ts`). The one writer is
 * `xero-tax-category-write.ts`.
 *
 * A MAPPING BELONGS TO ONE XERO ORGANISATION. A row chosen while another tenant
 * was connected names a code that organisation had, not necessarily this one's,
 * so it reads as unmapped here and is reported as from the wrong organisation.
 *
 * Read OUTSIDE any transaction (`INV-LOCK-004`), through the module client.
 */

export interface XeroTaxCategoryMappingRow {
  category: MappedXeroTaxCategory;
  taxType: string;
  /** Whether the row was chosen in the Xero organisation connected now. */
  currentTenant: boolean;
}

export interface XeroTaxCategoryMappings {
  /** The connected Xero organisation, or null when Xero is not connected. */
  tenantId: string | null;
  rows: XeroTaxCategoryMappingRow[];
}

export async function loadXeroTaxCategoryMappings(): Promise<XeroTaxCategoryMappings> {
  const [connection, rows] = await Promise.all([
    readXeroConnection(),
    prisma.xeroTaxCategoryMapping.findMany({
      select: { category: true, taxType: true, xeroTenantId: true },
      orderBy: { category: "asc" },
    }),
  ]);
  const tenantId = connection?.tenantId ?? null;
  return {
    tenantId,
    rows: rows.map((row) => ({
      category: row.category,
      taxType: row.taxType,
      currentTenant: tenantId !== null && row.xeroTenantId === tenantId,
    })),
  };
}

/** The tax type a category is mapped to in the connected organisation, or null when it is not. */
export function mappedTaxTypeFor(mappings: XeroTaxCategoryMappings, category: MappedXeroTaxCategory): string | null {
  const row = mappings.rows.find((candidate) => candidate.category === category);
  return row?.currentTenant ? row.taxType : null;
}

/**
 * The tax field a line in `category` carries, under the treatment its anchor
 * fixes (`xero-tax-anchors.ts`). Sales tax on income, and every line of an
 * unregistered club, need no mapping. Otherwise the category must be mapped in
 * the connected organisation to a rate Xero still has, active; when it is not,
 * or Xero's rates cannot be read, this throws `XeroTaxCategoryUnavailableError`
 * and the caller sends nothing. The rates come from the reader's short cache.
 */
export async function resolveXeroCategoryLineTax(
  anchor: XeroTaxAnchor,
  category: XeroTaxCategoryKey,
): Promise<{ taxType?: string }> {
  const rendering = await resolveXeroTaxRendering(anchor);
  if (category === "SALES_TAX_ON_INCOME" || rendering.taxType === undefined) {
    return xeroCategoryLineTax(rendering, category, null);
  }
  const mappings = await loadXeroTaxCategoryMappings();
  const taxType = mappedTaxTypeFor(mappings, category);
  if (taxType === null) {
    const stored = mappings.rows.some((candidate) => candidate.category === category);
    throw new XeroTaxCategoryUnavailableError(category, stored ? "wrong-tenant" : "unmapped");
  }
  let rates;
  try {
    rates = await readXeroTaxRates();
  } catch {
    throw new XeroTaxCategoryUnavailableError(category, "rates-unreadable");
  }
  const rate = rates.find((candidate) => candidate.taxType === taxType);
  if (!rate) throw new XeroTaxCategoryUnavailableError(category, "removed");
  if (!rate.active) throw new XeroTaxCategoryUnavailableError(category, "inactive");
  return xeroCategoryLineTax(rendering, category, taxType);
}
