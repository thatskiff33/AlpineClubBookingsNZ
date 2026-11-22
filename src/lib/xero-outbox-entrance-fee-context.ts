/**
 * The entrance-fee context a queued outbox payload already carries, moved here
 * verbatim from `xero-operation-outbox.ts` so that module stays within its size
 * ceiling (#5005). Pure: it reads the payload and touches nothing else.
 */
import type { EntranceFeeContext } from "@/lib/xero-mappings";
import { XERO_OUTBOX_ENTRANCE_FEE_TYPE, type QueuedOutboxPayload } from "@/lib/xero-operation-outbox-payload";

export function buildPrecomputedEntranceFeeContext(
  payload: QueuedOutboxPayload
): EntranceFeeContext | null {
  if (
    payload.queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE ||
    !payload.category ||
    payload.feeAmountCents === null ||
    payload.feeAmountCents === undefined
  ) {
    return null;
  }

  const entranceFeeContext: EntranceFeeContext = {
    category: payload.category,
    feeMapping: {
      itemCode: payload.itemCode ?? null,
      amountCents: payload.feeAmountCents,
    },
  };
  if (payload.description) {
    entranceFeeContext.description = payload.description;
  }

  return entranceFeeContext;
}
