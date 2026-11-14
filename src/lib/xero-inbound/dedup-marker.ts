/**
 * The `ProcessedWebhookEvent` dedup row (source `xero`) of one stored inbound
 * event (`INV-INT-039`). Every writer that resets the event for reprocessing
 * deletes it (the stale-event takeover, a Replay, a failed attempt's release),
 * because a row left in place marks the reprocess PROCESSED unapplied.
 */
export function xeroInboundDedupMarkerWhere(correlationKey: string) {
  return { eventId: correlationKey, source: "xero" } as const;
}
