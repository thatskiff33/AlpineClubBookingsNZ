# Finance Legacy Dashboard Retirement Runbook

Use this runbook only after the freeze-eligibility outcome from [finance-legacy-freeze-monitoring-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-freeze-monitoring-runbook.md) is recorded and the linked evidence log shows that normal finance reporting no longer depends on the legacy dashboard.

It defines the minimum prerequisites, ownership, communication plan, evidence capture, decision path, and fallback expectations for moving the legacy dashboard from freeze-ready status to retired status.

This runbook does not execute the retirement in code, grant or revoke production finance access, or reopen operational Xero scope without new evidence.

## Scope Boundary

- Covers only the final phase `#100` step after the named-user rollout, post-cutover monitoring, and freeze-readiness review are complete
- Treats the legacy dashboard as freeze-ready but still recoverable until the retirement decision is fully signed off
- Keeps retirement planning documentation-first; any real shutdown or removal action must be logged against the linked issue or PR using this runbook

## Retirement Start Gate

Do not begin retirement planning until every prerequisite below is true:

- the cutover checklist in [finance-rollout-cutover-checklist.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-rollout-cutover-checklist.md) is complete
- the monitoring and freeze decision from [finance-legacy-freeze-monitoring-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-freeze-monitoring-runbook.md) ended in `freeze eligible`
- the post-cutover evidence log is attached to the linked GitHub issue or PR and includes the freeze-readiness sign-off
- no blocker-level auth, sync, report, or rollback gap remains open
- named finance users can complete normal finance reporting from TACBookings without needing the legacy dashboard for routine work
- a rollback owner is still identified in case retirement has to pause or reopen fallback coverage

Decision point:

- If any prerequisite above is missing, stop at freeze-ready status and do not describe the legacy dashboard as retired.

## Required Owners

| Responsibility | Required owner | Minimum responsibility before retirement |
| --- | --- | --- |
| Retirement owner | Engineering or operations lead coordinating the retirement window | Owns the retirement checklist, confirms exact scope, and records each retirement decision in the evidence log |
| Finance approver | Finance stakeholder who signed off the freeze-eligible outcome | Confirms TACBookings remains sufficient for normal finance reporting without the legacy dashboard |
| System owner | Operator or engineer with legacy-dashboard administration access | Identifies the exact legacy surfaces to freeze, archive, or disable and confirms whether any readonly fallback remains |
| Communications owner | Product or operations lead for finance-user messaging | Sends retirement timing, impact, and fallback communications to affected users before any shutdown action |
| Rollback owner | Operator authorized to restore or reopen fallback coverage | Keeps the restore path clear until final sign-off and calls a pause or reopen if blockers appear |

Do not start the retirement step unless all five ownership roles are named in the linked evidence log.

## Retirement Preparation Record

Before a retirement window is scheduled, capture:

- the linked freeze-eligible evidence reference
- the exact legacy dashboard surfaces in scope for retirement, including URLs, credentials, docs, automations, or support notes still in active use
- confirmation that no named user, finance approver, or support owner still depends on the legacy dashboard for normal reporting
- the planned retirement window, system owner, communications owner, and rollback owner
- the issue or PR where retirement evidence, follow-up work, and any reopen decision will be recorded

Decision point:

- If the scope of the legacy dashboard cannot be described precisely enough to tell operators what is being retired, keep the system freeze-ready and open a narrow follow-up before any shutdown step.

## Communication Plan

Retirement communications must be sent before any disablement or archive action begins.

| Audience | Minimum timing | Required content |
| --- | --- | --- |
| Named finance users | Before the retirement window starts | Retirement window, expected TACBookings path, support contact, and how fallback will be handled if a blocker appears |
| Finance approver and rollout owner | Before the retirement window starts | Retirement scope, evidence reference, open risks, and sign-off checkpoint timing |
| Support or operations contacts | Before the retirement window starts | Exact legacy surfaces changing, expected support posture, and who can reopen fallback coverage |

Decision point:

- If communications are not sent or cannot identify a support contact and reopen owner, delay retirement and keep the legacy dashboard at freeze-ready status.

