# File-size allowances for #4630 — one money ceiling

`src/app/api/admin/fee-configuration/route.ts` spelled the integer-cents
ceiling as a literal. The review of #4630 (Ledger M3a, #4626) asked for one
exported ceiling, `MAX_INTEGER_CENTS` in `src/lib/money-input.ts`, used at
every money boundary (`INV-SSOT-001`, `INV-MONEY-001`). The literal is replaced
in place; the growth is the one import line that brings the constant in.

file: src/app/api/admin/fee-configuration/route.ts
lines: 488
reason: the single import of the shared ceiling, replacing a hand-written
  literal. There is nothing to split out: the route's money schema already
  lives in one line and now reads the one definition.
