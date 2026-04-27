# Phase 6: Go-Live And Deploy

## Goal

Ship the audited release safely and prove the live deployment is healthy.

## Ownership

Use a single release lead for this phase. Other agents may assist with read-only verification, but merge and deploy control should stay with one owner.

## Steps

1. Confirm release readiness.
   - Review the Phase 5 validation log and deferred-items list.
   - Confirm the target commit is the intended release candidate.
2. Confirm publish strategy.
   - Follow the repo's established branch/PR workflow if one exists.
   - Ensure local and remote state are explicit before deploying.
3. Validate deployment prerequisites.
   - Re-check `.env` completeness and placeholder values.
   - Confirm Docker and host contracts are met.
4. Deploy using the repo-standard entrypoint.

```bash
cd ~/TACBookings
./scripts/run-production-blue-green-deploy.sh
```

5. Run post-deploy verification.
   - Health endpoint
   - Container/process status
   - App and proxy logs if anything looks wrong
   - Smoke tests for login, admin access, booking creation, and payment-critical paths where safe
6. Close the audit.
   - Record the deployed commit hash
   - Record deployment outcome
   - Record residual risks and post-launch follow-ups

## Required Outputs

- Exact deployed commit hash
- Deployment command result
- Post-deploy smoke-test evidence
- Final residual-risk list
- Clear go-live decision: `GO`, `GO WITH WAIVERS`, or `NO-GO`

## Exit Criteria

- Deployment completed without unresolved runtime failure
- Health and smoke checks match release expectations
- Local/remote git state is consistent with the deployed commit
- The final audit record is sufficient for later incident review or rollback
