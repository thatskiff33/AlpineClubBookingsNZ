# #3414 independent money correctness review

Reviewed exact commit: `bd9860010c1f07738776603557298a3bd95967d4`.
Comparison: `e66667fab..bd9860010` (36 files). Read committed source through `git show` / `git diff`; later working-tree edits and later commits are excluded.

## Confirmed finding

**P2 — preserve the diagnostics budget's accepted dollar-prefix grammar in the shared control.**

`src/app/(admin)/admin/ai-diagnostics/_components/diagnostics-budget-card.tsx:295` passes its raw `draft` to `MoneyInput`. Its existing `dollarsToCents` at line 76 deliberately strips a leading `$`, so `$25.00` remains a valid, saveable 2500-cent draft. `MoneyInput` at `src/components/ui/money-input.tsx:94` instead parses the raw text using the strict canonical parser, gets `null`, disables both whole-dollar buttons, and makes ArrowUp/ArrowDown do nothing. The precision filter likewise inspects raw text, so `$25.001` bypasses the plain decimal third-fractional-digit restriction. The issue's owner decision requires those affordances at every migrated money site while preserving existing caller contracts.

Refutation checked: normalization is only applied by the caller's dirty/save calculation; it is not supplied to the control. The canonical parser must remain strict because other callers deliberately refuse currency-prefixed drafts. No incorrect cents are persisted: saving `$25.001` still produces the existing visible error. This is a confirmed adoption/affordance defect. Root confirmed the scenario and is arranging a surgical shared-normalization fix separately.

## Other conclusions

No additional money correctness findings in this isolated delta. The canonical exact cent parsers are unchanged. Whole-dollar steps use parsed integer cents, retain the fractional cents, refuse malformed/empty drafts, enforce the parser's int32-safe range, and respect disabled/read-only states. The only genuinely signed migrated input, manual member credit adjustments, enables `allowNegative` and continues through the existing signed parser. Refund direction remains separate from unsigned magnitude. Optional overrides, unpriced historical-night drafts, explicit zero rates, promo values/caps, payment filters, and quote totals retain their existing draft setters, exact parsing, and submission validation.

Root's separate single-source finding at this baseline: `canStep` and `step` duplicate the parse and `direction * 100` arithmetic. Their current behavior matches, so no present wrong-money scenario was found. Root reports this has been centralized in later commit `06460a44c`; that later change is not approved by this baseline review and belongs to the separate final UI/contracts review.

## Source and limits

Read the fresh complete source issue cache `handoff/3678-codex/evidence/3414-current-thread.log`, the always-read core, the routed money/authoritative-fees, architecture/settings, testing/guard and single-source instructions, the complete 36-file diff, the component/parsers and changed tests, and surrounding consumers/submit parsers needed to check the stated scenarios. Existing changes from #3794/main outside the isolated delta were excluded.

Read-only source review. No runtime tests, full suite, install, source edits, commits, GitHub writes, or push were performed. The parent supplied its own test results; those are not independent execution evidence from this reviewer. Only this authorized private checkpoint was written.

