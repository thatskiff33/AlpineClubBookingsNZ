# Production Re-Review Risk Acceptance Draft

This is a draft companion to `07_RE_REVIEW_2026_04.md`. It records the acceptance model that would be required to complete P10 honestly, but it is **not yet approved** and does not replace remediation work.

## Current State

- Critical findings: 2 open; no acceptance allowed
- High findings: 17 open; merged remediation PRs `#266` and `#267` exist, but no approved acceptances are recorded yet
- Medium findings: 9 open; no linked follow-up task issues are recorded yet
- Low findings: none tracked

## Proposed Acceptance Rules

### Critical

- No acceptance.
- Must be fixed before re-review sign-off.

### High

- Allowed only with a named owner, a short remediation window, and a concrete trigger.
- Example trigger style: "revisit immediately if any guest-link token mutation remains public in the next deploy" or "revisit within 7 days if backup restore still fails on the next drill."

### Medium

- May be deferred only if paired with:
  - a linked execution issue
  - a target sprint/date
  - a concrete trigger to force re-review

## Proposed Medium-Finding Triggers

| Finding | Proposed trigger |
| --- | --- |
| [#247](https://github.com/thatskiff33/TACBookings/issues/247) | Revisit if booking/admin query latency rises or the affected relations exceed current row-count assumptions |
| [#248](https://github.com/thatskiff33/TACBookings/issues/248) | Revisit before any member/booking deletion tooling ships to production |
| [#250](https://github.com/thatskiff33/TACBookings/issues/250) | Revisit before any finance key rotation, tenant split, or finance disaster-recovery rehearsal |
| [#252](https://github.com/thatskiff33/TACBookings/issues/252) | Revisit immediately on first SES bounce/complaint support incident |
| [#256](https://github.com/thatskiff33/TACBookings/issues/256) | Revisit before widening query/search/filter surfaces or introducing raw-query paths |
| [#258](https://github.com/thatskiff33/TACBookings/issues/258) | Revisit before the next auth/email template rollout |
| [#259](https://github.com/thatskiff33/TACBookings/issues/259) | Revisit before the next formal accessibility gate or release sign-off |
| [#261](https://github.com/thatskiff33/TACBookings/issues/261) | Revisit before the next blue-green deploy cutover after any Caddy/deploy-script change |
| [#265](https://github.com/thatskiff33/TACBookings/issues/265) | Revisit before any finance booking-metrics export or reporting path is widened beyond bounded date-window aggregation |

## Proposed High-Finding Review Window

If a high finding is not fixed immediately, the maximum acceptable window should be one week, with explicit operator acknowledgement in the issue thread and a concrete rollback or compensating control recorded.
