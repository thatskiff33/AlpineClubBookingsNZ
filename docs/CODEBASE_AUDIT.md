# TACBookings Codebase Audit

**Last reviewed:** 2026-04-15

This file tracks only unresolved issues from the latest autonomous review of the current `main` branch.

## Remaining Issues

### 1. Deployment entrypoint is still external to the repo

- **Severity:** Medium
- **Status:** Open
- **Evidence:** The repo's go-live docs still point to `/home/ubuntu/clean-build-docker-tacbookings.sh`, but that script is not tracked by this repository.
- **Why it matters:** Deployment behavior can drift from `main`, and fixes already present on one host are not guaranteed to travel with the repo, pull requests, or fresh environments.
- **Recommended fix:** Move the deployment script into the repo as the canonical entrypoint, then keep any host-level wrapper as a thin delegator to the tracked copy.
