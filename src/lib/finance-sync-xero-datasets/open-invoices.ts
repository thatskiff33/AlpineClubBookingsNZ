import type { Invoice } from "xero-node";
import type { FinanceSyncDatasetContext } from "@/lib/finance-sync-service";
import { callXeroApi } from "@/lib/xero-api-client";
import { buildOpenInvoiceWhereClause } from "./invoice-helpers";
import { withFinanceReportScopeError } from "./report-snapshot";
import type { FinanceOpenInvoiceType } from "./types";

const FINANCE_XERO_PAGE_SIZE = 100;
const FINANCE_AGED_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
] as const;

const financeOpenInvoiceListCache = new WeakMap<
  FinanceSyncDatasetContext,
  Map<string, Promise<Invoice[]>>
>();

function getFinanceOpenInvoiceCache(
  context: FinanceSyncDatasetContext
): Map<string, Promise<Invoice[]>> {
  const existingCache = financeOpenInvoiceListCache.get(context);
  if (existingCache) {
    return existingCache;
  }

  const nextCache = new Map<string, Promise<Invoice[]>>();
  financeOpenInvoiceListCache.set(context, nextCache);
  return nextCache;
}

export async function listFinanceOpenInvoices(
  context: FinanceSyncDatasetContext,
  asOfDateString: string,
  options: {
    invoiceType: FinanceOpenInvoiceType;
    contextLabel: string;
  }
): Promise<Invoice[]> {
  const cacheKey = `${options.invoiceType}:${asOfDateString}`;
  const cache = getFinanceOpenInvoiceCache(context);
  const cachedPromise = cache.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  const invoicePromise = (async () => {
    const invoices: Invoice[] = [];
    let page = 1;

    while (true) {
      const response = await withFinanceReportScopeError(
        "getInvoices",
        () =>
          callXeroApi(
            () =>
              context.xero.accountingApi.getInvoices(
                context.xeroTenantId,
                undefined,
                buildOpenInvoiceWhereClause(options.invoiceType, asOfDateString),
                "DueDate ASC",
                undefined,
                undefined,
                undefined,
                [...FINANCE_AGED_INVOICE_STATUSES],
                page,
                false,
                false,
                undefined,
                false,
                FINANCE_XERO_PAGE_SIZE
              ),
            {
              operation: "getInvoices",
              resourceType: "INVOICE",
              workflow: context.workflow,
              context: `financeSyncDatasets ${options.contextLabel} page ${page}`,
            }
          )
      );

      const pageInvoices = response.body.invoices ?? [];
      invoices.push(...pageInvoices);

      if (pageInvoices.length < FINANCE_XERO_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return invoices;
  })();

  cache.set(cacheKey, invoicePromise);

  try {
    return await invoicePromise;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}
