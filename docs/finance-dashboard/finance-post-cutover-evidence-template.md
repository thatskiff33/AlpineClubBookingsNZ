# Finance Post-Cutover Evidence Template

Copy this template into the linked GitHub issue or PR when named-user rollout begins.

## Rollout Record

- Rollout window:
- Rollout owner:
- Monitoring owner:
- Finance approver:
- Rollback owner:
- Named users and finance access levels:
- Representative comparison periods:
- Legacy dashboard fallback confirmed:

## First-Use Monitoring Log

| Time | Check | User or role | Result | Evidence or mismatch note | Owner |
| --- | --- | --- | --- | --- | --- |
|  | Viewer sign-in to `/finance` |  |  |  |  |
|  | Finance route sweep |  |  |  |  |
|  | Access boundary regression check |  |  |  |  |
|  | Diagnostics visibility check |  |  |  |  |

## Post-Rollout Scheduled Sync Review

| Check | Expected result | Actual result | Pass or fail | Follow-up |
| --- | --- | --- | --- | --- |
| Latest scheduled sync completion | Recent successful run |  |  |  |
| Dataset coverage or failure context | No blocker gaps |  |  |  |
| Overlap-safe behavior | No overlapping run regression |  |  |  |
| Second route sweep | Representative routes still match expectations |  |  |  |

## Mismatch and Incident Log

| Severity | Route or surface | Summary | Fallback required | Owner | Linked issue |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Freeze Readiness Review

| Gate | Status | Evidence reference | Approver |
| --- | --- | --- | --- |
| No blocker auth or access regressions remain open |  |  |  |
| One scheduled post-rollout finance sync succeeded |  |  |  |
| Representative report checks no longer require the legacy dashboard |  |  |  |
| Named users can complete normal finance reporting in TACBookings |  |  |  |
| Fallback instructions remained active until sign-off |  |  |  |

## Final Decision

- Outcome: continue monitoring / freeze eligible / roll back
- Decision timestamp:
- Decision summary:
- Required follow-up:

## Retirement Follow-Up

| Check | Status | Evidence reference | Owner |
| --- | --- | --- | --- |
| Freeze-eligible decision recorded |  |  |  |
| Legacy retirement scope documented |  |  |  |
| Named-user and support communications sent |  |  |  |
| Retirement window executed or deferred |  |  |  |
| Fallback or reopen path remained available until final sign-off |  |  |  |

## Retirement Outcome

- Outcome: retired / pause at freeze-ready / reopen fallback
- Decision timestamp:
- Decision summary:
- Follow-up issue or PR:
