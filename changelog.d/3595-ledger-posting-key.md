- **The booking ledger can no longer post the same event twice (#3595).** A
  booking can pass the settle's PAID claim twice — an officer marks it paid,
  reverses the mark-paid, and the member then pays by card — and every
  settlement writer is an upsert a provider replays. Each ledger line now
  carries an idempotency key derived from the event it records, and a repeat
  is skipped rather than refused, so it can neither duplicate a line nor abort
  the transaction it runs in. Nothing reads the ledger yet (#3584), so no
  figure anyone sees changes; this makes the lines trustworthy before they
  are.
