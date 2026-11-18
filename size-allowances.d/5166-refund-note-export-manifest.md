# Size allowances for #4525 (Ledger M13): refund-note export manifests

file: src/lib/xero-credit-notes.ts
lines: 1337
reason: the refund note's three exits (two replays and the fresh send) each
  call the manifest recorder once, beside the return it describes, plus two
  import lines. Moving the calls out would need the caller to know which exit
  ran and which lines were sent, which only this function knows.

function: src/lib/xero-credit-notes.ts#createXeroCreditNote
lines: 655
reason: the same three recorder calls, one or two lines each, at the exits of
  the function that already owns the note's replay and send paths; splitting
  it is a refactor of its own.
