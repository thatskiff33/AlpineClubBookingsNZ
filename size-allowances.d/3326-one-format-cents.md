# File-size allowances for #3326 (#3302, one `formatCents`)

Three already-oversized report modules grow slightly, and in all three cases
**the code got shorter and the comment got longer**. Each had a local
`formatCents` copy; each now either calls the canonical helper or composes from
it, and each carries a docblock saying why it is not simply the canonical call.

That comment is the point of the change rather than overhead on it. The whole
defect this issue fixes is a money formatter copied across call sites that
nobody could tell apart, several of which (#3264's `formatSignedCents` copies
among them) had silently drifted. A site that legitimately renders differently
must say so where the next reader looks, or the next single-source-of-truth
pass deletes it as a leftover and changes a report line by accident. Splitting
any of these files would separate the explanation from the thing it explains,
which is the opposite of what is wanted. The exact count of sites this issue
touched is in the pull request description, stated once.

file: src/lib/ib-hold-clearing-audit.ts
lines: 813
reason: the local copy was renamed to `formatIbAuditCents` and its rendering
  left byte-for-byte unchanged, because it hard-codes an `NZ$` prefix that no
  fixture pins. Unifying it would silently change a member-visible currency for
  any club not configured for New Zealand dollars, and two other modules
  hard-code the same prefix with tests pinning them, so changing this one alone
  would make an inconsistency look deliberate. That question is filed as #3325
  with options; the docblock records the evidence on both sides so whoever
  answers it does not have to rediscover it. Fourteen lines, all comment.

file: src/lib/xero-invoice-rounding-audit.ts
lines: 799
reason: this report deliberately shows the dollar amount and the raw signed
  cent delta together, as in `$1.50 (+150c)`, because the exact cent is the
  subject of a rounding-drift audit. The dollar half is now the canonical
  helper, verified byte-identical for both signs and for zero, and only the
  parenthesised suffix is local. Six lines, all comment; the function body
  shrank from four lines to one.

file: src/lib/xero-refund-note-link-repair.ts
lines: 870
reason: this report reads as a bare decimal with no symbol and no grouping, and
  renders a null amount as the word unknown rather than a formatted zero. Both
  are pinned by its own fixture, so it takes the canonical helper's plain style
  and keeps the null handling locally. Ten lines, all comment; the body shrank
  to a single delegating call.

Four more already-oversized files grow by one import line each, for the same
reason across all four: a former hard-coded `"$" + (cents / 100).toFixed(2)`
copy folded into the shared, currency-aware `formatCents`, found either by
this issue's own comparison or by the two follow-up reviews it went through.
None gained a second definition; each gained one `import` line and lost its
local one, for a net change of +1.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1015
reason: one hard-coded "$"+toFixed(2) waitlist-offer price cell, unnamed by
  either review, folded into `formatCents`. +1 line (the import).

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 257
reason: two hard-coded "$"+toFixed(2) messages (a refusal and an audit detail
  line), unnamed by either review, folded into `formatCents`. +1 line (the
  import; the two call-site edits net to the same line count).

file: src/lib/booking-cancel.ts
lines: 2424
reason: three hard-coded "$"+toFixed(2) cancellation messages, unnamed by
  either review, folded into `formatCents` — deliberately NOT its fourth,
  already-tracked `NZ$` line (#3325). +1 line (the import).

file: src/lib/audit-query.ts
lines: 1179
reason: two separate fixes landed here. `formatMetadataFragment` was exported
  as a test seam (#3302's own review, matching this file's existing
  `inferAuditCategoryFromAction` convention) so the switch to the shared
  formatter is asserted rather than claimed — a one-line change. Separately,
  the equivalence review found this function passes an unvalidated JSON
  number straight to `formatCents` with no integer guarantee, and measured a
  real rounding-MODE difference at a half-cent between the old `.toFixed(2)`
  body and `Intl.NumberFormat`; a `Math.round` guard and its docblock close
  it, matching the guard `xero-operation-summaries.ts` already carries on the
  same shared helper. +8 lines, mostly comment.


## Re-measured by #3338, and why this file rather than a second one

`INV-PAY`-adjacent bookkeeping aside, the rule the checker enforces is **one
file, one allowance**. #3338 (type-safety stage 3) also grew two of the files
declared here, so it could not add its own entries for them — the checker
refuses a second allowance on the same file, correctly, because two entries
would each describe half a change and neither would describe the file.

So the two lengths above were re-measured on the composed tree instead:
`xero-invoice-rounding-audit.ts` 793 to 799 and `audit-query.ts` 1178 to 1179.
The reasons already written for each still hold — stage 3's additions are the
same kind of change, an absent case handled rather than asserted away — and
nothing else in this file moved.

Recorded here rather than silently, because a merged allowance whose number a
later branch invalidates is exactly the sort of thing that gets adjusted without
being measured.
