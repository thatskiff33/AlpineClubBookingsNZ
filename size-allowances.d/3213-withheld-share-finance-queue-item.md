# File-size allowances for #3213

One file this change makes longer was already over budget on `main`. The other
production file it touches, `src/lib/manual-refund-task-resolution.ts`, was
**inside** its 700-line budget on the base ref and gets no entry here — none
would be honoured, and none is wanted: the dismiss-only rule and its refusal
sentence were put in a module of their own instead
(`src/lib/manual-refund-task-settlement-rules.ts`), which is the split the gate
exists to force. It is also the better home, because the settle screen has to
read the same rule and cannot import from a `server-only` module.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 1690
reason: this is where the whole officer-facing half of #3213 lands, and it is
  words rather than machinery — a standing paragraph that appears only when a
  withheld share is present, a per-row instruction that puts "check Xero" before
  "bill the shortfall" and refuses to name a figure on the row whose amount is
  not knowable, an "Amount not known" reading that must not be confused with
  "Awaiting pricing", and the two dialog sentences for a close that moves no
  money. The hazard here runs one way — billing a member a second time for money
  already asked for — so the wording IS the safety, and it has to sit beside the
  row it describes. The one piece of behaviour, whether a completion control
  exists at all, was deliberately NOT written here: it is asked of the shared
  settlement rule the server refuses on, so the screen and the door cannot drift.
  The obvious split is still to lift the evidence renderer out, and #3033's
  allowance already rejected that on evidence rather than effort: FIVE suites now
  scan this file BY PATH — `view-only-banner-contract`,
  `late-capture-decision-provenance`, `unverified-write-copy-contract`,
  `stored-night-price-repair-census` (which pins it as its `SCOPED_FILE`), and
  this issue’s own `uncollected-edit-review-share-expand` — and moving code out of a
  path a disk-scanning guard hardcodes is this repository's known silent
  false-green — the guard keeps passing over the half that stayed. Re-pointing
  and mutation-proving four guards is an issue of its own, not a line-count tidy
  ridden in on a money-copy change.
