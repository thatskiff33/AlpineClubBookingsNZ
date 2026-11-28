import { acquireConfigImportLock } from "@/lib/config-transfer-lock";
import { isTransactionContention } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { normalizeXeroAccountClass } from "@/lib/xero-account-class";
import { normalizeMappingCode, type AccountMappingKey } from "@/lib/xero-account-mapping-keys";
import {
  XERO_CHART_UNAVAILABLE_FOR_SAVE,
  changedCodeRefusals,
  changedMappingCodes,
  type MappingWriteChart,
} from "@/lib/xero-account-mapping-write-checks";
import { readStoredChartOfAccounts, type XeroAccount } from "@/lib/xero-admin-cache";
import { fetchChartOfAccountsFromXero } from "@/lib/xero-chart-of-accounts-fetch";
import { isConnectedTenant, readXeroConnection } from "@/lib/xero-connection";
import logger from "@/lib/logger";
import {
  hutFeeRefundsExpenseSaveRefusal,
  rateRefusedOnExpenses,
  readRefundableTaxTypes,
} from "@/lib/xero-refund-expense-tax";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";
import {
  openingCreditsMappingSaveRefusal,
  openingCreditsSharedAccountSaveProblem,
} from "@/lib/xero-opening-credits-exempt-guards";

/**
 * THE ACCOUNT MAPPING SCREEN'S SAVE (`PUT /api/admin/xero/account-mappings`):
 * its checks and its writes, as one decision (#5235, with #5391 folded in).
 *
 * Refused before anything is written:
 *
 * - a set or changed code the connected organisation's chart does not list, or
 *   shows is the wrong kind of account for its key (`changedCodeRefusals`;
 *   owner decisions on #5235 of 22 Nov 2026, the class is checked on save, and
 *   of 28 Nov 2026, the chart is fetched first). With no fresh stored chart
 *   the save asks Xero for one (`readChartForMappingSave`), and refuses with
 *   503 when Xero cannot be asked. Only while Xero is not connected are codes
 *   written unchecked;
 * - Hut Fee Refunds set or changed to an expense account while Xero says a tax
 *   code a refund note can still carry cannot be used on expenses
 *   (`readRefundableTaxTypes`; 503 when the rates cannot be read);
 * - Opening Credits sharing its account with another mapped role, or being
 *   mapped without the Exempt tax category (`openingCreditsMappingSaveRefusal`).
 *
 * THE LOCK (`INV-LOCK-001` to `INV-LOCK-003`). The shared-account rule is a
 * check over every row followed by writes to some of them, so two saves at
 * once, or a save beside a configuration import, could each pass on the rows
 * they read and both land. The writes therefore run in one transaction that
 * first takes the configuration-import key (`acquireConfigImportLock`), which
 * the import holds from before its in-lock re-plan to its commit, and re-reads
 * the rows through that transaction. It is a narrow key, not the global
 * `lock(1)`: no booking, capacity or money row is read or written here. This
 * transaction takes no other advisory key, so it adds no ordering edge.
 *
 * WHAT RUNS WHERE (`INV-LOCK-004`). The first pass runs before the transaction
 * opens, because it may ask Xero for the chart of accounts and for tax rates
 * (the refund account's and the Exempt prerequisite's). Inside the lock only pure rules
 * run, over the re-read rows:
 *
 * - the shared-account rule again, on the rows as they are now;
 * - a drift check: if the stored code of a key this save writes changed while
 *   the save waited, the first pass judged a state that no longer exists (which
 *   codes the save sets or changes decides both the class check and whether the
 *   Exempt prerequisite was asked), so the save is refused and may be retried.
 *
 * A refused save writes nothing.
 */

type MappingValue = { code?: string | null; itemCode?: string | null };

export type XeroAccountMappingUpdates = Readonly<Record<string, MappingValue | undefined>>;

type StoredMappingRow = { key: string; code: string | null; itemCode: string | null };

export type XeroAccountMappingSaveResult =
  | { ok: true; rows: StoredMappingRow[] }
  | {
      ok: false;
      /** 400: a code is not an account the mapping can take. 409: refused as it stands. 503: Xero could not be asked; retry. */
      status: 400 | 409 | 503;
      error: string;
      /** The one mapping the refusal is about, when it is about one: the screen shows it on that row. */
      key?: AccountMappingKey;
    };

export const MAPPINGS_SAVE_CONTENDED =
  "The account mappings could not be saved because a configuration import or another save is running. Nothing was saved; try again in a moment.";

export const MAPPINGS_CHANGED_WHILE_SAVING =
  "The account mappings were changed by someone else while this save was running. Nothing was saved. Reload the page to see the current mappings, then try again.";

const NOTHING_SAVED = "No account mapping was saved.";

/** Whether a key this save writes a code for holds a different stored code now than the first pass read. */
function writtenCodesDrifted(
  before: readonly { key: string; code: string | null }[],
  now: readonly { key: string; code: string | null }[],
  updates: XeroAccountMappingUpdates,
): boolean {
  const codeIn = (rows: readonly { key: string; code: string | null }[], key: string) =>
    normalizeMappingCode(rows.find((row) => row.key === key)?.code);
  return Object.entries(updates).some(
    ([key, value]) => value?.code !== undefined && codeIn(before, key) !== codeIn(now, key),
  );
}

/**
 * The account mapping save's chart (owner decision, 28 Nov 2026): the stored
 * chart while it is fresh, else the chart asked of Xero now, which is stored
 * for the next reader. Outside any transaction, because it may call Xero
 * (`INV-LOCK-004`). A failed call is logged and reads as `unavailable`.
 */
