# Issue #821: Admin, Finance, and Lodge Recovery/Visibility Review

## Issue

Review operator visibility for stuck states, failed payments, failed refunds, failed Xero/email work, booking review, bed allocation repair, lodge/kiosk operations, finance reconciliation, and auditability.

## Scope reviewed

- Static review of admin dashboard, health, finance, Xero, payments, waitlist, bed allocation, lodge/kiosk, and recovery surfaces.
- No live admin session, browser automation, production data, app-code edits, or production-like scans were used.

## Files/directories inspected

- `src/app/(admin)/admin/dashboard/page.tsx`
- `src/app/(admin)/admin/health/page.tsx`
- `src/lib/health-check.ts`
- `src/lib/admin-cron-health.ts`
- `src/app/(admin)/admin/payments/page.tsx`
- `src/app/(admin)/admin/xero/**`
- `src/app/(admin)/admin/waitlist/page.tsx`
- `src/app/(admin)/admin/bed-allocation/page.tsx`
- `src/app/(finance)/finance/page.tsx`
- `src/lib/kiosk-access.ts`
- `src/lib/lodge-auth.ts`
- `src/app/(lodge)/lodge/page.tsx`
- `src/app/(lodge)/lodge/kiosk/page.tsx`
- `prisma/schema.prisma`

## Main observations

- Admin dashboard surfaces several work queues: refund appeals, credit approvals, membership cancellations, archive requests, booking reviews/change requests, hut leader issues, and lodge operations links.
- Health pages include database/config/provider/background-job style checks, webhook stats, email deliverability, and payment recovery checks.
- Admin payment pages expose source filters, settlement/Xero filters, Xero activity, and invoice repair actions.
- Xero admin pages expose operation and inbound-event visibility plus retry/requeue/replay actions.
- Waitlist and bed-allocation admin pages include operational repair surfaces.
- Finance pages are distinct from operational Xero pages and rely on synced reporting snapshots.

## Top risks to verify

- There is no single operator queue for all stuck lifecycle states across payment recovery, Xero outbox/inbound, email, waitlist, bed allocation, and lodge operations.
- Health payment recovery checks appear to count old `PENDING` work, but not necessarily `FAILED` or stale `PROCESSING` recovery operations.
- Admin dashboard top-level counts do not appear to include Xero outbox failures, email failures, or payment recovery failures.
- Xero health copy/count mismatches can make stale running work look healthier than it is.
- Lodge/kiosk recovery visibility was only lightly inspected; verify lodge operators can see and recover allocation, access, and stay-operation issues without admin-only knowledge.

## Likely follow-up issues

- Add a consolidated stuck-state operator dashboard or health queue with severity and owner.
- Expand payment recovery health to include `FAILED`, exhausted, and stale `PROCESSING` states.
- Add dashboard cards for Xero operation failures, email failures, and critical background-job failures.
- Add lodge/kiosk operational recovery tests and operator docs.
- Add audit-readability checks for force overbook, manual payment repair, Xero retry/requeue, email suppression clear, and lifecycle approvals.

## Recommended tests/static checks

- Static health snapshot tests for all stuck-state categories.
- Admin route tests for payment recovery, Xero retry/requeue, email review, waitlist force confirm, and bed repair permissions.
- Audit-log tests for high-risk operator repair actions.
- Finance stale-sync tests showing clear snapshot age and reconciliation status.
- Static check that new background queues add admin visibility and recovery ownership.

## Sensitive findings requiring private handling, if any

- Keep exact admin repair bypass paths and queue-stalling mechanics private if confirmed.
- Do not include production operator names, user data, payment IDs, or provider object IDs in public issue text.

## Uncertainty/to-verify list

- To verify: actual operator runbook usage for health and dashboard screens.
- To verify: whether lodge/kiosk users need recovery actions beyond read-only visibility.
- To verify: whether failed background work is monitored outside the app UI.
- To verify: whether finance reports clearly show stale sync age and failed operational Xero work.

## Validation notes

- Static review only.
- No live admin, lodge, kiosk, or finance session was used.
