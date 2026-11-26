/**
 * The Support area's system screens: health, the running process, Stuck
 * States, the setup checklist and provider tests, backups, the modules, the
 * club's currency and locale, the sign-in rules, the access roles and privacy
 * retention; and Admin Overview's work-queue counts. Part of the Support &
 * System officer actions (ALP-724): spread into `MCP_ACTIONS`.
 *
 * Kinds. The checklist ticks, the provider checks and starting a backup are
 * `write`: each changes only the club's own housekeeping, notifies no one and
 * overwrites no one's record, and a tick can be undone. The monitoring test
 * event can alert whoever watches monitoring; resetting the whole checklist
 * cannot be undone from the app; and the retention save decides when members'
 * data is deleted; so all three are `destructive` (owner decisions, #5305
 * comments 7092977781 and 7093303964). Switching modules, changing the
 * sign-in rules and the access roles, and the Full Admin settings (currency,
 * time zone, environment safety) are website-only (`exclusions.ts`); this
 * file only reads them.
 */
import {
  PRIVACY_RETENTION_PREVIEW_PAGE_SIZE,
  privacyRetentionPreviewQuerySchema,
  providerCheckSchema,
  setupStepProgressSchema,
} from "@/lib/admin-support-api/system";
import {
  ACCESS_ROLE_LIST_CONNECTION_SHAPE,
  ADMIN_HEALTH_CONNECTION_SHAPE,
  ADMIN_PENDING_COUNTS_CONNECTION_SHAPE,
  BACKUP_STARTED_CONNECTION_SHAPE,
  BACKUP_STATUS_CONNECTION_SHAPE,
  CLUB_FORMAT_CONNECTION_SHAPE,
  CLUB_MODULES_CONNECTION_SHAPE,
  OFFICER_TWO_FACTOR_POLICY_CONNECTION_SHAPE,
  PASSWORD_POLICY_CONNECTION_SHAPE,
  PRIVACY_RETENTION_CONNECTION_SHAPE,
  PRIVACY_RETENTION_SAVED_CONNECTION_SHAPE,
  PROVIDER_TEST_CONNECTION_SHAPE,
  RUNTIME_STATUS_CONNECTION_SHAPE,
  SETUP_PROGRESS_CONNECTION_SHAPE,
  SETUP_READINESS_CONNECTION_SHAPE,
  STUCK_STATES_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-system";
import { privacyRetentionSettingsSchema } from "@/lib/privacy-retention-shared";

import type { McpAction } from "../catalogue";

export const SUPPORT_SYSTEM_MCP_ACTIONS: readonly McpAction[] = [
  // --- Health and attention -------------------------------------------------
  {
    id: "get_system_health",
    title: "Read the system health report",
    summary:
      "Officer: the site's health: database, configuration, Stripe, Xero, email and payment recovery checks; each scheduled job's state and last run; webhooks received in 24 hours by source; stopped email addresses (counts); emails that ran out of send attempts (`emailFailures`, whose `id` and `recovery` the retry and dismiss actions take); officer alerts that reached no one; and the version running.",
    method: "GET",
    path: "/api/admin/health",
    kind: "read",
    returns: ADMIN_HEALTH_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_runtime_status",
    title: "Read the running process's status",
    summary:
      "Officer: whether scheduled jobs run in the process that answered, its role (such as `web-blue` or `cron`), the time zone its jobs were registered in, and whether the installation is declared production.",
    method: "GET",
    path: "/api/admin/runtime-status",
    kind: "read",
    returns: RUNTIME_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_stuck_states",
    title: "Read Stuck States",
    summary:
      "Officer: work that has stopped moving (payments, bookings, Xero, email, waitlist, bed allocation, lodge), by domain and severity, each with a count and what it means. Named rows under a card come only with Membership view (and Finance view for payments).",
    method: "GET",
    path: "/api/admin/stuck-states",
    kind: "read",
    returns: STUCK_STATES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_officer_work_queue_counts",
    title: "Count what is waiting for officers",
    summary:
      "Officer: how many items wait in each officer work queue (booking reviews and requests, applications, family requests, refunds, credit approvals, unpaid stays, cancellations, deletion requests, issue reports, nights without a hut leader, Stuck States and more). `unavailable` names any count that could not be read. Counts only.",
    method: "GET",
    path: "/api/admin/pending-counts",
    kind: "read",
    returns: ADMIN_PENDING_COUNTS_CONNECTION_SHAPE,
    core: true,
  },

  // --- The setup checklist and provider tests ------------------------------
  {
    id: "get_setup_readiness",
    title: "Read the setup checklist",
    summary:
      "Officer: the first-install checklist by category: each check's `id`, status (`complete`, `warning`, `blocked`, `not_started`), message and details, whether it is required, which provider test it offers, and whether the club ticked or skipped it.",
    method: "GET",
    path: "/api/admin/setup",
    kind: "read",
    returns: SETUP_READINESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_setup_step",
    title: "Tick, skip or reopen a setup step",
    summary:
      "Officer: marks one setup check (`stepId` from `get_setup_readiness`) `complete` or `skip`, or `reopen`s it. Any change clears the checklist's finished mark. Answers the progress.",
    method: "PATCH",
    path: "/api/admin/setup/progress",
    body: setupStepProgressSchema,
    kind: "write",
    returns: SETUP_PROGRESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "finish_setup",
    title: "Mark the setup checklist finished",
    summary: "Officer: records the setup checklist as finished. Answers the progress.",
    method: "PATCH",
    path: "/api/admin/setup/progress",
    fixedBody: { action: "finish" },
    kind: "write",
    returns: SETUP_PROGRESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reset_setup_progress",
    title: "Start the setup checklist again",
    summary:
      "Officer: clears every tick and skip on the setup checklist and its finished mark. The ticks cannot be restored. Answers the progress.",
    method: "PATCH",
    path: "/api/admin/setup/progress",
    fixedBody: { action: "reset" },
    kind: "destructive",
    returns: SETUP_PROGRESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "test_provider_connection",
    title: "Test a provider connection",
    summary:
      "Officer: checks one outside service the site relies on (`stripe`, `smtp` email or `xero`) with the stored settings, and answers `ok` and what it found. Nothing is sent to anyone; a failure message stays generic so no key detail is shown. Testing monitoring is `send_monitoring_test_event`.",
    method: "POST",
    path: "/api/admin/setup/provider-test",
    body: providerCheckSchema,
    kind: "write",
    returns: PROVIDER_TEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "send_monitoring_test_event",
    title: "Send a test event to monitoring",
    summary:
      "Officer: sends one diagnostic event to the club's error monitoring (Sentry) and answers `ok` once it is accepted. Whoever watches monitoring may be alerted by it. A failure message stays generic so no key detail is shown.",
    method: "POST",
    path: "/api/admin/setup/provider-test",
    fixedBody: { provider: "sentry" },
    kind: "destructive",
    returns: PROVIDER_TEST_CONNECTION_SHAPE,
    core: false,
  },

  // --- Backups ----------------------------------------------------------------
  {
    id: "get_backup_status",
    title: "Read the database backup status",
    summary:
      "Officer: whether database backups are on and safe off the server (`durable`), whether stored credentials need re-entering, the retention, the backup disk's free space, whether one is running, the last ten runs with their errors, and the schedule. Never a credential.",
    method: "GET",
    path: "/api/admin/backups/status",
    kind: "read",
    returns: BACKUP_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "run_backup_now",
    title: "Start a database backup now",
    summary:
      "Officer: starts a database backup in the background and answers at once (`started`). Refused if one is already running, backups are off, or the stored credentials need re-entering. Follow it with `get_backup_status`.",
    method: "POST",
    path: "/api/admin/backups/run",
    kind: "write",
    returns: BACKUP_STARTED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Modules, format, sign-in rules, access roles ---------------------------
  {
    id: "list_modules",
    title: "List the club's modules",
    summary:
      "Officer: each optional module (such as bed allocation, food orders or AI app connections): whether the club switched it on, whether it is in effect, and if not ready, why and what it depends on. Switching a module is website-only.",
    method: "GET",
    path: "/api/admin/modules",
    kind: "read",
    returns: CLUB_MODULES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_club_format",
    title: "Read the club's currency and locale",
    summary:
      "Officer: the currency the club charges in and the locale amounts and dates are written in, where each comes from, and when it was last changed. Only a Full Admin can change them, on the website.",
    method: "GET",
    path: "/api/admin/club-format",
    kind: "read",
    returns: CLUB_FORMAT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_password_policy",
    title: "Read the sign-in rules",
    summary:
      "Officer: the password rules (length, character kinds, the breached-password check), how long a sign-in link lasts, and how long a session lasts. Changing them asks for fresh proof, on the website.",
    method: "GET",
    path: "/api/admin/security/password-policy",
    kind: "read",
    returns: PASSWORD_POLICY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_officer_two_factor_policy",
    title: "Read the officer two-step sign-in rule",
    summary:
      "Officer: whether officers must use two-step sign-in and how many days of grace a new officer gets. Answers 404 where the rule is not in force. Changing it asks for fresh proof, on the website.",
    method: "GET",
    path: "/api/admin/security/officer-two-factor",
    kind: "read",
    returns: OFFICER_TWO_FACTOR_POLICY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_access_roles",
    title: "List the access roles",
    summary:
      "Officer: each access role: its label and description, what it allows in each admin area (`permissions`: none, view or edit), whether it needs two-step sign-in, and how many people hold it. Changing roles asks for fresh proof, on the website.",
    method: "GET",
    path: "/api/admin/access-roles",
    kind: "read",
    returns: ACCESS_ROLE_LIST_CONNECTION_SHAPE,
    core: false,
  },

  // --- Privacy retention -----------------------------------------------------
  {
    id: "get_privacy_retention",
    title: "Read the privacy retention settings",
    summary:
      `Officer: how long email logs, rejected applications and former members are kept, how long a stay's dietary needs are kept, which removal jobs are switched on, and a preview of what they would remove now (record ids and dates, ${PRIVACY_RETENTION_PREVIEW_PAGE_SIZE} to a page). The application and member lists come only with Membership view.`,
    method: "GET",
    path: "/api/admin/privacy-retention",
    query: privacyRetentionPreviewQuerySchema,
    kind: "read",
    returns: PRIVACY_RETENTION_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_privacy_retention",
    title: "Change the privacy retention settings",
    summary:
      "Officer: saves every retention setting at once (read them first with `get_privacy_retention`): years to keep email logs, rejected applications and former members, days to keep a stay's dietary needs, and which removal jobs run. Member and application settings need Membership edit, dietary ones Bookings edit. Switched-on jobs delete data for good. Answers the saved settings.",
    method: "PUT",
    path: "/api/admin/privacy-retention",
    body: privacyRetentionSettingsSchema,
    kind: "destructive",
    returns: PRIVACY_RETENTION_SAVED_CONNECTION_SHAPE,
    core: false,
  },
];