async function readChartForMappingSave(): Promise<MappingWriteChart> {
  if (!isConnectedTenant((await readXeroConnection(prisma)) ?? null)) return { kind: "not-connected" };
  const stored = await readStoredChartOfAccounts(prisma);
  if (stored) return { kind: "chart", accounts: stored };
  try {
    return { kind: "chart", accounts: (await fetchChartOfAccountsFromXero()).accounts };
  } catch (error) {
    logger.warn({ err: error }, "Could not read the Xero chart of accounts to check an account mapping save");
    return { kind: "unavailable" };
  }
}

/**
 * Hut Fee Refunds set to an expense account that a refund note's tax code
 * cannot sit on (#5235 review): the refusal, 503 when Xero's rates cannot be
 * read, or null. Asked only when the save sets or changes that code and the
 * chart shows an expense account, and Xero only when a registered period a
 * refund note can carry is found.
 */
async function hutFeeRefundsTaxRefusal(
  changed: readonly { key: AccountMappingKey; code: string }[],
  accounts: readonly XeroAccount[] | null,
): Promise<XeroAccountMappingSaveResult | null> {
  const code = changed.find((entry) => entry.key === "hutFeeRefunds")?.code;
  const account = code ? accounts?.find((row) => normalizeMappingCode(row.code) === code) : undefined;
  if (!account || normalizeXeroAccountClass(account.class) !== "EXPENSE") return null;
  const taxTypes = await readRefundableTaxTypes();
  if (taxTypes.length === 0) return null;
  let rates;
  try {
    rates = await readXeroTaxRates({ fresh: true });
  } catch {
    return { ok: false, status: 503, key: "hutFeeRefunds", error: XERO_CHART_UNAVAILABLE_FOR_SAVE };
  }
  const rate = rateRefusedOnExpenses(taxTypes, rates);
  return rate ? { ok: false, status: 409, key: "hutFeeRefunds", error: hutFeeRefundsExpenseSaveRefusal(rate) } : null;
}

export async function saveXeroAccountMappings(
  updates: XeroAccountMappingUpdates,
): Promise<XeroAccountMappingSaveResult> {
  const stored = await prisma.xeroAccountMapping.findMany({ select: { key: true, code: true } });

  // Only the codes this save sets or changes are judged (`changedMappingCodes`).
  const changed = changedMappingCodes(
    stored,
    Object.entries(updates).map(([key, value]) => [key, value?.code] as const),
  );
  let accounts: XeroAccount[] | null = null;
  if (changed.length > 0) {
    const chart = await readChartForMappingSave();
    if (chart.kind === "unavailable") return { ok: false, status: 503, error: XERO_CHART_UNAVAILABLE_FOR_SAVE };
    if (chart.kind === "chart") {
      accounts = chart.accounts;
      const refusals = changedCodeRefusals(changed, accounts);
      if (refusals.length > 0) {
        return {
          ok: false,
          status: 400,
          error: `${refusals.map((refusal) => refusal.message).join(" ")} ${NOTHING_SAVED}`,
          ...(refusals.length === 1 ? { key: refusals[0]!.key } : {}),
        };
      }
    }
  }
  const taxRefusal = await hutFeeRefundsTaxRefusal(changed, accounts);
  if (taxRefusal) return taxRefusal;

  // #4988: Opening Credits never shares its account with another mapped role
  // (owner decision, 21 Nov 2026), and a GST-registered club maps the Exempt
  // tax category before it maps the account.
  const refusal = await openingCreditsMappingSaveRefusal({ stored, updates });
  // 503 only when Xero's tax rates could not be read, as the tax category route answers it.
  if (refusal) return { ok: false, status: refusal.retryable ? 503 : 409, error: refusal.message };

  try {
    return await writeUnderImportLock(stored, updates);
  } catch (error) {
    // #5235 review: a transaction that timed out waiting behind a configuration
    // import's lock, or lost a write conflict, wrote nothing (`isTransactionContention`).
    if (isTransactionContention(error)) return { ok: false, status: 409, error: MAPPINGS_SAVE_CONTENDED };
    throw error;
  }
}

/** The in-lock half: re-read, re-check the pure rules, write (see WHAT RUNS WHERE above). */
function writeUnderImportLock(
  stored: readonly { key: string; code: string | null }[],
  updates: XeroAccountMappingUpdates,
): Promise<XeroAccountMappingSaveResult> {
  return prisma.$transaction(async (tx): Promise<XeroAccountMappingSaveResult> => {
    await acquireConfigImportLock(tx);
    const locked = await tx.xeroAccountMapping.findMany({ select: { key: true, code: true } });

    const shared = openingCreditsSharedAccountSaveProblem(locked, updates);
    if (shared) return { ok: false, status: 409, error: shared };
    if (writtenCodesDrifted(stored, locked, updates)) {
      return { ok: false, status: 409, error: MAPPINGS_CHANGED_WHILE_SAVING };
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      const data: MappingValue = {};
      if (value.code !== undefined) data.code = value.code ?? null;
      if (value.itemCode !== undefined) data.itemCode = value.itemCode ?? null;
      await tx.xeroAccountMapping.upsert({
        where: { key },
        update: data,
        create: { key, code: data.code ?? null, itemCode: data.itemCode ?? null },
      });
    }

    return {
      ok: true,
      rows: await tx.xeroAccountMapping.findMany({
        select: { key: true, code: true, itemCode: true },
      }),
    };
  });
}
