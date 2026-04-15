# TACBookings Codebase Audit

**Last reviewed:** 2026-04-15

This file now tracks only unresolved issues from the latest autonomous repo review. Resolved items and background inventory were removed to keep this document focused on what still needs attention.

## Remaining Issues

### 1. Deployment script reports false failure when optional Xero daily refresh is disabled

- **Severity:** Medium
- **Status:** Open
- **Evidence:** `/home/ubuntu/clean-build-docker-tacbookings.sh` requires the startup log line `Scheduled Xero membership refresh`, but the app correctly logs `Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH` when that feature flag is off.
- **Why it matters:** Healthy deployments can be marked failed even when containers, health endpoints, and HTTPS checks are all green. That makes release automation noisy and undermines operational confidence.
- **Recommended fix:** Update the deployment script to treat either log line as valid, or branch the check based on the `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH` setting before asserting startup success.
