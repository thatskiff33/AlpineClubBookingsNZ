import {
  isAccountMappingKey,
  mappingCodeClassViolation,
  normalizeMappingCode,
} from "@/lib/xero-account-mapping-keys";
import { readStoredChartOfAccounts } from "@/lib/xero-admin-cache";
import { openingCreditsImportFindings } from "@/lib/xero-opening-credits-exempt-guards";

/**
 * What the two writers of the account mapping rows, the Account Mapping
 * screen's save and the configuration import, both ask before they write
 * (#5235; owner decision of 22 Nov 2026: the kind of account is checked on
 * save, not only in the picker).
 */

type MappingCodeRow = { key: string; code: string | null };

/**
 * One sentence per code the write SETS OR CHANGES that the chart of accounts
 * shows is the wrong kind of account for its mapping
 * (`mappingCodeClassViolation`). A code the write leaves as it is stored is not
 * judged: the screen sends every key on every save and a bundle carries every
 * row, and a club with an older out-of-class code must still be able to change
 * its other mappings. The setup check reports such a code instead.
 *
 * `readChart` is asked only when there is a code to judge. A chart it cannot
 * supply (none cached, or expired) judges nothing.
 */
export async function changedCodeClassViolations(
  stored: Iterable<MappingCodeRow>,
  after: Iterable<readonly [key: string, code: string | null | undefined]>,
  readChart: () => Promise<Parameters<typeof mappingCodeClassViolation>[2]>,
): Promise<string[]> {
  const storedCode = new Map([...stored].map((row) => [row.key, normalizeMappingCode(row.code)]));
  const changed = [...after].filter(([key, code]) => {
    const next = normalizeMappingCode(code);
    return next !== null && next !== (storedCode.get(key) ?? null);
  });
  if (changed.length === 0) return [];
  const chart = await readChart();
  return changed.flatMap(([key, code]) =>
    isAccountMappingKey(key) ? (mappingCodeClassViolation(key, code, chart) ?? []) : [],
  );
}

/**
 * The Account Mapping screen's rules applied to a configuration import, which
 * writes the same rows: the kind of account each set or changed code is, and
 * the Opening Credits rules (#4988, `openingCreditsImportFindings`). An error
 * blocks the apply.
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
  const errors = await changedCodeClassViolations(stored, after, () => readStoredChartOfAccounts(db));
  const openingCredits = await openingCreditsImportFindings(db, stored, after);
  if (openingCredits.error) errors.push(openingCredits.error);
  return { errors, warnings: openingCredits.warning ? [openingCredits.warning] : [] };
}
