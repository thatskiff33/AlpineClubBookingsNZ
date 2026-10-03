## What happens today

A school can accept a differently priced second quote option, or a revised quote that reuses its held beds. Naming pending adults then returns 409 because the held booking still carries earlier provisional prices. The accepted booking cannot reach officer approval.

## Who it affects

School organisers and booking officers completing the unnamed-adult workflow in #3413 and epic #3678.

## Proposed repair and approved decision

Reconcile provisional held guest, guest-night and booking cents to immutable accepted terms inside the existing accepted-name-resolution transaction, then replace pending capacity with real named adults atomically. Preserve accepted quote/option/price/snapshot, guest identities and consent, held capacity, and global-to-lodge lock order. Refuse ambiguous original-to-current party mappings. Use canonical seasonal membership policies to refuse genuine member identities even with login disabled.

Owner approved this concrete plan: http[historical local path omitted]
Approved blueprint: http[historical local path omitted]

Repricing at acceptance was considered; the existing naming transaction already holds both necessary lock tiers and is the approved repair location.

## Execution contract

High-risk residual of #3413, whose PR #3719 is already merged into epic/3678-officer-quote-school-wave. Dedicated follow-up branch and PR target that epic, preserving its single final merge to main. No production operations, new migrations, new payment/invoice/provider operations, accepted-terms rewrite or new advisory key. Existing officer approval must retain the proven accepted per-person prices and map held guest rewrites by identity after partial naming; this is required for the naming-through-approval acceptance criteria. Existing maintenance-window cutover and zero-pending rollback requirements remain binding. Existing local test-only and member-identity commits are recovered work for this issue.

Affected invariants: INV-MONEY, INV-CAP, INV-REQ, INV-LIFE, INV-LOCK, INV-OPS, INV-SSOT. Read AGENTS.md, invariant index and routed domain documents, concurrency guide, state machines, testing and guest-night price contracts.

## Acceptance and validation

- Production send/accept nonfirst option and revised quote with reused hold proceed through partial/full naming and approval on disposable PostgreSQL.
- Unequal per-person cents and partial naming index shifts reconcile exactly to immutable accepted terms; capacity and identity remain unchanged.
- Missing/ambiguous/malformed mappings are refused; lost claims and injected transaction failures persist no mutation.
- Login-disabled MEMBER_RATE identities are refused; legitimate nonlogin NON_MEMBER/SCHOOL contacts resolve.
- Update existing naming-writer inventory and relevant documentation. Run generated-client, targeted/related tests, money/guest-night/lock/occupancy guards, lint/typecheck, docs and budget gates, independent review and exact-head PR CI.
- Stop for owner review if accepted terms/consent, settlement, lock topology or guessed mappings would change. Final main integration remains owner-gated.
