import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import {
  buildFinanceAgedPayablesSnapshot,
  buildFinanceAgedReceivablesSnapshot,
} from "./aged-invoices-snapshot";
import { getFinanceReportWindow } from "./date-format";
import { listFinanceOpenInvoices } from "./open-invoices";
import {
  buildFinanceAccountsPayableInvoicesSnapshot,
  buildFinanceAccountsReceivableInvoicesSnapshot,
} from "./open-invoices-snapshot";

export async function syncFinanceAgedReceivablesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCREC",
    contextLabel: "agedReceivables",
  });

  return buildFinanceAgedReceivablesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAccountsReceivableInvoicesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCREC",
    contextLabel: "accountsReceivableInvoices",
  });

  return buildFinanceAccountsReceivableInvoicesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAgedPayablesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCPAY",
    contextLabel: "agedPayables",
  });

  return buildFinanceAgedPayablesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}

export async function syncFinanceAccountsPayableInvoicesSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  const invoices = await listFinanceOpenInvoices(context, window.asOfDateString, {
    invoiceType: "ACCPAY",
    contextLabel: "accountsPayableInvoices",
  });

  return buildFinanceAccountsPayableInvoicesSnapshot({
    asOfDate: window.asOfDate,
    invoices,
  });
}
