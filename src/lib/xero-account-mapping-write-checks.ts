import type { Prisma } from "@prisma/client";
import {
  isAccountMappingKey,
  mappingCodeClassViolation,
  mappingCodeMissingFromChart,
  mappingCodeUnlistedRefusal,
  normalizeMappingCode,
  type AccountMappingKey,
} from "@/lib/xero-account-mapping-keys";
import { readStoredChartOfAccounts, type XeroAccount } from "@/lib/xero-admin-cache";
import { isConnectedTenant, readXeroConnection } from "@/lib/xero-connection";
import { openingCreditsImportFindings } from "@/lib/xero-opening-credits-exempt-guards";

/**
 * What the two writers of the account mapping rows, the Account Mapping
 * screen's save and the configuration import, both ask before they write.
 * Pure of the module database client and of Xero, so the import's plan can
 * run it on its own client; the save reads its chart in
 * `xero-account-mapping-save.ts`
 * (#5235; owner decisions of 22 Nov 2026, the kind of account is checked on
 * save, not only in the picker, and of 28 Nov 2026, the save fetches the chart
 * first and refuses what it cannot place).
 */

type MappingCodeRow = { key: string; code: string | null };

/**
 * The chart a mapping write judges its codes against:
 *
 * - `not-connected`: no Xero organisation, so nothing to judge and nothing is
 *   sent; the codes are written unchecked;
 * - `chart`: the connected organisation's active accounts, fresh;
 * - `unavailable`: connected, but no fresh chart could be had. The write is
 *   refused, and may be retried.
 */
export type MappingWriteChart =
  | { kind: "not-connected" }
  | { kind: "chart"; accounts: XeroAccount[] }
  | { kind: "unavailable" };

export const XERO_CHART_UNAVAILABLE_FOR_SAVE =
  "Xero couldn't be checked, so the accounts chosen could not be confirmed. Nothing was saved; try again.";

export const XERO_CHART_UNAVAILABLE_FOR_IMPORT =
  "The connected Xero organisation's chart of accounts has not been read in the last hour, so the account codes this bundle sets cannot be checked. Open Admin → Xero → Account Mappings and refresh the Xero reference data, then import again.";

/**
 * The configuration import's chart. Its plan runs a second time inside the
 * apply's transaction, so Xero is never asked here; the stored chart is read
 * through the plan's own client (`INV-LOCK-004`). Connected with no fresh
 * stored chart is `unavailable`: the import says how to refresh it.
 */
async function readChartForMappingImport(
  db: Pick<Prisma.TransactionClient, "xeroAdminCache" | "xeroConnection">,
): Promise<MappingWriteChart> {
  if (!isConnectedTenant((await readXeroConnection(db)) ?? null)) return { kind: "not-connected" };
  const stored = await readStoredChartOfAccounts(db);
  return stored ? { kind: "chart", accounts: stored } : { kind: "unavailable" };
}

/**
 * The account codes a write SETS OR CHANGES, by key. A code the write leaves as
 * it is stored is not judged: the screen sends every key on every save and a
 * bundle carries every row, and a club with an older out-of-class code must
 * still be able to change its other mappings. The setup check reports such a
 * code instead.
 */
export function changedMappingCodes(
  stored: Iterable<MappingCodeRow>,
  after: Iterable<readonly [key: string, code: string | null | undefined]>,
): Array<{ key: AccountMappingKey; code: string }> {
  const storedCode = new Map([...stored].map((row) => [row.key, normalizeMappingCode(row.code)]));
  return [...after].flatMap(([key, code]) => {
    const next = normalizeMappingCode(code);
    return next !== null && next !== (storedCode.get(key) ?? null) && isAccountMappingKey(key) ? [{ key, code: next }] : [];
  });
}

/** A refused code: the mapping it was for, and the sentence. */
export interface MappingCodeRefusal {
  key: AccountMappingKey;
  message: string;
}

/**
 * One refusal per changed code the chart cannot accept: an account the chart
 * does not list (archived, deleted, or created since the chart was read), or
 * one it shows is the wrong kind for its mapping (`mappingCodeClassViolation`).
 */
export function changedCodeRefusals(
  changed: readonly { key: AccountMappingKey; code: string }[],
  accounts: readonly XeroAccount[],
): MappingCodeRefusal[] {
  return changed.flatMap(({ key, code }) => {
    if (mappingCodeMissingFromChart(code, accounts)) return [{ key, message: mappingCodeUnlistedRefusal(key) }];
    const violation = mappingCodeClassViolation(key, code, accounts);
    return violation ? [{ key, message: violation }] : [];
  });
}

/**
 * The Account Mapping screen's rules applied to a configuration import, which
 * writes the same rows: each set or changed code against the connected
 * organisation's chart (`changedCodeRefusals`), and the Opening Credits rules
 * (#4988, `openingCreditsImportFindings`). An error blocks the apply.
 *
 * The chart is the stored one of the organisation connected HERE, read through
 * the plan's own client so the in-lock re-plan stays on its transaction
 * (`INV-LOCK-004`).
 */
export async function accountMappingImportFindings(
  db: Parameters<typeof openingCreditsImportFindings>[0] & Parameters<typeof readStoredChartOfAccounts>[0],
  storedRows: Iterable<MappingCodeRow>,
  after: ReadonlyMap<string, string | null>,
): Promise<{ errors: string[]; warnings: string[] }> {
  const stored = [...storedRows];
  const errors: string[] = [];
  const changed = changedMappingCodes(stored, after);
  if (changed.length > 0) {
    const chart = await readChartForMappingImport(db);
    if (chart.kind === "unavailable") errors.push(XERO_CHART_UNAVAILABLE_FOR_IMPORT);
    if (chart.kind === "chart") errors.push(...changedCodeRefusals(changed, chart.accounts).map((refusal) => refusal.message));
  }
  const openingCredits = await openingCreditsImportFindings(db, stored, after);
  if (openingCredits.error) errors.push(openingCredits.error);
  return { errors, warnings: openingCredits.warning ? [openingCredits.warning] : [] };
}
