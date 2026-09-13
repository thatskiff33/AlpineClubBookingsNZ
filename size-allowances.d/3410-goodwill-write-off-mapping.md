# File-size allowances for #2717 — goodwill posts to its own expense mapping

One already-over-budget file grows, by twenty-four lines. **A split was taken
rather than allowed for first:** the fix round pushed
`src/lib/xero-applied-credit-allocation.ts` from 607 to 794 lines, past its
700-line ceiling for the first time — which an allowance cannot carry anyway —
so the accounting policy came out into
`src/lib/xero-applied-credit-mint-accounts.ts`, a leaf module with no Prisma, no
provider client and no outbox in it. That is the honest seam: which Xero mapping
a minted share posts to is a rule a treasurer can be shown, and the engine
around it is orchestration. The engine is back under its budget at 659 lines and
needs no allowance.

file: src/lib/setup-readiness.ts
lines: 2217
reason: Twenty-four lines on the `xero-mappings` step, so it names a mapping key that is unset and falling back instead of reporting "configured" off a row count that cannot see one. The owner's decision (#2717) rejected silence, and the Xero screen's own notice cannot carry that alone — its mappings section is collapsed by default and only loads when opened, so an upgrading club would be told it had nothing to do while goodwill quietly posted to the hut-fee-refund account. There is no seam here: this file is one function per checklist step over a single database snapshot, and the step being edited is eight lines of status, message and details that have to read the same snapshot as the three counts beside them. The key set itself is NOT hand-listed — it is derived from the mapping registry, so a second fallback-bearing key is surfaced without this file growing again.
