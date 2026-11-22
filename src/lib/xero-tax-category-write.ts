import "server-only";

import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { readXeroConnection } from "@/lib/xero-connection";
import { exemptClearRefusalWhileOpeningCreditsMapped } from "@/lib/xero-opening-credits-exempt-guards";
import { xeroTaxCategoryRateProblem, type MappedXeroTaxCategory } from "@/lib/xero-tax-categories";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";

/**
 * THE ONE WRITER of the club's tax category mappings (#5209), behind `PUT` and
 * `DELETE /api/admin/xero/tax-categories`. The route validates the body and
 * authorises a Full Admin; this decides what may be saved and records it.
 *
 * XERO MUST CARRY THE RATE. A mapping names a tax rate the connected Xero
 * organisation has, active, and fit for the category
 * (`xeroTaxCategoryRateProblem`), and records which organisation that was. The
 * rate list is read fresh and BEFORE the transaction (`INV-LOCK-004`); when
 * Xero cannot be read the mapping is refused, never saved on a guess.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK (`INV-LOCK-001`): one table plus its audit
 * row, the `scheduleClubTaxChange` shape. A sender reads the mapping outside
 * its own transaction and either finds the old code or the new one; both were
 * valid when saved. The connection is re-read inside the transaction so a
 * reconnect to another organisation between the Xero read and the write cannot
 * stamp a code with the wrong tenant. Serializable aborts the loser of two
 * saves; the route answers that, P2002 and P2028 a retryable 503.
 *
 * EXEMPT IS NOT CLEARED WHILE IT IS IN USE (#4988). While the Opening Credits
 * account is mapped and the club is, or is scheduled to be, GST-registered,
 * clearing Exempt is refused with a message telling the officer to unmap that
 * account first: the reverse of the account-mapping save's own refusal
 * (`xero-opening-credits-exempt-guards.ts`). A mapping chosen in another Xero
 * organisation than the one connected now is not in use and clears; while Xero
 * is disconnected no mapping can be told to be that, so the refusal stands
 * (`DELETE` has no connection check of its own). Read before the transaction,
 * like the rate list. The account-mapping save is not Serializable, so a clear and
 * a mapping that race can both land; the sender's refusal, held by the outbox,
 * covers that.
 */

export type XeroTaxCategoryWriteRefusal =
  | { refused: "not-connected" }
  | { refused: "xero-unreadable" }
  | { refused: "xero-code"; message: string }
  | { refused: "unchanged" }
  | { refused: "not-found" }
  | { refused: "in-use"; message: string };

export type XeroTaxCategoryWriteOutcome = { changed: true } | XeroTaxCategoryWriteRefusal;

async function connectedTenantId(db: Parameters<typeof readXeroConnection>[0] = prisma): Promise<string | null> {
  return (await readXeroConnection(db))?.tenantId ?? null;
}

export async function mapXeroTaxCategory({
  category,
  taxType: rawTaxType,
  actingMemberId,
  request,
}: {
  category: MappedXeroTaxCategory;
  taxType: string;
  actingMemberId: string;
  request: Request;
}): Promise<XeroTaxCategoryWriteOutcome> {
  const taxType = rawTaxType.trim();
  const tenantId = await connectedTenantId();
  if (tenantId === null) return { refused: "not-connected" };

  let rates;
  try {
    rates = await readXeroTaxRates({ fresh: true });
  } catch {
    return { refused: "xero-unreadable" };
  }
  const problem = xeroTaxCategoryRateProblem(rates, category, taxType);
  if (problem) return { refused: "xero-code", message: problem };

  return prisma.$transaction(
    async (tx) => {
      if ((await connectedTenantId(tx)) !== tenantId) return { refused: "not-connected" as const };
      const existing = await tx.xeroTaxCategoryMapping.findUnique({
        where: { category },
        select: { taxType: true, xeroTenantId: true },
      });
      if (existing?.taxType === taxType && existing.xeroTenantId === tenantId) return { refused: "unchanged" as const };
      await tx.xeroTaxCategoryMapping.upsert({
        where: { category },
        create: { category, taxType, xeroTenantId: tenantId, updatedByMemberId: actingMemberId },
        update: { taxType, xeroTenantId: tenantId, updatedByMemberId: actingMemberId },
      });
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "XERO_TAX_CATEGORY_MAPPED",
          actor: { memberId: actingMemberId },
          entity: { type: "XeroTaxCategoryMapping", id: category },
          // Installation configuration, like CLUB_TAX_TREATMENT_SCHEDULED.
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: `Xero tax category ${category} mapped to ${taxType}`,
          metadata: {
            category,
            taxType,
            previousTaxType: existing?.taxType ?? null,
            tenantChanged: existing !== null && existing.xeroTenantId !== tenantId,
          },
          request: getAuditRequestContext(request),
        }),
      );
      return { changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function clearXeroTaxCategory({
  category,
  actingMemberId,
  request,
}: {
  category: MappedXeroTaxCategory;
  actingMemberId: string;
  request: Request;
}): Promise<XeroTaxCategoryWriteOutcome> {
  const inUse = category === "EXEMPT" ? await exemptClearRefusalWhileOpeningCreditsMapped() : null;
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.xeroTaxCategoryMapping.findUnique({ where: { category }, select: { taxType: true } });
      if (!existing) return { refused: "not-found" as const };
      if (inUse) return { refused: "in-use" as const, message: inUse };
      await tx.xeroTaxCategoryMapping.delete({ where: { category } });
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "XERO_TAX_CATEGORY_CLEARED",
          actor: { memberId: actingMemberId },
          entity: { type: "XeroTaxCategoryMapping", id: category },
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: `Xero tax category ${category} mapping cleared`,
          metadata: { category, previousTaxType: existing.taxType },
          request: getAuditRequestContext(request),
        }),
      );
      return { changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
}
