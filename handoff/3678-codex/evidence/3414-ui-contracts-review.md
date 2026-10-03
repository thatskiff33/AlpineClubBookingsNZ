# 3414 independent UI, accessibility, permissions and test-contract review

Reviewed source: e66667fab..06460a44c6ae8ae7f0a0abe0034d9294cd2396c2 (36 changed files), including the final nextStepValue convergence after bd9860010. Read-only review; no repository edits, installs, commits, GitHub writes, browser/server or test execution.

## Confirmed finding

P2: src/components/ui/money-input.tsx:86 builds aria-describedby with caller descriptions before its generated error ID. A caller providing its FieldHint association and error prop therefore announces help/example before the actionable error. docs/ARCHITECTURE.md's FieldHint contract explicitly requires the error before the hint. The component test supplies both descriptions and error but checks only membership, allowing this inversion. No current migrated production consumer uses the error prop, so this is a defect in the newly introduced shared API rather than an observed migrated-form regression. Remedy: prepend generated errorId, preserve caller ID ordering after it, and assert the exact order in the existing component test. Root confirmed and triaged this finding during review; the reviewed SHA predates its fix.

## Remaining review

No further confirmed finding. Migrated onValueChange callbacks retain prior state transformations; payments filters still reset pagination; signed member-credit adjustments opt into the canonical signed parser. Disabled/readOnly props prevent both step buttons and ArrowUp/ArrowDown mutations; controls are type=button. Native label association is preserved for existing labelled fields; approval mapping changes an enclosing label to a div and lets MoneyInput produce its own associated label, avoiding nested labelable controls. Existing external error/hint associations remain on their textbox. View-only dialogs/forms retain their caller gating and staged-edit boundaries. The final nextStepValue supplies both direction availability and the exact emitted value from one definition.

Source guard reuses the existing JSX walker; AST matching ignores comment prose and fixtures pin reintroduced legacy spreads/raw decimal inputs plus legitimate MoneyInput and exchange-rate controls. The existing number-input guard remains responsible for money type=number detection. These are source-shape guards, not proof against computed/spread attributes; do not claim exhaustive money-field semantic classification. Updated historical-price tests retain exhaustive button inventory and specifically assert blank-night controls cannot invent a value. Third-decimal validation fixtures were replaced with invalid suffixes because third decimals are now blocked at editing, while the MoneyInput suite directly tests that editing refusal.

## Sources and limits

Read AGENTS and the current issue thread captured by the orchestrator's repository CLI; reused unchanged core/routed sources from the preceding review and read current money input, architecture/admin pattern, money/SSOT/testing, UI flow/coverage, security, relevant production consumers and changed tests/guards. git diff --check on the reviewed range passed. No screen reader, browser layout inspection, tests/mutations, lint/typecheck or full suite were independently run. Fixed-width inputs now have adjacent controls and increase field width; no concrete overflowing layout was established by source inspection, so no speculative layout finding is reported.

