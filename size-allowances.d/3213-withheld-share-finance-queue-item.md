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
  allowance already rejected that on evidence rather than effort. That evidence
  is re-measured here, because the count this allowance first published was
  wrong in the direction that flatters it. FIVE suites reach this file; only
  TWO of them are the hazard being argued from. A guard that hardcodes this
  path and asserts an ABSENCE is the one a move disarms silently — it keeps
  passing over the half that stayed, which is this repository's known
  false-green — and there are two: `stored-night-price-repair-census` (it pins
  the file as its `SCOPED_FILE` and scans the whole of it for an undeclared
  money display) and `unverified-write-copy-contract` (a by-path row whose
  `bannedPhrase` half is exactly such an absence). The other three reach the
  file and would fail LOUDLY rather than quietly, so they are not part of this
  argument: `view-only-banner-contract` walks `src/` and never names this path
  at all; `late-capture-decision-provenance` lists the path, but its fourth
  half re-derives the list from a tree walk, so a moved citation fails by name;
  and this issue's own `uncollected-edit-review-share-expand` walks every file
  under `src/` and allows only two to name the label, so code moved out of here
  fails the moment it arrives somewhere new. Re-pointing and mutation-proving
  the two real ones is still an issue of its own rather than a line-count tidy
  ridden in on a money-copy change — but it is two, and saying five was an
  argument this file could not cash.
