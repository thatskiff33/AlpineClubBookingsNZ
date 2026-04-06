# Sentry Alerting Rules (OBS-11)

Configure these alert rules in the Sentry project dashboard after deploying with a valid `SENTRY_DSN`.

## Required Alert Rules

### 1. New Unhandled Exception (First Occurrence)
- **Trigger:** A new issue is created
- **Conditions:** Event occurs for the first time
- **Action:** Send email to admin
- **Triage:** Check the error message and stack trace. If it's a transient error (network timeout, DB connection reset), monitor for recurrence. If it's a code bug, fix and deploy.

### 2. Error Spike
- **Trigger:** Number of events in an issue > 10 in 5 minutes
- **Conditions:** Event frequency threshold exceeded
- **Action:** Send email to admin
- **Triage:** Check if a deployment just happened (rollback if needed). Check if an external service is down (Stripe, Xero, SMTP). Look for patterns in the affected routes.

### 3. Cron Monitor Missed or Failed
- **Trigger:** Cron monitor check-in missed or returned error status
- **Monitors:**
  - `confirm-pending-bookings` (every 3 hours)
  - `xero-membership-refresh` (daily at 2 AM NZST)
  - `database-backup` (daily at 3 AM NZST)
- **Action:** Send email to admin
- **Triage:** SSH into the server and check Docker container status (`docker compose ps`). Check container logs (`docker compose logs app --tail=100`). Verify cron jobs are registered in the server startup logs.

### 4. Webhook Failure Rate
- **Trigger:** Webhook failure rate > 20% over 15 minutes (custom metric)
- **Note:** This requires a custom Sentry metric or external monitoring since webhook stats are tracked in the `WebhookLog` database table. Consider using the admin health dashboard (OBS-07) for this.
- **Action:** Send email to admin
- **Triage:** Check Stripe webhook dashboard for delivery failures. Verify webhook secrets are still valid. Check for recent deployments that may have broken webhook handling.

## Configuration Steps

1. Go to Sentry project **Settings > Alerts**
2. Create each rule above with the specified conditions
3. Set the alert recipient to the admin email address
4. For cron monitors, alerts are auto-configured when the first check-in is received
5. Test by triggering a test error: visit `/api/health` and verify it appears in Sentry

## Alert Recipients

Configure in Sentry project settings:
- Primary: admin@tac.org.nz
- Optional: Add a Slack webhook integration for faster notification
