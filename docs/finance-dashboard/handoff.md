# Finance Dashboard Handoff

Last updated: 2026-04-16

## Current State

- Planning scaffold created
- ADR baseline created
- Phase plan documented
- GitHub issue and PR templates added
- GitHub milestone created: `Finance Dashboard Integration`
- Epic created: `#92`
- Phase issues created: `#93` through `#100`
- First execution task created: `#101`

## Decisions Already Locked

- Native TACBookings implementation, not embedded Streamlit
- Separate finance Xero OAuth boundary
- Dedicated finance access model instead of broadening `ADMIN`
- Postgres-backed finance snapshots instead of CSV files

## Immediate Next Step

Finish and merge `#101`, which implements the Phase 1 guard boundary:

- `Member.financeAccessLevel` is the dedicated finance gate, separate from `role`
- `/finance` lives in its own top-level route group, outside `(admin)`
- finance access is enforced server-side from the live `Member` row, not the JWT alone
- unauthenticated users go to `/login` with a `/finance` callback
- users without finance access are redirected back to `/dashboard`

## Open Questions

- exact member/admin list for initial finance viewer rollout
- exact member/admin list for initial finance manager rollout
- whether finance reporting needs a new explicit booking type model
- whether any legacy dashboard outputs should remain exportable during transition

## Session Start Checklist

1. Read `README.md`, `phases.md`, and this file.
2. Read the linked GitHub issue and current PR, if any.
3. Confirm the issue acceptance criteria before editing code.
4. Update this file before ending the session if state changed.
