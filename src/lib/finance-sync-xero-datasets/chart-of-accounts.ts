import { FinanceSnapshotType, Prisma } from "@prisma/client";
import type { Account } from "xero-node";
import type {
  FinanceSyncDatasetContext,
  FinanceSyncSnapshotInput,
} from "@/lib/finance-sync-service";
import { callXeroApi } from "@/lib/xero";
import { getFinanceReportWindow, toOptionalText } from "./date-format";
import { compareNullableStrings } from "./invoice-helpers";

interface FinanceChartOfAccountsEntryPayload {
  accountId: string;
  code: string | null;
  name: string | null;
  type: string | null;
  class: string | null;
  status: string | null;
}

interface FinanceChartOfAccountsPayload {
  accountCount: number;
  accounts: FinanceChartOfAccountsEntryPayload[];
}

// test seam
/**
 * Map the operational chart of accounts into a JSON-safe snapshot. The stored
 * AccountID-to-GL-code entries let revenue reconciliation match profit-and-loss
 * rows (which carry an "account" cell attribute holding the AccountID) to their
 * GL codes without a live Xero call. Mirrors the active-account selection used by
 * the admin chart-of-accounts route, but keeps every account that has an
 * AccountID (including archived ones) so historical reports still resolve.
 */
export function buildFinanceChartOfAccountsSnapshot(input: {
  asOfDate: Date;
  accounts: readonly Account[];
}): FinanceSyncSnapshotInput {
  const entries: FinanceChartOfAccountsEntryPayload[] = input.accounts
    .map((account) => {
      const accountId = toOptionalText(account.accountID);
      if (!accountId) {
        return null;
      }

      return {
        accountId,
        code: toOptionalText(account.code),
        name: toOptionalText(account.name),
        type: account.type != null ? String(account.type) : null,
        class: account._class != null ? String(account._class) : null,
        status: account.status != null ? String(account.status) : null,
      } satisfies FinanceChartOfAccountsEntryPayload;
    })
    .filter((entry): entry is FinanceChartOfAccountsEntryPayload => entry !== null)
    .sort(
      (left, right) =>
        compareNullableStrings(left.code, right.code) ||
        compareNullableStrings(left.name, right.name)
    );

  const payload = {
    accountCount: entries.length,
    accounts: entries,
  } as Prisma.InputJsonObject & FinanceChartOfAccountsPayload;

  return {
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    asOfDate: input.asOfDate,
    periodEnd: input.asOfDate,
    rowCount: entries.length,
    payload,
  };
}

export async function syncFinanceChartOfAccountsSnapshot(
  context: FinanceSyncDatasetContext
): Promise<FinanceSyncSnapshotInput> {
  const window = getFinanceReportWindow(context.startedAt, context.clubTimeZone);
  // getAccounts only needs accounting.settings.read, which the operational Xero
  // connection already holds, so this dataset works even before the one-time
  // granular report-scope re-consent that the report datasets require.
  const response = await callXeroApi(
    () => context.xero.accountingApi.getAccounts(context.xeroTenantId),
    {
      operation: "getAccounts",
      resourceType: "ACCOUNT",
      workflow: context.workflow,
      context: "financeSyncDatasets chartOfAccounts",
    }
  );

  return buildFinanceChartOfAccountsSnapshot({
    asOfDate: window.asOfDate,
    accounts: response.body.accounts ?? [],
  });
}