## Retirement Decision Path

### 1. Pre-Retirement Confirmation

Immediately before the retirement window, reconfirm:

- TACBookings finance routes still load for named users
- the latest finance sync evidence is still recent enough for normal reporting
- no blocker incident or unresolved mismatch was opened after the freeze-eligible decision
- the rollback owner confirms that a reopen path still exists if retirement cannot complete cleanly

### 2. Retirement Window Log

During the retirement window, record:

- the timestamp and operator for each legacy-dashboard action
- whether the change is a freeze, archive, redirect, credential disablement, or full retirement step
- any unexpected dependency discovered during the change
- whether rollback or partial reopen was required

This runbook does not prescribe the runtime mutation itself. It requires that the exact action taken be logged clearly enough for another operator to reconstruct or reverse it.

### 3. Post-Retirement Verification

After the retirement action, confirm:

- named users still complete normal finance reporting in TACBookings
- the intended legacy dashboard surfaces no longer function as the normal finance path
- any remaining readonly archive path, if one exists, is documented explicitly and is not treated as the normal workflow
- support owners know whether the outcome is `retired`, `paused at freeze-ready`, or `reopened fallback`

Decision outcomes:

| Outcome | When to use it | Required action |
| --- | --- | --- |
| Retired | Retirement completed, verification passed, and fallback no longer needs to remain active for normal finance operations | Record final sign-off, update linked issue or PR evidence, and close the remaining phase `#100` work only when all rollout evidence is complete |
| Pause at freeze-ready | Minor gaps or open questions remain, but no active blocker requires full rollback | Keep the legacy dashboard frozen but not fully retired, record the missing step, and reopen only the narrow follow-up needed |
| Reopen fallback | A blocker or hidden dependency means the legacy dashboard is still needed | Restore or preserve fallback coverage immediately, record the incident, and reopen targeted follow-up work before retrying retirement |

## Required Evidence

The retirement record must be durable enough that another operator can explain why the legacy dashboard was retired, paused, or reopened.

At minimum, capture:

- the freeze-eligible evidence reference from the monitoring runbook
- all required owners and the planned retirement window
- the exact legacy surfaces in scope
- communication timestamps, audience, and sender
- each retirement action and its timestamp
- post-retirement verification results and any incident discovered
- final outcome: `retired`, `pause at freeze-ready`, or `reopen fallback`
- sign-off names or role titles plus timestamps

Use [finance-post-cutover-evidence-template.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-post-cutover-evidence-template.md) as the base record and extend it with the retirement-specific section below.

## Sign-Off Checkpoints

| Checkpoint | Required approver | What they are confirming |
| --- | --- | --- |
| Retirement start approval | Retirement owner plus finance approver | The freeze-eligible prerequisites still hold and the retirement window can begin |
| Legacy scope confirmation | System owner | The exact legacy surfaces affected by the retirement are documented accurately |
| Communications complete | Communications owner | Affected users and support contacts received the retirement notice and reopen path |
| Final retirement decision | Finance approver plus rollback owner | The outcome is safe to treat as retired, paused at freeze-ready, or reopened fallback |

## Fallback and Reopen Expectations

- Keep the rollback owner active until the final retirement decision is signed off.
- If a blocker appears during or after the retirement window, reopen fallback coverage immediately or keep the legacy dashboard frozen instead of fully retired.
- Preserve the evidence log, support notes, and timestamps for every reopen decision.
- Do not treat a paused retirement as phase completion.
- Do not reopen operational Xero scope unless current evidence proves the retirement blocker crosses that boundary.

## Exit Boundary

- If the outcome is `retired`, update the linked task or PR evidence and close phase `#100` only when the wider rollout evidence is also complete.
- If the outcome is `pause at freeze-ready`, keep the legacy dashboard out of normal use but leave the retirement step incomplete until the narrow missing action lands.
- If the outcome is `reopen fallback`, direct users back to the legacy dashboard as needed and reopen only the smallest follow-up work required to retry retirement safely.
