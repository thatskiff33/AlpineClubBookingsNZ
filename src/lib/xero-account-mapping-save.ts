import { acquireConfigImportLock } from "@/lib/config-transfer-lock";
import { prisma } from "@/lib/prisma";
import { normalizeMappingCode } from "@/lib/xero-account-mapping-keys";
import { changedCodeClassViolations } from "@/lib/xero-account-mapping-write-checks";
import { getCachedChartOfAccounts } from "@/lib/xero-admin-cache";
import {
  openingCreditsMappingSaveRefusal,
  openingCreditsSharedAccountSaveProblem,
} from "@/lib/xero-opening-credits-exempt-guards";

/**
 * THE ACCOUNT MAPPING SCREEN'S SAVE (`PUT /api/admin/xero/account-mappings`):
 * its checks and its writes, as one decision (#5235, with #5391 folded in).
 *
 * Two things are refused before anything is written:
 *
 * - a code the cached chart of accounts shows is the wrong kind of account for
 *   its key (`changedCodeClassViolations`; owner decision of 22 Nov 2026 on
 *   #5235: the class is checked on save, not only in the picker);
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
 * opens, because the Exempt prerequisite may ask Xero for its tax rates and the
 * chart cache reads through the module client. Inside the lock only pure rules
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
      /** 400: a code is the wrong kind of account. 409: refused as it stands. 503: Xero could not be asked; retry. */
      status: 400 | 409 | 503;
      error: string;
    };

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

export async function saveXeroAccountMappings(
  updates: XeroAccountMappingUpdates,
): Promise<XeroAccountMappingSaveResult> {
  const stored = await prisma.xeroAccountMapping.findMany({ select: { key: true, code: true } });

  // Only the codes this save sets or changes are judged (`changedCodeClassViolations`).
  const wrongKind = await changedCodeClassViolations(
    stored,
    Object.entries(updates).map(([key, value]) => [key, value?.code] as const),
    async () => (await getCachedChartOfAccounts())?.values,
  );
  if (wrongKind.length > 0) return { ok: false, status: 400, error: `${wrongKind.join(" ")} ${NOTHING_SAVED}` };

  // #4988: Opening Credits never shares its account with another mapped role
  // (owner decision, 21 Nov 2026), and a GST-registered club maps the Exempt
  // tax category before it maps the account.
  const refusal = await openingCreditsMappingSaveRefusal({ stored, updates });
  // 503 only when Xero's tax rates could not be read, as the tax category route answers it.
  if (refusal) return { ok: false, status: refusal.retryable ? 503 : 409, error: refusal.message };

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
