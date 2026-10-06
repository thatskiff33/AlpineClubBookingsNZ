# File-size allowances for #49 - the Alpine Central Server version pause

Four already-over-budget files grow. The rule itself (parser, comparison,
status, the one pause sentence) and the check service are NEW modules well
inside their budgets - `servernz-api-version.ts`, `servernz-version-check.ts` -
so none of the four below gains the mechanism; each gains only the call site
that has to sit where the thing it governs sits.

file: src/app/(admin)/admin/lodges/_components/other-lodges-panel.tsx
lines: 803
reason: one state flag read off the list response and one paragraph, rendered
  above the two existing read-only notes it belongs beside, saying the list may
  be stale and linking to setup. The panel's size is the #52 edit popup, which
  this change does not touch; a note about THIS list, lifted into a component
  of its own, would be a component with one caller and no second reader.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 303
reason: the stored server version is forgotten at the same verify-reset site
  that forgets the #52 owned-lodge list, because both were the replaced key's
  answer - one awaited call to the combined forget writer and the sentence
  saying so. The reset belongs in `applyVerifyReset` with every other
  provider's, which is the file's shape.

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
lines: 2109
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
