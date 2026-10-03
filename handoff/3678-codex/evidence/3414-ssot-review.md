# #3414 standing SSOT lens

Root inspected the whole isolated e66667fab..bd9860010 MoneyInput diff, canonical parsers/formatting and shared TypeScript source scanner. The shared control is the single editing/stepping home. All production legacy MONEY_INPUT_PROPS spreads were retired rather than preserving a competing affordance definition. Exact signed/unsigned parsers and formatCentsPlain remain existing authorities. The two guards have distinct contracts and reuse jsxSourceFiles; TypeScript AST normalization avoids a competing comment stripper.

Confirmed duplication: canStep and step separately derived parsed + direction * 100. Fixed in 06460a44c with one nextStepValue producing both availability and the actual emitted text. Independent correctness reviewer confirmed the duplication; independent UI/contracts reviewer inspected the fixed helper at06460. Existing21tests across3suites and component ESLint passed. No new money contract or speculative regression test introduced.

Independent correctness review also confirmed the Diagnostics budget's existing dollar-prefix grammar was missing from control stepping/precision filtering. Root fixed9ed588094 by extracting ONE normalizeBudgetDraft, used by save's existing canonical parser and passed to MoneyInput. The shared control normalizes for filtering/parsing but preserves visible raw text. Canonical cents grammar/range/format remains unchanged. Error-description order fixed to error before caller hints under FieldHint contract; exact ordering regression strengthened. Four focused files31tests, targeted ESLint, docs index/link, quality budget and diff checks passed.

Root authored those small fixes, so this is not an independent review of root's own code. The third independent boundary reviewer is inspecting final9ed588094 including normalization/SSOT authority. Original correctness review covers bd986, UI/contracts covers06460; both confirmed findings remain explicitly linked to the fix evidence. Source-only root scrutiny is distinct from those agents' reviews.

Later de11163f7 merges96e291eae's school NULL-price fence; all MoneyInput/consumer blobs remain identical to9ed588094. That incoming code has its own review and actual PostgreSQL evidence.

