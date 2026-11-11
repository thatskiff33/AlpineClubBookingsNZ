/**
 * Help for the "Monitoring & Support" admin section: issue reports, stuck
 * states, system health, deliverability, background jobs, the audit log and
 * deletion requests.
 *
 * Section per the sidebar's `buildAdminNavSections`.
 *
 * The Help & system pages live under `/admin/system` (C7 #4804), and their keys
 * are their registry old paths: see the note on `admin/finance.ts`.
 */
import { entry, help, type HelpEntry } from "../types";
import { getAdminPage } from "@/lib/admin-hubs";

export const adminMonitoringAndSupportHelpEntries: HelpEntry[] = [
  entry(
    getAdminPage("issue-reports").oldPath,
    help(
      "Issue Reports",
      "Issue reports collect screenshots and operator/member notes about problems seen in the app.",
      [
        "Filter by open or resolved status, inspect the report context, and follow the linked page if needed.",
        "Use status changes and notes to track whether the issue has been triaged, resolved, or closed as not reproducible.",
        "Escalate reproducible product bugs into a GitHub issue when code work is needed.",
      ],
      [
        {
          name: "Page URL",
          description:
            "The route where the reporter saw the problem, useful for reproducing the issue.",
        },
        {
          name: "Screenshot",
          description:
            "A captured visual context if the reporter included one.",
        },
        {
          name: "Status",
          description:
            "Tracks whether the issue report is open, in progress, resolved, or closed.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("stuck-states").oldPath,
    help(
      "Stuck States",
      "Stuck States aggregates workflows that appear stale, inconsistent, or blocked across bookings, payments, Xero, email, waitlist, and lodge tasks.",
      [
        "Review the highest-severity rows first.",
        "Open the linked record and resolve the underlying cause rather than hiding the symptom.",
        "Use retry/recovery controls where available and record manual follow-up when needed.",
      ],
      [
        {
          name: "Severity",
          description:
            "How urgently the stuck state should be investigated.",
        },
        {
          name: "Owner",
          description:
            "The operational area expected to act, such as Admin, Finance, Lodge, or System.",
        },
        {
          name: "Target",
          description:
            "The booking, payment, member, job, or provider record to inspect.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("health").oldPath,
    help(
      "System Health",
      "System Health shows runtime, database, provider, and readiness indicators for operators. Its Integration readiness section links the provider-backed setup pages for accounting, email and modules.",
      [
        "Check readiness and dependency status before investigating user reports.",
        "Use timestamps and provider health messages to distinguish stale data from current outages.",
        "Escalate recurring failures to deployment or provider support workflows.",
        "Under Integration readiness, open Xero Setup before connecting or changing accounting sync, and review Modules before enabling provider-backed workflows.",
      ],
      [
        {
          name: "Readiness",
          description:
            "Whether the app and required dependencies are healthy enough to serve traffic.",
        },
        {
          name: "Provider status",
          description:
            "Health or connectivity information for external services.",
        },
        {
          name: "Integration readiness",
          description:
            "Links to Xero Setup, Xero Sync, Modules and Email Deliverability, each shown where its module is on and you can open it.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("email-deliverability").oldPath,
    help(
      "Email Deliverability",
      "Email Deliverability monitors SES feedback, bounces, complaints, suppressions, and reissue actions.",
      [
        "Review suppressions or failures before resending important emails.",
        "Clear suppressions only when the address problem has been corrected.",
        "Use reissue-token actions for failed membership or password flows when appropriate.",
      ],
      [
        {
          name: "Suppression",
          description:
            "An address-level SES block caused by bounce or complaint feedback.",
        },
        {
          name: "Failure",
          description:
            "An email send that did not complete or needs operator review.",
        },
        {
          name: "Reissue",
          description:
            "Creates a fresh email token or action link after a failure is resolved.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("background-jobs").oldPath,
    help(
      "Background Jobs",
      "Background Jobs shows scheduled work such as cron runs, retries, payment recovery, Xero sync, email retry, and maintenance tasks.",
      [
        "Check the latest run status, duration, and error text.",
        "Retry only idempotent jobs or jobs with explicit retry controls.",
        "Use job history to confirm whether a failure is new or recurring.",
      ],
      [
        {
          name: "Run status",
          description:
            "Whether the job succeeded, failed, is running, or was skipped.",
        },
        {
          name: "Started / finished",
          description:
            "Timestamps used to detect stale or overlapping runs.",
        },
        {
          name: "Error",
          description:
            "The failure message or provider response captured by the job.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("audit-log").oldPath,
    help(
      "Audit Log",
      "Audit Log records important admin, member, provider, and system actions for traceability.",
      [
        "Filter by actor, entity, category, severity, outcome, or date.",
        "Open metadata when you need before/after details for a change.",
        "Use audit evidence to reconstruct who changed what and why.",
      ],
      [
        {
          name: "Actor",
          description:
            "The member, system job, or provider event that performed the action.",
        },
        {
          name: "Entity",
          description:
            "The record type and id affected by the action.",
        },
        {
          name: "Metadata",
          description:
            "Structured context such as before/after values, provider IDs, or request information.",
        },
      ],
    ),
  ),
  entry(
    getAdminPage("deletion-requests").oldPath,
    help(
      "Deletion Requests",
      "Deletion Requests tracks member data deletion requests and operator follow-up.",
      [
        "Review the requester identity and any legal or operational blockers.",
        "Check linked bookings, payments, family records, and audit obligations before completion.",
        "Record decisions and completion notes for accountability.",
      ],
      [
        {
          name: "Requester",
          description:
            "The member or account that asked for deletion.",
        },
        {
          name: "Blockers",
          description:
            "Records that may need retention or resolution before deletion can proceed.",
        },
        {
          name: "Outcome",
          description:
            "The approved, rejected, completed, or deferred decision.",
        },
      ],
    ),
  ),
];
