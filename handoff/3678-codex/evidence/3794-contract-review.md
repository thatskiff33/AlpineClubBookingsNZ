# #3794 correctness and test-contract review

Reviewed exact head 571c2b05ceea820a63d10fc8fdf87baecb154c88 against
50e461ca2acb133dd97ff23fbadad2eb7f1c7bcd, worktree3413. Independent third
critical-area lens: integer cents, accepted snapshot mapping, night provenance,
real production lifecycle tests, writer inventories and operator contract.
No confirmed blocking or residual findings in this lens.

## Evidence inspected

Read full #3413 thread and #3794 thread at source, including renewed blueprint
5932888599 and owner-authored5939947674 approval. Read entire11-file diff,
planner/service, quote JSON schema, canonical approval-night builder, realDB
setup/CI wiring, affected source/adjustment/money censuses and docs updates.

- Planner checks original named-before-pending ordinals, teacher prefix,
  resolved adult count/current length, unique person keys, linked-member
  identity, exact original names/tiers, full date/night identity and per-person
  cents sum against accepted total. Previously resolved adults use the pending
  prefix; children use index minus resolvedCount, matching the service's insert
  before children and linked-index shift. Missing/ambiguous maps refuse.
- Existing and new guest nights derive from buildApprovalGuestNights. No
  per-night pricing-engine vector is invented: mechanical distribution records
  EVEN_SPLIT and conserves each accepted per-person total, including remainder
  cents. Service writes only the provisional guest/night price and source fields
  plus held booking totals; immutable accepted quote/option/price/snapshot is
  not in its request update payload. Discount/promo-adjusted holds refuse.
- Version claim precedes every new held-price write. Guest/night IDs are updated
  in place and never replaced during naming; rate type, consent, dietary and
  bed fields are not update targets. Subsequent guest-creation errors propagate
  out of the same transaction rather than being swallowed.
- Actual Prisma/SQL realDB tests call production create/send/respond/resolve/
  approve. Nonfirst option and re-quote preserve hold ID and reach CONFIRMED;
  unequal original/child/resolved amounts and existing night IDs are checked.
  Trigger-based lost claim and later guest INSERT failure assert no persisted
  partial claim/price/identity/reservation mutation. Snapshot corruptions cover
  identity, ordinal, sum, named/pending night count and partial count mismatch.
  Tests stub audit/email and dietary setting discovery, not price/planner or
  quote/accept/approval money writers; unit tests remain supplementary mocks.
- Existing required data-migration CI job invokes the realDB file, and its
  source-contract assertion checks that exact wiring. The suite applies the
  committed migration chain in its generated disposable scratch database.
  This review did not execute it or claim a fresh pass.
- All three writer censuses enumerate the new direct updates. Price-source
  census pins source stamping and direct count; money census includes booking,
  guest and night updates; adjustment census adds the reviewed nonpromo writer.
  Existing scan populations/paired promo-writer assertions were not removed or
  loosened. No adjustment rows, settled-payment row, provider call or ledger
  posting is added by this repair.
- State machine, concurrency writer notes and officer guide explain selected
  accepted-price alignment while preserving bed/accepted terms. No new rollout
  shortcut replaces the maintenance-window/zero-pending rollback contract.

## Limits

Source review only: no local tests, DB/container, dependencies, tracked edits,
GitHub, push or merge. Identity and concurrency reviewers own their distinct
lenses; standing SSOT review and final combined-main compose review remain
separate. This review approves only the stated commit, not any later edit or
main/child sync. Exact-head local evidence/required CI still belong to root.

