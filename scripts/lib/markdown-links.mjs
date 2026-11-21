/**
 * The Markdown link shapes `check-doc-links.mjs` checks and the release
 * compiler rebases (#5214), defined once so a link the checker validates in a
 * changelog fragment is the same link the compiler rewrites.
 */

/**
 * Inline links and images: `![alt](target)` and `[text](target)`. Group 1 is
 * everything before the target, group 2 the target, which stops at whitespace
 * or `)`, so `[x](a.md "title")` yields `a.md`.
 */
export const INLINE_LINK = /(!?\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)/g;

/** Reference definitions at line start, `[label]: target`; groups as above. */
export const REF_DEF = /^(\s*\[[^\]]+\]:\s*)(\S+)/;

/** A line that opens or closes a fenced code block, whose links are examples. */
export const FENCE_TOGGLE = /^\s*(```|~~~)/;
