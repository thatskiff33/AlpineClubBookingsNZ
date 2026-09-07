# File-size allowances for #3326 (#3302, one `formatCents`)

Three already-oversized report modules grow slightly, and in all three cases
**the code got shorter and the comment got longer**. Each had a local
`formatCents` copy; each now either calls the canonical helper or composes from
it, and each carries a docblock saying why it is not simply the canonical call.

That comment is the point of the change rather than overhead on it. The whole
defect this issue fixes is nine copies of a money formatter that nobody could
tell apart, and three of the seven copies #3264 unified had silently drifted. A
site that legitimately renders differently must say so where the next reader
looks, or the next single-source-of-truth pass deletes it as a leftover and
changes a report line by accident. Splitting any of these files would separate
the explanation from the thing it explains, which is the opposite of what is
wanted.

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
lines: 793
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
