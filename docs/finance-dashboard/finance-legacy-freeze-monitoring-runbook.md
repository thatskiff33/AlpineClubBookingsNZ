# Finance Legacy Freeze and Post-Cutover Monitoring Runbook

Use this runbook after the pre-cutover items in [finance-rollout-cutover-checklist.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-rollout-cutover-checklist.md) are complete and named-user rollout begins.

It defines the minimum monitoring windows, evidence expectations, decision points, fallback rules, and sign-off checkpoints required before the legacy dashboard can move from rollback fallback to freeze-ready status.

Capture the operating record in [finance-post-cutover-evidence-template.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-post-cutover-evidence-template.md) and attach it to the linked GitHub issue or PR.

This runbook does not grant production access, execute rollout steps, or retire the legacy dashboard in code.

## Scope Boundary

- Covers only the post-cutover period for the finance routes and sync surfaces already landed on `main`
- Starts once named-user rollout begins and ends when the legacy dashboard is either freeze-eligible or the rollout falls back
- Keeps operational Xero out of scope unless current implementation evidence proves the finance issue crosses that boundary

## Required Owners

| Responsibility | Required owner | Minimum responsibility before freeze |
| --- | --- | --- |
| Rollout owner | Product or ops lead for the named-user rollout window | Confirms who is being rolled out, when the rollout starts, and how affected users receive updates |
| Monitoring owner | Engineer or operator watching the native finance surface | Records route checks, sync-health evidence, and follow-up actions in the evidence log |
| Finance approver | Finance stakeholder validating the output | Confirms the representative comparison periods and signs off that normal finance reporting can move to TACBookings |
| Rollback owner | Operator authorized to pause or reverse the rollout | Confirms fallback instructions stay active until freeze criteria pass and calls rollback if blocker triggers fire |

Do not start the monitoring run without all four ownership roles identified in the evidence log.

## Monitoring Windows

### 1. Rollout Start Record

Record these items before or at the start of the named-user rollout window:

- rollout date and time window
- approved named users and finance access levels
- monitoring owner, finance approver, and rollback owner
- representative comparison periods carried forward from UAT
- confirmation that the legacy dashboard is still available as fallback coverage

Decision point:

- If the rollout record is incomplete, do not treat the rollout as started for freeze-readiness purposes.

### 2. First-Use Monitoring

During the rollout window, capture timestamped pass or fail evidence for each of these checks:

| Check | Minimum pass condition | Evidence to capture |
| --- | --- | --- |
| Finance viewer sign-in | Approved finance viewer can authenticate and reach `/finance` | Timestamp, user role, and pass or fail note |
| Finance route sweep | Named-user cohort can open `/finance`, `/finance/bookings`, `/finance/revenue`, `/finance/costs`, `/finance/pricing-sensitivity`, `/finance/cash`, `/finance/balance-sheet`, and `/finance/working-capital` | Checked routes, comparison period used, and any mismatch note |
| Access boundary regression | Ordinary member stays blocked from `/finance`; finance viewer stays blocked from manager-only actions; admin without finance access does not inherit finance access | Role tested, expected result, actual result |
| Diagnostics visibility | Monitoring owner can confirm the finance-manager sync status surface still exposes recent sync health and failure context | Timestamp of latest sync, any missing diagnostics fields, pass or fail |
| User issue intake | All named-user mismatches, blockers, and workarounds are logged | Issue summary, severity, owner, and whether fallback was needed |

Decision point:

- If access is broken, a finance viewer can reach manager-only actions, or a blocker-level report mismatch is found, move immediately to the rollback path in the cutover checklist and keep the legacy dashboard as the operational path.

### 3. Post-Rollout Scheduled Sync Review

Keep the legacy dashboard as the fallback path until at least the next scheduled finance sync after named-user rollout finishes.

After that sync completes, capture:

