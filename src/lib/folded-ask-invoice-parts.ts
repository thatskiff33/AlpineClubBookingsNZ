import {
  recordedFoldedAskInvoiceCents,
  recordedFoldedIncreaseAsks,
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
  recordedReissuedAskInvoiceUnsureCents,
} from "@/lib/unpaid-ask-offset-marker";

/**
 * Each actual invoice anchor in a fold, including nested folds. An increase's
 * recorded invoice figure includes its children; its own parked invoice does
 * not. Reductions must exclude only the part each parked anchor covers.
 */
export function foldedAskInvoiceParts(
  newData: unknown,
  modifications: readonly { id: string; newData: unknown }[],
): { parts: { modificationId: string; invoiceCents: number }[]; unsure: boolean } {
  const byId = new Map(modifications.map((row) => [row.id, row]));
  const parts: { modificationId: string; invoiceCents: number }[] = [];
  const seen = new Set<string>();
  let unsure = false;
  const histories = [newData];
  while (histories.length > 0) {
    const history = histories.pop();
    const increases = recordedFoldedIncreaseAsks(history);
    unsure ||= increases.unsure;
    let total = 0;
    for (const modificationId of recordedFoldedReissuedAskModificationIds(history)) {
      const child = byId.get(modificationId);
      const invoiceCents = recordedReissuedAskInvoiceCents(child?.newData);
      total += invoiceCents;
      unsure ||= !child || recordedReissuedAskInvoiceUnsureCents(child.newData) > 0;
      add(modificationId, invoiceCents);
    }
    for (const entry of increases.entries) {
      const child = byId.get(entry.modificationId);
      const nestedCents = recordedFoldedAskInvoiceCents(child?.newData);
      total += entry.invoiceCents;
      unsure ||= !child || entry.invoiceUnsure || nestedCents > entry.invoiceCents;
      if (add(entry.modificationId, Math.max(0, entry.invoiceCents - nestedCents)) && child) {
        histories.push(child.newData);
      }
    }
    unsure ||= total !== recordedFoldedAskInvoiceCents(history);
  }
  return { parts, unsure };

  function add(modificationId: string, invoiceCents: number): boolean {
    if (seen.has(modificationId)) {
      unsure = true;
      return false;
    }
    seen.add(modificationId);
    parts.push({ modificationId, invoiceCents });
    return true;
  }
}
