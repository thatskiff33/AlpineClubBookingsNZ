# Issue #817: Membership, Family, Dependent, Cancellation, Archive/Delete Lifecycle Review

## Issue

Review membership ownership, family/dependent lifecycle, orphaned records, PII, audit/history preservation, cancellation, archive/delete blockers, nomination/application stuck states, and privacy consequences.

## Scope reviewed

- Static review of membership lifecycle, cancellation, family requests, nomination/application, and archive/delete paths.
- No production data, app-code edits, live provider calls, or destructive actions were used.

## Files/directories inspected

- `src/lib/nomination.ts`
- `src/lib/membership-cancellation-requests.ts`
- `src/lib/membership-cancellation-admin.ts`
- `src/lib/member-lifecycle-actions.ts`
- `src/lib/admin-family-group-requests-service.ts`
- `src/app/api/admin/members/[id]/route.ts`
- `src/app/(admin)/admin/members/**`
- `prisma/schema.prisma`
- `docs/DOMAIN_INVARIANTS.md`
- `docs/STATE_MACHINES.md`
- Prior report: `issue-813-lifecycle-state-machine-review.md`

## Main observations

- Direct admin member deletion is disabled. Deletion goes through lifecycle action requests, blocker checks, snapshots, advisory locks, and a different approving admin.
- Archive approval is limited to cancelled members and clears/deactivates Xero links as part of the lifecycle path.
- Cancellation approval deactivates login, sets cancellation metadata, and clears family/dependent/email inheritance relationships.
- Cancellation participant confirmation has token reissue support.
- Member hard-delete requests preserve a snapshot before deletion. The schema intentionally avoids a direct member foreign key on lifecycle action requests.
- Family group request approval/rejection updates requested relationships and emits audit/email side effects.

## Top risks to verify

- Nomination tokens can expire while an application remains `PENDING_NOMINATORS`; no reissue or expiry sweep was found in static review, and the pending application can block a fresh application for the same email.
- Membership approval creates member records before setup/approval/induction email and Xero side effects complete. Verify admin recovery when these best-effort steps fail.
- Cancellation queues Xero follow-up work after local cancellation. Verify local cancellation cannot silently diverge from operational Xero state.
- Hard-delete blocker coverage is broad, but needs regression tests proving no durable PII, finance, booking, family, audit, or provider references are orphaned.
- Dependent/family edge cases need explicit tests for cancellation, archive, and delete ordering across parent/child/inheritance relationships.

## Likely follow-up issues

- Add nomination expiry recovery: reissue, expire, or unlock stuck `PENDING_NOMINATORS` applications.
- Add tests for cancellation/archive/delete blocker matrices across bookings, payments, credits, refunds, family links, nominations, and Xero links.
- Add admin recovery visibility for failed post-approval membership emails and Xero contact/invoice work.
- Add dependent/family lifecycle tests for cancelling a parent, cancelling a dependent, and clearing email inheritance.
- Add privacy-focused tests that hard-delete snapshots preserve audit needs without retaining avoidable live PII links.

## Recommended tests/static checks

- Unit tests for nomination token expiry and duplicate email/application handling.
- Integration tests for archive/delete lifecycle requests with conflicting blockers.
- Unit tests for family relationship cleanup on cancellation.
- Tests asserting lifecycle actions preserve audit snapshots while clearing active links.
- Static checks around new member references requiring blocker coverage in lifecycle deletion.

## Sensitive findings requiring private handling, if any

- If orphaned PII or hard-delete bypasses are confirmed, keep exact object graph details and member-identifying examples out of public issue bodies.

## Uncertainty/to-verify list

- To verify: whether a separate cron or admin flow expires/reissues old nomination applications.
- To verify: whether all lifecycle failure alerts are monitored and actionable.
- To verify: whether archived members remain excluded from all member-facing and finance-facing active lists.
- To verify: whether cancellation outcome emails are enough for users when Xero/email follow-up fails.

## Validation notes

- Static review only.
- No code changes or data mutation were performed.