- sync completion timestamp and whether it is recent enough to support normal reporting
- dataset coverage or failure summary from the finance diagnostics surface
- confirmation that repeated sync protection still behaved correctly
- a second route sweep for the landed finance pages using the same representative comparison periods from UAT where practical
- any new user-reported mismatches that appeared only after the scheduled refresh

Decision point:

- If the scheduled sync is stale, failed, missing critical datasets, or introduces a blocker-level mismatch on the native finance routes, freeze is not allowed and rollback expectations remain active.

### 4. Freeze Readiness Review

Run a freeze-readiness review only after the first-use and scheduled-sync windows are both complete.

All of these gates must pass:

- no blocker access, auth, or manager-boundary regressions remain open
- at least one scheduled finance sync succeeded after named-user rollout
- the representative report checks completed without any blocker-level mismatch still requiring the legacy dashboard for normal finance work
- named users can complete normal reporting from TACBookings finance routes
- fallback instructions and rollback ownership remain clear until sign-off is recorded
- the finance approver, monitoring owner, and rollback owner all sign off in the evidence log

Decision outcomes:

| Outcome | When to use it | Required action |
| --- | --- | --- |
| Continue monitoring | Minor or non-blocker gaps remain but normal finance reporting does not depend on the legacy dashboard | Keep TACBookings as primary for named users, keep legacy fallback available, and track the gap to closure |
| Freeze eligible | Every gate above passed and sign-off is recorded | Mark the legacy dashboard as freeze-ready in docs or issue notes, then continue with [finance-legacy-retirement-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-retirement-runbook.md) for the final phase `#100` retirement step |
| Roll back | Any blocker-level access, sync, or report failure appears | Pause the rollout, direct users back to the legacy dashboard, preserve evidence, and reopen targeted follow-up work before retrying |

## Required Evidence

The evidence log should be detailed enough that another operator can reconstruct why the legacy dashboard was or was not frozen.

At minimum, capture:

- rollout window, owners, and named-user cohort
- representative comparison periods and report routes checked
- first-use monitoring results with timestamps
- post-rollout scheduled sync results with timestamps
- every mismatch or blocker, including whether fallback was required
- final decision status: continue monitoring, freeze eligible, or rollback
- sign-off names or role titles plus timestamps

Use [finance-post-cutover-evidence-template.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-post-cutover-evidence-template.md) as the default structure.

## Fallback Expectations Until Freeze

- Keep the legacy dashboard available for normal finance operations until the freeze-readiness review passes.
- Do not remove or disable the fallback path just because named-user rollout has started.
- If a blocker appears, tell affected users to resume the legacy dashboard immediately while the fix is investigated.
- Remove or narrow TACBookings finance access only if that is the fastest safe containment path.
- Preserve finance snapshots, diagnostics output, issue notes, and comparison evidence during any rollback or containment step.
- Do not reopen operational Xero scope unless current evidence proves the failure crosses that boundary.

## Sign-Off Checkpoints

Record sign-off only after the supporting evidence exists.

| Checkpoint | Required approver | What they are confirming |
| --- | --- | --- |
| Access and route readiness | Monitoring owner | Named users can use the intended finance routes and auth boundaries still hold |
| Report confidence | Finance approver | The representative comparison periods are good enough for normal finance reporting in TACBookings |
| Fallback posture | Rollback owner | The legacy dashboard remains available and rollback instructions are still understood until freeze is approved |
| Freeze recommendation | Rollout owner plus finance approver | The rollout can move from fallback-backed monitoring to freeze-ready status without blocker gaps |

## Exit Boundary

- If the runbook ends in `freeze eligible`, continue with [finance-legacy-retirement-runbook.md](/home/ubuntu/TACBookings/docs/finance-dashboard/finance-legacy-retirement-runbook.md) for the actual legacy-dashboard shutdown or retirement decision path.
- If the runbook ends in `continue monitoring`, keep the evidence log open and do not describe the legacy dashboard as frozen.
- If the runbook ends in `roll back`, follow the rollback notes from the cutover checklist and reopen only the narrow follow-up work needed to correct the blocker.
