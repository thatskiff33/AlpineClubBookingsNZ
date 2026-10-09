# File-size allowances for #49 - the Alpine Central Server version pause

Three already-over-budget files grow, measured on the tree composed with #50,
#51, #52 and `main` (the four lanes land as one pull request). The rule itself (parser, comparison,
status, the one pause sentence) and the check service are NEW modules well
inside their budgets - `servernz-api-version.ts`, `servernz-version-check.ts` -
so none of the three below gains the mechanism; each gains only the call site
that has to sit where the thing it governs sits.

`other-lodges-panel.tsx` needs no allowance any more: its editor's form model
moved into `other-lodge-form.ts`, which put the panel back inside its budget.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 321
reason: the fourth provider-specific verify-reset (#52: a replaced central-server
  key forgets the owned-lodge list), and with it the stored server version,
  because both were the replaced key's answer - one import, one awaited call
  to the combined forget writer and the sentence saying so, next to the Xero,
  Stripe and Google resets it mirrors in `applyVerifyReset`, which is the
  file's shape. One entry for the file: #52's own allowance file is folded in
  here, because the ratchet allows one allowance per file per change.

`src/lib/servernz-api.ts` is NOT here, deliberately: the version gate and the
one refusal reader took it from 539 to 754 lines, over its ceiling for the
first time, and the ratchet rightly refuses an allowance for that. The split
taken instead is the wire shapes - the lodge row, the pull envelope, the upload
result, the feed sync, the share and push results, the version answer, and the
contract comments each carries - into `src/lib/servernz-api-schemas.ts`
(declarative, no cycle), which puts the client back inside its budget with the
gate, the version call and `refuse()` still together where every request is
built.

file: src/lib/email-message-registry.ts
lines: 2231
reason: three approved tokens with the comment the approved list requires,
  one EXTRA_TEMPLATE_TOKENS entry, three preview samples, and - owner decision
  "second template" - the `admin-server-version-paused` entry in the admin
  template list with its trigger metadata. The editor's single registry of
  what a template may carry, which is where every other template is declared.
  The sample sentence is pinned equal to the composer by
  `servernz-api-version.test.ts`, so it is not a second copy.

file: src/lib/email-message-token-contract.ts
lines: 723
reason: one OPTIONAL_TEMPLATE_TOKENS entry (`serverVersionNote` is empty on
  every day the versions match) with the two-line note the table's own docblock
  asks each entry to carry; this is the table that turns the dangling-line guard
  on for that token, and it cannot be declared anywhere else.
