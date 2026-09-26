# File-size allowances for #3641 — a waiting invoice outlives age and a decline while payable

The stale WAITING_PAYMENT reaper now asks the member's pay door before it
retires a supplementary invoice, and exports the lock namespace, status set,
payload reader and retirement codes the new late-capture re-queue module reads.
The re-queue itself lives in `src/lib/xero-supplementary-invoice-late-capture.ts`,
inside its budget, so only the reaper change lands here.

file: src/lib/xero-operation-outbox.ts
lines: 3375
reason: the reaper's two arms and their F19 grace already live here and the
  new survival test has to sit inside the same loop that decides a retirement;
  moving the reaper out would split it from the WAITING_PAYMENT release and
  the queue states it guards, which is the pairing this fix is about.
