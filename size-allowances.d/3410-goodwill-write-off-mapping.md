# File-size allowances for #2717 — goodwill posts to its own expense mapping

**No file needs an allowance, and both of the reasons why are worth keeping.**

**A split was taken rather than an allowance.** The fix round pushed
`src/lib/xero-applied-credit-allocation.ts` from 607 to 794 lines, past its
700-line ceiling for the first time — which an allowance cannot carry anyway —
so the accounting policy came out into
`src/lib/xero-applied-credit-mint-accounts.ts`, a leaf module with no Prisma, no
provider client and no outbox in it. That is the honest seam: which mapping a
minted share posts to is a rule a treasurer can be shown, and the engine around
it is orchestration. The engine is back under its budget at 659 lines.

**An allowance for `src/lib/setup-readiness.ts` was written and then withdrawn,
because a sibling child made it unnecessary.** This change adds twenty-four
lines to the `xero-mappings` step, so it names a mapping key that is unset and
falling back instead of reporting "configured" off a row count that cannot see
one. That growth is real and it is still here. But #2933 merged into the epic
while this branch was in review and moved a rate-coverage rule out of the same
file, so the file now sits below its ceiling with this change's twenty-four
lines included, and the check correctly refuses an allowance it does not need.

Recording that here rather than deleting the entry silently, because the lesson
is the one this directory exists for: **a length is measured against the tree
the check will actually judge, which on a child of an epic is the branch merged
with the epic — not the branch alone.** Measured on the branch it read 2217 and
the allowance passed locally; measured on the merge it reads 2162 and the
allowance fails. The second is the one CI runs.
