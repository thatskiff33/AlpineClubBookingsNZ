import { PINNED_QUEUE_RECORD_NOTE } from "@/lib/admin-list-page"

/** The line above a deep-linked record pinned over a queue page (INV-OPS-017). */
export function PinnedQueueRecordNote() {
  return <p className="text-sm font-medium text-warning-11">{PINNED_QUEUE_RECORD_NOTE}</p>
}
